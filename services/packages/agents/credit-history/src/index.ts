import type { ExternalCheck, Finding } from "@dc/contracts";
import type { Agent, AgentContext, CentralCreditRegisterPort, CreditBureauPort, CreditRecord } from "@dc/ports";
import { factsOf, firstFact, IDENTITY_DOCS, makeCheck, makeFinding, nameMatchScore, round2 } from "@dc/rules";

export type CreditHistoryData = {
  records: (CreditRecord & { sources: string[] })[];
  existingMonthlyInstalmentsRon: number;
  activeDebts: number;
  insolvency: boolean;
};

const ACTIVE = (r: CreditRecord) => r.status === "current" || r.status === "overdue";
const key = (r: CreditRecord) => `${r.lender.toUpperCase()}|${r.product}|${r.openedAt.slice(0, 7)}`;

/**
 * Credit History agent (loans). Reads the Credit Bureau (Biroul de Credit) and the Central Credit
 * Register (CRC, BNR) and compares them with the customer's debt declaration.
 * Consultation requires the customer's consent (purpose credit_bureau_lookup); without it the check is BLOCKED.
 */
export function createCreditHistoryAgent(deps: { bureau: CreditBureauPort; ccr: CentralCreditRegisterPort }): Agent {
  return {
    name: "credit-history",
    async run(ctx: AgentContext) {
      const findings: Finding[] = [];
      const checks: ExternalCheck[] = [];
      const consent = ctx.case.consents.find((c) => c.purpose === "credit_bureau_lookup" && !c.withdrawnAt);
      const cnp = factsOf(ctx.facts, "cnp", IDENTITY_DOCS)[0];

      if (!consent || !cnp) {
        const reason = !consent ? "Lipsește acordul clientului pentru consultarea Biroului de Credit / CRC" : "CNP indisponibil din actul de identitate";
        const check = makeCheck({ kind: "credit", source: "Biroul de Credit / CRC", simulated: false, status: "blocked", reason, payload: null, retrievedAt: ctx.now.toISOString() });
        findings.push(makeFinding({ agent: "credit-history", code: "CREDIT_CHECK_BLOCKED", severity: "medium", message: `Verificarea istoricului de credit este blocată: ${reason}.`, citations: [check.id] }));
        return { status: "blocked", findings, checks: [check] };
      }

      const [bureau, ccr] = await Promise.all([deps.bureau.report(cnp.value, consent.id), deps.ccr.report(cnp.value, consent.id)]);
      const merged = new Map<string, CreditRecord & { sources: string[] }>();
      let blocked = false;
      let insolvency = false;
      for (const [kind, res] of [["credit:bureau", bureau], ["credit:crc", ccr]] as const) {
        const check = makeCheck({
          kind,
          source: res.source,
          simulated: res.simulated,
          status: res.status === "ok" ? "ok" : "unavailable",
          reason: res.status === "ok" ? undefined : res.reason,
          payload: res.status === "ok" ? res.data : null,
          retrievedAt: res.retrievedAt,
          consentId: consent.id,
          visibility: "credit_kyc",
        });
        checks.push(check);
        if (res.status !== "ok") {
          blocked = true;
          findings.push(makeFinding({ agent: "credit-history", code: "CREDIT_SOURCE_UNAVAILABLE", severity: "medium", message: `${res.source} nu a putut fi consultat (${res.reason}).`, citations: [check.id], simulated: res.simulated }));
          continue;
        }
        insolvency ||= res.data.insolvency;
        for (const r of res.data.records) {
          const k = key(r);
          const prev = merged.get(k);
          if (prev) prev.sources.push(check.id);
          else merged.set(k, { ...r, sources: [check.id] });
        }
      }
      const simulated = checks.some((c) => c.simulated);
      const add = (code: string, severity: Finding["severity"], message: string, citations: string[], values: string[] = []) =>
        findings.push(makeFinding({ agent: "credit-history", code, severity, message, citations, values, visibility: "credit_kyc", simulated }));

      const records = [...merged.values()];
      const okChecks = checks.filter((c) => c.status === "ok").map((c) => c.id);
      if (insolvency) add("CREDIT_INSOLVENCY", "high", "Clientul figurează cu procedură de insolvență a persoanei fizice (Legea 151/2015).", okChecks);

      for (const r of records) {
        const desc = `${r.product} la ${r.lender} (sold ${r.outstanding} ${r.currency}, rată ${r.monthlyInstalment} ${r.currency})`;
        if (r.status === "written_off") add("CREDIT_WRITTEN_OFF", "high", `Credit trecut pe pierdere: ${desc}.`, r.sources, [r.lender]);
        else if (r.status === "overdue" && r.daysPastDue > 30) add("CREDIT_OVERDUE", "high", `Restanță de ${r.daysPastDue} zile: ${desc}.`, r.sources, [r.lender, String(r.daysPastDue)]);
        else if (r.status === "overdue") add("CREDIT_OVERDUE", "medium", `Restanță de ${r.daysPastDue} zile: ${desc}.`, r.sources, [r.lender, String(r.daysPastDue)]);
        if (r.role === "guarantor" && ACTIVE(r)) add("CREDIT_GUARANTEE", "low", `Clientul este garant pentru ${desc}.`, r.sources, [r.lender]);
      }

      // Debts not declared by the customer
      const declaredDoc = firstFact(ctx.facts, "docType", ["debt_declaration"]);
      if (declaredDoc) {
        const declared = factsOf(ctx.facts, "declaredDebt");
        const noDebts = firstFact(ctx.facts, "declaresNoDebts");
        for (const r of records.filter((x) => ACTIVE(x) && x.role !== "guarantor")) {
          const hit = declared.find((d) => nameMatchScore(r.lender, d.value.split("|")[0] ?? "") >= 0.85);
          if (!hit)
            add(
              "CREDIT_UNDECLARED_DEBT",
              noDebts ? "high" : "medium",
              `Datoria ${r.product} la ${r.lender} (rată ${r.monthlyInstalment} ${r.currency}) nu apare în declarația clientului${noDebts ? `, care afirmă „${noDebts.value}”` : ""}.`,
              [...r.sources, noDebts?.id ?? declaredDoc.id],
              [r.lender, String(r.monthlyInstalment)],
            );
        }
      }

      const active = records.filter((r) => ACTIVE(r) && r.role !== "guarantor");
      const data: CreditHistoryData = {
        records,
        existingMonthlyInstalmentsRon: round2(active.filter((r) => r.currency === "RON").reduce((a, r) => a + r.monthlyInstalment, 0)),
        activeDebts: active.length,
        insolvency,
      };
      if (active.some((r) => r.currency !== "RON"))
        add("CREDIT_FX_DEBT", "low", "Clientul are datorii în valută; rata a fost exclusă din totalul în RON și trebuie convertită manual.", active.filter((r) => r.currency !== "RON").flatMap((r) => r.sources));
      return { status: blocked ? "blocked" : "ok", findings, checks, data };
    },
  };
}
