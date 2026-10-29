import type { Finding } from "@dc/contracts";
import type { Agent, AgentContext, KycStorePort } from "@dc/ports";
import { addMonths, compareAddresses, compareNames, firstFact, KYC_REFRESH_MONTHS, makeCheck, makeFinding } from "@dc/rules";

/**
 * KYC Freshness agent (loans): is the existing KYC file still valid, or must it be refreshed?
 * Law 129/2019 art. 13 para. (1)(d) — ongoing monitoring with risk-based refresh periods.
 */
export function createKycFreshnessAgent(deps: { kyc: KycStorePort }): Agent {
  return {
    name: "kyc-freshness",
    async run(ctx: AgentContext) {
      const res = await deps.kyc.get(ctx.case.subject.customerRef);
      const findings: Finding[] = [];
      const check = makeCheck({
        kind: "kyc-store",
        source: res.source,
        simulated: res.simulated,
        status: res.status === "ok" ? "ok" : "unavailable",
        reason: res.status === "ok" ? undefined : res.reason,
        payload: res.status === "ok" ? res.data : null,
        retrievedAt: res.retrievedAt,
      });
      const add = (code: string, severity: Finding["severity"], message: string, citations: string[], values: string[] = []) =>
        findings.push(makeFinding({ agent: "kyc-freshness", code, severity, message, citations: [check.id, ...citations], values, simulated: res.simulated }));

      if (res.status !== "ok") {
        add("KYC_STORE_UNAVAILABLE", "medium", `Dosarul KYC existent nu poate fi consultat (${res.reason}).`, []);
        return { status: "blocked", findings, checks: [check] };
      }
      const rec = res.data;
      if (!rec) {
        add("KYC_REFRESH_REQUIRED", "medium", "Clientul nu are un dosar KYC în evidența băncii; este necesară cunoașterea completă a clientelei.", [], ["no_file"]);
        return { status: "ok", findings, checks: [check], data: { fresh: false, reasons: ["no_file"] } };
      }

      const reasons: string[] = [];
      const months = KYC_REFRESH_MONTHS[rec.riskLevel].value;
      const due = addMonths(rec.lastReviewAt.slice(0, 10), months);
      if (due < ctx.now.toISOString().slice(0, 10)) {
        reasons.push("review_overdue");
        add("KYC_REFRESH_REQUIRED", "medium", `Ultima revizuire KYC (${rec.lastReviewAt.slice(0, 10)}) depășește perioada de ${months} luni pentru risc ${rec.riskLevel}; scadentă la ${due}.`, [], ["review_overdue", due]);
      }
      if (rec.idDocumentExpiry < ctx.now.toISOString().slice(0, 10)) {
        reasons.push("id_expired_on_file");
        const docNo = firstFact(ctx.facts, "documentNumber", ["id_card", "passport"]);
        add("KYC_REFRESH_REQUIRED", "low", `Actul de identitate din dosarul KYC (${rec.idDocumentNumber}) a expirat la ${rec.idDocumentExpiry}; dosarul trebuie actualizat${docNo ? ` cu documentul ${docNo.value}` : ""}.`, docNo ? [docNo.id] : [], ["id_expired_on_file"]);
      }
      const addr = firstFact(ctx.facts, "address", ["id_card"]) ?? firstFact(ctx.facts, "address");
      if (addr && compareAddresses(rec.address, addr.value) !== "same" && compareAddresses(rec.address, addr.value) !== "insufficient") {
        reasons.push("address_changed");
        add("KYC_REFRESH_REQUIRED", "low", `Adresa din dosarul KYC („${rec.address}”) diferă de adresa actuală („${addr.value}”).`, [addr.id], ["address_changed", rec.address, addr.value]);
      }
      const name = firstFact(ctx.facts, "fullName", ["id_card", "passport"]);
      if (name && ["near", "mismatch", "subset"].includes(compareNames(rec.fullName, name.value))) {
        reasons.push("name_changed");
        add("KYC_NAME_CHANGED", "medium", `Numele din dosarul KYC („${rec.fullName}”) diferă de cel din actul de identitate („${name.value}”).`, [name.id], [rec.fullName, name.value]);
      }
      const cnp = firstFact(ctx.facts, "cnp", ["id_card", "passport"]);
      if (cnp && cnp.normalized !== rec.cnp) add("KYC_CNP_MISMATCH", "high", "CNP-ul din actul de identitate nu corespunde cu cel din dosarul KYC.", [cnp.id]);

      return { status: "ok", findings, checks: [check], data: { fresh: reasons.length === 0, reasons, riskLevel: rec.riskLevel, dueAt: due } };
    },
  };
}
