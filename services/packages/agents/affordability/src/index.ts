import type { Fact, Finding } from "@dc/contracts";
import type { Agent, AgentContext } from "@dc/ports";
import { annuityInstalment, DTI_LIMITS, factsOf, makeFact, makeFinding, NET_TO_GROSS_RATIO, round2 } from "@dc/rules";

export type AffordabilityData = {
  netMonthlyIncomeRon: number;
  incomeBasis: "statement_salary_credits" | "payslip_net" | "contract_gross_estimate";
  existingInstalmentsRon: number;
  newInstalment: number;
  dti: number;
  limit: number;
  limitSource: string;
  limitConfirmedByCompliance: boolean;
  formula: string;
};

/**
 * Affordability agent (loans): deterministic debt-to-income per BNR Reg. 17/2012.
 * DTI = (existing instalments + new instalment) / net monthly income evidenced by documents.
 */
export function createAffordabilityAgent(): Agent {
  return {
    name: "affordability",
    async run(ctx: AgentContext) {
      const findings: Finding[] = [];
      const facts: Fact[] = [];
      const loan = ctx.case.subject.loan;
      const add = (code: string, severity: Finding["severity"], message: string, citations: string[], values: string[] = []) =>
        findings.push(makeFinding({ agent: "affordability", code, severity, message, citations, values, visibility: "credit_kyc" }));

      const loanFact = makeFact({
        docId: "case",
        docType: "unknown",
        field: "loanRequest",
        value: loan ? `${loan.amount} ${loan.currency} / ${loan.termMonths} luni / ${loan.annualRatePct}%` : "(lipsă)",
        normalized: JSON.stringify(loan ?? null),
        page: 1,
        ocrConfidence: 100,
        extractor: "application-form",
      });
      facts.push(loanFact);
      if (!loan) {
        add("AFFORD_NO_LOAN_PARAMS", "medium", "Parametrii creditului solicitat (sumă, termen, dobândă) lipsesc din cerere.", [loanFact.id]);
        return { status: "blocked", findings, facts };
      }

      // Income: prefer evidenced salary credits, then payslip net, then an estimate from contract gross
      const credits = factsOf(ctx.facts, "salaryCredit", ["bank_statement"]);
      const payslip = factsOf(ctx.facts, "netSalary", ["payslip"])[0];
      const gross = factsOf(ctx.facts, "grossSalary", ["employment_contract"])[0];
      let income: number;
      let basis: AffordabilityData["incomeBasis"];
      let incomeCites: string[];
      if (credits.length) {
        income = credits.reduce((a, f) => a + Number(f.normalized), 0) / credits.length;
        basis = "statement_salary_credits";
        incomeCites = credits.map((f) => f.id);
      } else if (payslip) {
        income = Number(payslip.normalized);
        basis = "payslip_net";
        incomeCites = [payslip.id];
      } else if (gross) {
        income = Number(gross.normalized) * NET_TO_GROSS_RATIO.value;
        basis = "contract_gross_estimate";
        incomeCites = [gross.id];
        add("AFFORD_INCOME_ESTIMATED", "medium", `Venitul net a fost estimat din salariul brut din contract (${gross.normalized} RON × ${NET_TO_GROSS_RATIO.value}); nu există încasări salariale dovedite.`, [gross.id]);
      } else {
        add("AFFORD_NO_INCOME", "high", "Nu există dovezi de venit pentru calculul gradului de îndatorare.", [loanFact.id]);
        return { status: "blocked", findings, facts };
      }

      const credit = ctx.results["credit-history"];
      const creditData = credit?.data as { existingMonthlyInstalmentsRon?: number } | undefined;
      const creditChecks = (credit?.checks ?? []).filter((c) => c.status === "ok").map((c) => c.id);
      if (!credit || credit.status !== "ok") {
        add("AFFORD_INCOMPLETE", "medium", "Istoricul de credit nu este disponibil; gradul de îndatorare exclude datoriile existente și nu este final.", [loanFact.id, ...incomeCites]);
      }
      const existing = creditData?.existingMonthlyInstalmentsRon ?? 0;

      const newInstalment = annuityInstalment(loan.amount, loan.annualRatePct, loan.termMonths);
      const dti = (existing + newInstalment) / income;
      const fx = loan.currency !== "RON";
      const firstHome = ctx.case.workflow === "mortgage" && !!ctx.case.subject.isFirstHome;
      const base = fx ? DTI_LIMITS.foreignCurrency : DTI_LIMITS.localCurrency;
      const limit = base.value + (firstHome ? DTI_LIMITS.firstHomeUplift.value : 0);
      const data: AffordabilityData = {
        netMonthlyIncomeRon: round2(income),
        incomeBasis: basis,
        existingInstalmentsRon: existing,
        newInstalment: round2(newInstalment),
        dti: round2(dti),
        limit,
        limitSource: base.source + (firstHome ? ` + ${DTI_LIMITS.firstHomeUplift.source}` : ""),
        limitConfirmedByCompliance: base.confirmedByCompliance,
        formula: `(${existing} + ${round2(newInstalment)}) / ${round2(income)} = ${(dti * 100).toFixed(1)}% (limită ${(limit * 100).toFixed(0)}%)`,
      };
      const cites = [loanFact.id, ...incomeCites, ...creditChecks];
      if (dti > limit)
        add("AFFORD_DTI_EXCEEDED", "high", `Gradul de îndatorare ${(dti * 100).toFixed(1)}% depășește limita BNR de ${(limit * 100).toFixed(0)}%: ${data.formula}.`, cites, [String(data.dti), String(limit)]);
      else if (dti > limit - 0.05)
        add("AFFORD_DTI_NEAR_LIMIT", "low", `Gradul de îndatorare ${(dti * 100).toFixed(1)}% este aproape de limita de ${(limit * 100).toFixed(0)}%: ${data.formula}.`, cites, [String(data.dti), String(limit)]);
      return { status: "ok", findings, facts, data };
    },
  };
}
