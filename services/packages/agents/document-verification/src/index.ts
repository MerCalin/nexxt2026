import type { Fact, Finding } from "@dc/contracts";
import type { Agent, AgentContext } from "@dc/ports";
import {
  compareNames,
  daysBetween,
  docTypeFact,
  isValidCui,
  isValidIban,
  MIN_OCR_CONFIDENCE,
  makeFinding,
  parseCnp,
  parseDate,
  RECENCY_DAYS,
} from "@dc/rules";

const KEY_FIELDS = new Set(["fullName", "cnp", "documentNumber", "expiryDate", "address", "salaryCredit", "grossSalary", "netSalary", "iban"]);
const EXPIRY_WARNING_DAYS = 30;

/** Document Verification agent: per-document authenticity and validity checks (deterministic). */
export function createDocumentVerificationAgent(): Agent {
  return {
    name: "document-verification",
    async run(ctx: AgentContext) {
      const findings: Finding[] = [];
      const chip: Record<string, "verified" | "mismatch" | "not_available"> = {};
      const add = (f: Parameters<typeof makeFinding>[0]) => findings.push(makeFinding(f));
      const byDoc = new Map<string, Fact[]>();
      for (const f of ctx.facts) byDoc.set(f.docId, [...(byDoc.get(f.docId) ?? []), f]);

      for (const doc of ctx.case.documents) {
        const facts = byDoc.get(doc.id) ?? [];
        const typeFact = docTypeFact(facts, doc.id);
        if (!typeFact) continue;
        const docType = typeFact.docType;
        const get = (field: string) => facts.find((f) => f.field === field);

        // ---- identity documents ----
        if (docType === "id_card" || docType === "passport") {
          const expiry = get("expiryDate") ?? get("mrzExpiryDate");
          const expIso = expiry && parseDate(expiry.normalized ?? expiry.value);
          if (!expiry || !expIso) {
            add({ agent: "document-verification", code: "DOCVER_EXPIRY_UNREADABLE", severity: "medium", message: "Data expirării actului de identitate nu a putut fi citită.", citations: [typeFact.id] });
          } else {
            const left = -daysBetween(expIso, ctx.now);
            if (left < 0)
              add({ agent: "document-verification", code: "DOCVER_EXPIRED", severity: "high", message: `Actul de identitate a expirat la ${expIso}.`, citations: [expiry.id], values: [expIso] });
            else if (left <= EXPIRY_WARNING_DAYS)
              add({ agent: "document-verification", code: "DOCVER_EXPIRING_SOON", severity: "low", message: `Actul de identitate expiră în ${left} zile (${expIso}).`, citations: [expiry.id], values: [expIso] });
          }

          const cnp = get("cnp");
          if (cnp) {
            const info = parseCnp(cnp.value);
            if (!info.valid)
              add({ agent: "document-verification", code: "DOCVER_CNP_INVALID", severity: "high", message: `CNP-ul de pe document nu este valid: ${info.errors.join("; ")}.`, citations: [cnp.id], values: [cnp.value] });
            const mrzBirth = get("mrzBirthDate");
            if (info.birthDate && mrzBirth && mrzBirth.value !== info.birthDate)
              add({ agent: "document-verification", code: "DOCVER_CNP_MRZ_BIRTHDATE", severity: "high", message: `Data nașterii din CNP (${info.birthDate}) diferă de cea din MRZ (${mrzBirth.value}).`, citations: [cnp.id, mrzBirth.id], values: [info.birthDate, mrzBirth.value] });
          } else if (docType === "id_card") {
            add({ agent: "document-verification", code: "DOCVER_CNP_MISSING", severity: "medium", message: "CNP-ul nu a putut fi citit de pe cartea de identitate.", citations: [typeFact.id] });
          }

          const mrzChecks = get("mrzChecks");
          if (!mrzChecks) {
            add({ agent: "document-verification", code: "DOCVER_MRZ_UNREADABLE", severity: "low", message: "Zona MRZ nu a putut fi citită; verificați vizual documentul.", citations: [typeFact.id] });
          } else {
            if (mrzChecks.value !== "ok")
              add({ agent: "document-verification", code: "DOCVER_MRZ_CHECK_FAILED", severity: "high", message: `Cifrele de control MRZ nu corespund (${mrzChecks.value.replace("failed:", "")}).`, citations: [mrzChecks.id], values: [mrzChecks.value] });
            // MRZ vs visual zone
            const pairs: [string, string, "name" | "eq"][] = [
              ["lastName", "mrzSurname", "name"],
              ["documentNumber", "mrzDocumentNumber", "eq"],
              ["expiryDate", "mrzExpiryDate", "eq"],
            ];
            for (const [vis, mz, kind] of pairs) {
              const a = get(vis);
              const b = get(mz);
              if (!a || !b) continue;
              const same = kind === "name" ? compareNames(a.value, b.value) === "exact" || compareNames(a.value, b.value) === "diacritics_only" : a.normalized.replace(/\W/g, "") === b.normalized.replace(/\W/g, "");
              if (!same)
                add({ agent: "document-verification", code: "DOCVER_MRZ_VISUAL_MISMATCH", severity: "high", message: `Zona vizuală (${a.value}) nu corespunde cu MRZ (${b.value}) pentru câmpul ${vis}.`, citations: [a.id, b.id], values: [a.value, b.value] });
            }
          }

          // chip / NFC read, when supplied by the staff app
          if (doc.chipRead) {
            const mismatched = Object.entries(doc.chipRead).filter(([k, v]) => {
              const f = get(k);
              return f && f.normalized !== v && f.value !== v;
            });
            chip[doc.id] = mismatched.length ? "mismatch" : "verified";
            if (mismatched.length)
              add({ agent: "document-verification", code: "DOCVER_CHIP_MISMATCH", severity: "high", message: `Datele din cip diferă de cele tipărite: ${mismatched.map(([k]) => k).join(", ")}.`, citations: mismatched.map(([k]) => get(k)!.id), values: mismatched.map(([, v]) => v) });
          } else chip[doc.id] = "not_available";
        }

        // ---- recency ----
        const recency = RECENCY_DAYS[docType];
        const dateFact = docType === "bank_statement" ? get("periodEnd") : docType === "valuation_report" ? get("valuationDate") : get("issueDate");
        if (recency) {
          const iso = dateFact && parseDate(dateFact.normalized);
          if (!iso) {
            add({ agent: "document-verification", code: "DOCVER_DATE_UNREADABLE", severity: "low", message: `Data documentului „${doc.fileName}” nu a putut fi citită; vechimea nu poate fi verificată.`, citations: [typeFact.id] });
          } else {
            const age = daysBetween(iso, ctx.now);
            if (age > recency.value)
              add({ agent: "document-verification", code: "DOCVER_STALE", severity: "medium", message: `Documentul „${doc.fileName}” are ${age} zile (maximum ${recency.value}).`, citations: [dateFact!.id], values: [iso, String(recency.value)] });
            if (age < -1)
              add({ agent: "document-verification", code: "DOCVER_FUTURE_DATE", severity: "high", message: `Documentul „${doc.fileName}” poartă o dată din viitor (${iso}).`, citations: [dateFact!.id], values: [iso] });
          }
        }

        // ---- format checks ----
        const cui = get("employerCui");
        if (cui && !isValidCui(cui.normalized))
          add({ agent: "document-verification", code: "DOCVER_CUI_INVALID", severity: "medium", message: `Codul fiscal al angajatorului (${cui.value}) nu trece verificarea cifrei de control.`, citations: [cui.id], values: [cui.value] });
        const iban = get("iban");
        if (iban && !isValidIban(iban.normalized))
          add({ agent: "document-verification", code: "DOCVER_IBAN_INVALID", severity: "medium", message: `IBAN-ul ${iban.value} nu este valid.`, citations: [iban.id], values: [iban.value] });
        const endDate = get("endDate");
        const endIso = endDate && parseDate(endDate.normalized);
        if (docType === "employment_contract" && endIso && daysBetween(endIso, ctx.now) > 0)
          add({ agent: "document-verification", code: "DOCVER_CONTRACT_ENDED", severity: "medium", message: `Contractul de muncă pe durată determinată a expirat la ${endIso}.`, citations: [endDate!.id], values: [endIso] });
        if (docType === "valuation_report" && !get("valuerAnevarId"))
          add({ agent: "document-verification", code: "DOCVER_NO_ANEVAR", severity: "medium", message: "Raportul de evaluare nu indică legitimația ANEVAR a evaluatorului.", citations: [typeFact.id] });

        // ---- OCR confidence floor on key fields ----
        const weak = facts.filter((f) => KEY_FIELDS.has(f.field) && f.ocrConfidence > 0 && f.ocrConfidence < MIN_OCR_CONFIDENCE.value);
        if (weak.length)
          add({ agent: "document-verification", code: "DOCVER_LOW_CONFIDENCE", severity: "low", message: `Câmpuri citite cu încredere scăzută în „${doc.fileName}”: ${weak.map((f) => f.field).join(", ")}.`, citations: weak.map((f) => f.id), values: weak.map((f) => f.ocrConfidence.toFixed(0)) });
      }

      return { status: "ok", findings, data: { chip } };
    },
  };
}
