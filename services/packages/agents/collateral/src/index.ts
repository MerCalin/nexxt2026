import type { ExternalCheck, Finding } from "@dc/contracts";
import type { Agent, AgentContext, LandRegisterPort } from "@dc/ports";
import { compareNames, factsOf, firstFact, IDENTITY_DOCS, LTV_LIMITS, makeCheck, makeFinding, parseCurrency, round2 } from "@dc/rules";

/**
 * Collateral agent (mortgage): land-register extract and valuation report checks, the registry
 * lookup (ANCPI) and the LTV limit per BNR Reg. 17/2012.
 */
export function createCollateralAgent(deps: { landRegister: LandRegisterPort }): Agent {
  return {
    name: "collateral",
    async run(ctx: AgentContext) {
      const findings: Finding[] = [];
      const checks: ExternalCheck[] = [];
      const add = (code: string, severity: Finding["severity"], message: string, citations: string[], values: string[] = [], simulated = false) =>
        findings.push(makeFinding({ agent: "collateral", code, severity, message, citations, values, visibility: "credit_kyc", simulated }));

      const cfCad = firstFact(ctx.facts, "cadastralNumber", ["land_register_extract"]);
      const valCad = firstFact(ctx.facts, "cadastralNumber", ["valuation_report"]);
      if (cfCad && valCad && cfCad.normalized.replace(/\D/g, "") !== valCad.normalized.replace(/\D/g, ""))
        add("COLL_CADASTRAL_MISMATCH", "high", `Numărul cadastral din extrasul CF (${cfCad.value}) diferă de cel din raportul de evaluare (${valCad.value}).`, [cfCad.id, valCad.id], [cfCad.value, valCad.value]);

      // Owner: for a purchase the owner is the seller; otherwise it must be the applicant.
      const owners = factsOf(ctx.facts, "owner", ["land_register_extract"]);
      const applicant = factsOf(ctx.facts, "fullName", IDENTITY_DOCS)[0];
      const purchase = !!ctx.case.subject.loan?.purchasePrice;
      if (!purchase && applicant && owners.length && !owners.some((o) => ["exact", "diacritics_only", "token_reorder", "subset"].includes(compareNames(applicant.value, stripOwnerLine(o.value)))))
        add("COLL_OWNER_MISMATCH", "high", `Solicitantul („${applicant.value}”) nu figurează ca proprietar în extrasul CF (${owners.map((o) => o.value).join("; ")}).`, [applicant.id, ...owners.map((o) => o.id)]);

      for (const e of factsOf(ctx.facts, "encumbrance", ["land_register_extract"])) {
        const severe = /SECHESTRU|URMARIRE|INTERDICTIE/i.test(e.normalized);
        add(severe ? "COLL_SEIZURE" : "COLL_ENCUMBRANCE", severe ? "high" : "medium", `Sarcină înscrisă în partea a III-a a CF: „${e.value}”.`, [e.id], [e.value]);
      }

      // Registry lookup (ANCPI) — compares the uploaded extract with the register itself
      if (cfCad) {
        const res = await deps.landRegister.lookup(cfCad.normalized.replace(/\s/g, ""));
        const check = makeCheck({ kind: "land-register", source: res.source, simulated: res.simulated, status: res.status === "ok" ? "ok" : "unavailable", reason: res.status === "ok" ? undefined : res.reason, payload: res.status === "ok" ? res.data : null, retrievedAt: res.retrievedAt, visibility: "credit_kyc" });
        checks.push(check);
        if (res.status !== "ok") add("COLL_REGISTRY_UNAVAILABLE", "medium", `Registrul ANCPI nu a putut fi consultat (${res.reason}).`, [check.id], [], res.simulated);
        else {
          const extractOwners = owners.map((o) => stripOwnerLine(o.value));
          const missing = res.data.owners.filter((ro) => !extractOwners.some((eo) => compareNames(ro.name, eo) !== "mismatch"));
          if (missing.length)
            add("COLL_EXTRACT_REGISTRY_MISMATCH", "high", `Proprietarii din registrul ANCPI (${res.data.owners.map((o) => o.name).join(", ")}) nu corespund extrasului încărcat.`, [check.id, ...owners.map((o) => o.id)], missing.map((m) => m.name), res.simulated);
          const extractEnc = factsOf(ctx.facts, "encumbrance");
          if (res.data.encumbrances.length > extractEnc.length)
            add("COLL_EXTRACT_REGISTRY_MISMATCH", "high", `Registrul ANCPI indică ${res.data.encumbrances.length} sarcini, extrasul încărcat ${extractEnc.length}.`, [check.id, cfCad.id], [String(res.data.encumbrances.length)], res.simulated);
        }
      } else if (firstFact(ctx.facts, "docType", ["land_register_extract"])) {
        add("COLL_NO_CADASTRAL", "medium", "Numărul cadastral nu a putut fi citit din extrasul CF.", [firstFact(ctx.facts, "docType", ["land_register_extract"])!.id]);
      }

      // LTV
      const loan = ctx.case.subject.loan;
      const mv = firstFact(ctx.facts, "marketValue", ["valuation_report"]);
      const mvCcy = firstFact(ctx.facts, "marketValueCurrency", ["valuation_report"]);
      const valuationCurrency = (mvCcy && parseCurrency(mvCcy.value)) ?? "RON";
      let ltvData: Record<string, unknown> | undefined;
      if (loan && mv) {
        if (valuationCurrency !== loan.currency) {
          add("COLL_CURRENCY_MISMATCH", "medium", `Valoarea de piață este în ${valuationCurrency}, creditul în ${loan.currency}; LTV necesită conversie manuală la cursul BNR.`, [mv.id, ...(mvCcy ? [mvCcy.id] : [])]);
        } else {
          const base = Math.min(Number(mv.normalized), loan.purchasePrice ?? Number.POSITIVE_INFINITY);
          const ltv = loan.amount / base;
          const limit = (LTV_LIMITS[loan.currency] ?? LTV_LIMITS.OTHER!).value;
          ltvData = { ltv: round2(ltv), limit, base, basis: loan.purchasePrice && loan.purchasePrice < Number(mv.normalized) ? "purchase_price" : "market_value" };
          if (ltv > limit)
            add("COLL_LTV_EXCEEDED", "high", `LTV ${(ltv * 100).toFixed(1)}% depășește limita de ${(limit * 100).toFixed(0)}% (credit ${loan.amount} ${loan.currency} / garanție ${base} ${loan.currency}).`, [mv.id], [String(round2(ltv)), String(limit)]);
        }
      }
      return { status: "ok", findings, checks, data: { ltv: ltvData, purchase } };
    },
  };
}

/** "1. POPESCU ION, proprietar, cota 1/1" → "POPESCU ION" */
const stripOwnerLine = (s: string) =>
  s
    .replace(/^\s*[\d.)]+\s*/, "")
    .split(/,|\bproprietar|\bcota/i)[0]!
    .trim();
