import type { ConsentPurpose, ExternalCheck, Finding } from "@dc/contracts";
import type { Agent, AgentContext, AnafPort, CriminalRecordPort } from "@dc/ports";
import { factsOf, IDENTITY_DOCS, makeCheck, makeFinding } from "@dc/rules";

/** Shown to every non-compliance role whatever the criminal-record outcome, so the result cannot be inferred. */
export const NEUTRAL_CRIMINAL_RECORD_MESSAGE = "Verificare finalizată – contactați departamentul Conformitate.";

/**
 * Bank Verification agent (Phase 3, both workflows). Looks up the criminal record (cazier judiciar)
 * and ANAF tax debt DIRECTLY with the authorities — never from customer-uploaded certificates and
 * never by web crawling (GDPR Art. 10). Each lookup needs the customer's consent and the version of
 * the data-processing notice shown; a missing consent or unavailable source BLOCKS the check.
 */
export function createBankVerificationAgent(deps: { criminalRecord: CriminalRecordPort; anaf: AnafPort }): Agent {
  return {
    name: "bank-verification",
    async run(ctx: AgentContext) {
      const findings: Finding[] = [];
      const checks: ExternalCheck[] = [];
      const cnp = factsOf(ctx.facts, "cnp", IDENTITY_DOCS)[0];
      let blocked = false;

      const consentFor = (p: ConsentPurpose) => ctx.case.consents.find((c) => c.purpose === p && !c.withdrawnAt && c.noticeVersion);
      const block = (kind: string, source: string, reason: string, visibility: ExternalCheck["visibility"]) => {
        blocked = true;
        const check = makeCheck({ kind, source, simulated: false, status: "blocked", reason, payload: null, retrievedAt: ctx.now.toISOString(), visibility });
        checks.push(check);
        // the fact that a check is blocked is not sensitive: visible to all roles
        findings.push(makeFinding({ agent: "bank-verification", code: "BANKVER_BLOCKED", severity: "medium", message: `Verificarea ${source} este blocată: ${reason}.`, citations: [check.id], values: [kind, reason] }));
      };

      // ---- Criminal record (compliance only) ----
      const cazierConsent = consentFor("criminal_record_lookup");
      if (!cazierConsent) block("cazier", "cazier judiciar", "lipsește acordul clientului și nota de informare privind prelucrarea datelor", "compliance");
      else if (!cnp) block("cazier", "cazier judiciar", "CNP indisponibil din actul de identitate", "compliance");
      else {
        const res = await deps.criminalRecord.lookup(cnp.value, cazierConsent.id);
        if (res.status !== "ok") block("cazier", "cazier judiciar", `sursa nu este disponibilă (${res.reason})`, "compliance");
        else {
          const check = makeCheck({ kind: "cazier", source: res.source, simulated: res.simulated, status: res.data.hasRecord ? "hit" : "ok", payload: res.data, retrievedAt: res.retrievedAt, consentId: cazierConsent.id, visibility: "compliance" });
          checks.push(check);
          checks.push(makeCheck({ kind: "cazier", key: "shared", source: "cazier judiciar", simulated: res.simulated, status: "ok", payload: { message: NEUTRAL_CRIMINAL_RECORD_MESSAGE }, retrievedAt: res.retrievedAt, consentId: cazierConsent.id, visibility: "all" }));
          if (res.data.hasRecord)
            findings.push(
              makeFinding({
                agent: "bank-verification",
                code: "BANKVER_CRIMINAL_RECORD",
                severity: "high",
                message: `Cazierul judiciar conține ${res.data.entries.length} înscrieri: ${res.data.entries.map((e) => `${e.offence} (${e.date}${e.final ? ", definitivă" : ""})`).join("; ")}.`,
                citations: [check.id, cnp.id],
                values: [String(res.data.entries.length)],
                visibility: "compliance",
                simulated: res.simulated,
              }),
            );
        }
      }

      // ---- ANAF tax debt (credit / KYC roles) ----
      const anafConsent = consentFor("anaf_tax_debt_lookup");
      if (!anafConsent) block("anaf", "ANAF (datorii fiscale)", "lipsește acordul clientului și nota de informare privind prelucrarea datelor", "credit_kyc");
      else if (!cnp) block("anaf", "ANAF (datorii fiscale)", "CNP indisponibil din actul de identitate", "credit_kyc");
      else {
        const res = await deps.anaf.taxDebt(cnp.value, anafConsent.id);
        if (res.status !== "ok") block("anaf", "ANAF (datorii fiscale)", `sursa nu este disponibilă (${res.reason})`, "credit_kyc");
        else {
          const check = makeCheck({ kind: "anaf", source: res.source, simulated: res.simulated, status: res.data.hasDebt ? "hit" : "ok", payload: res.data, retrievedAt: res.retrievedAt, consentId: anafConsent.id, visibility: "credit_kyc" });
          checks.push(check);
          if (res.data.hasDebt)
            findings.push(makeFinding({ agent: "bank-verification", code: "BANKVER_TAX_DEBT", severity: "medium", message: `ANAF raportează datorii fiscale restante de ${res.data.amountRon} RON (la ${res.data.asOf}).`, citations: [check.id, cnp.id], values: [String(res.data.amountRon)], visibility: "credit_kyc", simulated: res.simulated }));
        }
      }
      return { status: blocked ? "blocked" : "ok", findings, checks };
    },
  };
}
