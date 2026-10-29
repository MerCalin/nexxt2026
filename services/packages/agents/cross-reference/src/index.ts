import type { DocType, Fact, Finding } from "@dc/contracts";
import type { Agent, AgentContext } from "@dc/ports";
import {
  compareAddresses,
  compareNames,
  factsOf,
  IDENTITY_DOCS,
  INCOME_TOLERANCE,
  jaroWinkler,
  makeFinding,
  NAME_COMPARISON_SEVERITY,
  NET_TO_GROSS_RATIO,
  normalizeName,
  parseCnp,
  round2,
} from "@dc/rules";

const DOC_LABEL: Partial<Record<DocType, string>> = {
  id_card: "cartea de identitate",
  passport: "pașaport",
  domicile_certificate: "certificatul de domiciliu",
  utility_bill_water: "factura de apă",
  utility_bill_electricity: "factura de energie electrică",
  notary_contract: "contractul notarial",
  bank_statement: "extrasul de cont",
  employment_contract: "contractul de muncă",
  payslip: "fluturașul de salariu",
  debt_declaration: "declarația de datorii",
  land_register_extract: "extrasul de carte funciară",
  valuation_report: "raportul de evaluare",
};
const label = (f: Fact) => DOC_LABEL[f.docType] ?? f.docType;

/** Prefer the ID card, then the passport, as the anchor for identity facts. */
const anchorOf = (facts: Fact[]) =>
  facts.find((f) => f.docType === "id_card") ?? facts.find((f) => f.docType === "passport") ?? facts[0];

/**
 * Cross-Reference agent: deterministic comparison of the same fact across documents.
 * Every mismatch is a typed finding citing both facts.
 */
export function createCrossReferenceAgent(): Agent {
  return {
    name: "cross-reference",
    async run(ctx: AgentContext) {
      const findings: Finding[] = [];
      const add = (f: Omit<Parameters<typeof makeFinding>[0], "agent">) => findings.push(makeFinding({ agent: "cross-reference", ...f }));
      const facts = ctx.facts as Fact[];
      const comparisons: { field: string; a: string; b: string; result: string }[] = [];

      // ---- Name ----
      const names = factsOf(facts, "fullName");
      const nameAnchor = anchorOf(names.filter((f) => IDENTITY_DOCS.includes(f.docType))) ?? anchorOf(names);
      if (nameAnchor)
        for (const other of names.filter((f) => f.docId !== nameAnchor.docId)) {
          const result = compareNames(nameAnchor.value, other.value);
          comparisons.push({ field: "fullName", a: nameAnchor.id, b: other.id, result });
          if (result === "exact") continue;
          // Diacritic-only differences are reported as information: Textract may drop Romanian diacritics.
          const sev = NAME_COMPARISON_SEVERITY[result];
          add({
            code: result === "diacritics_only" ? "XREF_NAME_DIACRITICS" : result === "mismatch" ? "XREF_NAME_MISMATCH" : "XREF_NAME_VARIANT",
            severity: sev,
            message: `Numele din ${label(nameAnchor)} („${nameAnchor.value}”) diferă de cel din ${label(other)} („${other.value}”): ${describeName(result)}.`,
            citations: [nameAnchor.id, other.id],
            values: [nameAnchor.value, other.value, result],
          });
        }

      // ---- CNP ----
      const cnps = factsOf(facts, "cnp");
      const cnpAnchor = anchorOf(cnps.filter((f) => IDENTITY_DOCS.includes(f.docType))) ?? anchorOf(cnps);
      if (cnpAnchor)
        for (const other of cnps.filter((f) => f.docId !== cnpAnchor.docId)) {
          const same = other.normalized === cnpAnchor.normalized;
          comparisons.push({ field: "cnp", a: cnpAnchor.id, b: other.id, result: same ? "exact" : "mismatch" });
          if (!same)
            add({
              code: "XREF_CNP_MISMATCH",
              severity: "high",
              message: `CNP-ul din ${label(cnpAnchor)} (${cnpAnchor.value}) diferă de cel din ${label(other)} (${other.value}).`,
              citations: [cnpAnchor.id, other.id],
              values: [cnpAnchor.value, other.value],
            });
        }

      // ---- Birth date vs CNP ----
      if (cnpAnchor) {
        const fromCnp = parseCnp(cnpAnchor.value).birthDate;
        for (const b of factsOf(facts, "birthDate"))
          if (fromCnp && b.normalized !== fromCnp)
            add({
              code: "XREF_BIRTHDATE_CNP",
              severity: "high",
              message: `Data nașterii din ${label(b)} (${b.normalized}) nu corespunde cu CNP-ul (${fromCnp}).`,
              citations: [cnpAnchor.id, b.id],
              values: [b.normalized, fromCnp],
            });
      }

      // ---- Address ----
      const addresses = factsOf(facts, "address");
      const addrAnchor =
        addresses.find((f) => f.docType === "id_card") ??
        addresses.find((f) => ["domicile_certificate", "notary_contract", "utility_bill_water", "utility_bill_electricity"].includes(f.docType)) ??
        addresses[0];
      if (addrAnchor)
        for (const other of addresses.filter((f) => f.docId !== addrAnchor.docId)) {
          const result = compareAddresses(addrAnchor.value, other.value);
          comparisons.push({ field: "address", a: addrAnchor.id, b: other.id, result });
          if (result === "same") continue;
          const severity = result === "insufficient" ? "info" : result === "same_building" ? "low" : "medium";
          add({
            code: result === "insufficient" ? "XREF_ADDRESS_UNPARSED" : "XREF_ADDRESS_MISMATCH",
            severity,
            message:
              result === "insufficient"
                ? `Adresele din ${label(addrAnchor)} și ${label(other)} nu au putut fi comparate automat.`
                : `Adresa din ${label(addrAnchor)} („${addrAnchor.value}”) diferă de cea din ${label(other)} („${other.value}”) (${describeAddress(result)}).`,
            citations: [addrAnchor.id, other.id],
            values: [addrAnchor.value, other.value, result],
          });
        }

      // ---- Employer ----
      const employers = factsOf(facts, "employer");
      const contractEmployer = employers.find((f) => f.docType === "employment_contract");
      if (contractEmployer) {
        for (const other of employers.filter((f) => f.docId !== contractEmployer.docId))
          if (!sameCompany(contractEmployer.value, other.value))
            add({
              code: "XREF_EMPLOYER_MISMATCH",
              severity: "medium",
              message: `Angajatorul din contract („${contractEmployer.value}”) diferă de cel din ${label(other)} („${other.value}”).`,
              citations: [contractEmployer.id, other.id],
              values: [contractEmployer.value, other.value],
            });
        const payers = factsOf(facts, "salaryPayer");
        if (payers.length && !payers.some((p) => companyMentioned(contractEmployer.value, p.value)))
          add({
            code: "XREF_SALARY_PAYER_UNKNOWN",
            severity: "medium",
            message: `Încasările salariale din extras nu menționează angajatorul din contract („${contractEmployer.value}”).`,
            citations: [contractEmployer.id, ...payers.map((p) => p.id)],
            values: [contractEmployer.value],
          });
      }

      // ---- Income ----
      const credits = factsOf(facts, "salaryCredit", ["bank_statement"]);
      const avgCredit = credits.length ? credits.reduce((a, f) => a + Number(f.normalized), 0) / credits.length : undefined;
      const gross = factsOf(facts, "grossSalary", ["employment_contract"])[0];
      const net = factsOf(facts, "netSalary", ["payslip"])[0];
      const tol = INCOME_TOLERANCE.value;
      if (avgCredit !== undefined && net) {
        const n = Number(net.normalized);
        if (Number.isFinite(n) && Math.abs(avgCredit - n) / n > tol)
          add({
            code: "XREF_INCOME_MISMATCH",
            severity: "medium",
            message: `Salariul net din fluturaș (${n} RON) diferă cu peste ${tol * 100}% de media încasărilor salariale din extras (${round2(avgCredit)} RON).`,
            citations: [net.id, ...credits.map((c) => c.id)],
            values: [String(n), String(round2(avgCredit))],
          });
      } else if (avgCredit !== undefined && gross) {
        const g = Number(gross.normalized);
        const expectedNet = g * NET_TO_GROSS_RATIO.value;
        // personal deduction makes net slightly higher than the ratio, so only flag shortfalls or large excess
        if (Number.isFinite(g) && (avgCredit < expectedNet * (1 - tol) || avgCredit > expectedNet * (1 + 2 * tol)))
          add({
            code: "XREF_INCOME_MISMATCH",
            severity: "medium",
            message: `Media încasărilor salariale din extras (${round2(avgCredit)} RON) nu corespunde salariului brut din contract (${g} RON; net estimat ≈ ${round2(expectedNet)} RON).`,
            citations: [gross.id, ...credits.map((c) => c.id)],
            values: [String(g), String(round2(expectedNet)), String(round2(avgCredit))],
          });
      }
      if (ctx.case.workflow !== "onboarding" && factsOf(facts, "docType", ["bank_statement"]).length && !credits.length) {
        const st = factsOf(facts, "docType", ["bank_statement"])[0]!;
        add({
          code: "XREF_NO_SALARY_CREDITS",
          severity: "medium",
          message: "Extrasul de cont nu conține încasări salariale identificabile.",
          citations: [st.id],
        });
      }

      return { status: "ok", findings, data: { comparisons, averageSalaryCredit: avgCredit && round2(avgCredit) } };
    },
  };
}

function describeName(r: string) {
  return (
    { diacritics_only: "diferă doar diacriticele", token_reorder: "ordinea numelor diferă", subset: "un prenume lipsește", near: "variantă apropiată de scriere", mismatch: "nume diferit" } as Record<string, string>
  )[r]!;
}

function describeAddress(r: string) {
  return ({ same_building: "același imobil, alt apartament", same_street: "aceeași stradă, alt număr", different: "adresă diferită" } as Record<string, string>)[r] ?? r;
}

const COMPANY_FORMS = /\b(S ?R ?L|S ?A|SRL D|S ?C ?S|S ?N ?C|PFA|II|IF|SC|ROMANIA|COMPANY|GROUP)\b/g;
const companyCore = (s: string) => normalizeName(s).replace(COMPANY_FORMS, "").replace(/\s+/g, " ").trim();

export function sameCompany(a: string, b: string) {
  const x = companyCore(a);
  const y = companyCore(b);
  return x === y || jaroWinkler(x, y) >= 0.93 || (x.length > 4 && (x.includes(y) || y.includes(x)));
}

export const companyMentioned = (company: string, text: string) => {
  const core = companyCore(company);
  return core.length > 2 && normalizeName(text).includes(core);
};
