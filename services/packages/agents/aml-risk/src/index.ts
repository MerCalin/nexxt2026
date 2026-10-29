import type { Finding } from "@dc/contracts";
import type { Agent, AgentContext } from "@dc/ports";
import { AML_BANDS, AML_WEIGHTS, firstFact, HIGH_RISK_THIRD_COUNTRIES, makeFinding, parseCnp } from "@dc/rules";

export type AmlFactor = { id: keyof typeof AML_WEIGHTS; weight: number; source: string; citations: string[]; detail: string };
export type AmlData = { score: number; band: "low" | "medium" | "high"; eddRequired: boolean; factors: AmlFactor[] };

/** EU/EEA states (ISO alpha-3): their citizens are not a geographical risk factor by nationality alone. */
const EEA = new Set("AUT BEL BGR HRV CYP CZE DNK EST FIN FRA DEU GRC HUN IRL ITA LVA LTU LUX MLT NLD POL PRT ROU SVK SVN ESP SWE ISL LIE NOR".split(" "));

/**
 * AML Risk Scoring agent (onboarding), Law 129/2019 art. 13–17 risk factors.
 * Sums fixed weights for each factor present; every factor cites its evidence.
 */
export function createAmlRiskAgent(): Agent {
  return {
    name: "aml-risk",
    async run(ctx: AgentContext) {
      const factors: AmlFactor[] = [];
      const add = (id: AmlFactor["id"], citations: string[], detail: string) =>
        factors.push({ id, weight: AML_WEIGHTS[id].value, source: AML_WEIGHTS[id].source, citations, detail });

      const pep = ctx.checks.find((c) => c.kind === "sanctions:pep" && c.status === "hit");
      if (pep) add("pep", [pep.id], "Persoană expusă public (potrivire listă PEP)");

      const sanctionHits = ctx.checks.filter((c) => c.kind.startsWith("sanctions:") && c.kind !== "sanctions:pep" && c.status === "hit");
      if (sanctionHits.length) add("sanctionsPossibleMatch", sanctionHits.map((c) => c.id), "Posibilă potrivire pe liste de sancțiuni");

      const nat = firstFact(ctx.facts, "mrzNationality");
      if (nat && HIGH_RISK_THIRD_COUNTRIES.value.includes(nat.value)) add("highRiskCountry", [nat.id], `Cetățenie într-o țară terță cu risc ridicat (${nat.value})`);

      const cnp = firstFact(ctx.facts, "cnp", ["id_card", "passport"]);
      if ((nat && !EEA.has(nat.value)) || (cnp && parseCnp(cnp.value).foreignResident))
        add("nonResident", [nat?.id, cnp?.id].filter((x): x is string => !!x), "Cetățean străin / rezident străin");

      const declared = ctx.case.subject.declaredSourceOfFunds;
      if (declared && /salar/i.test(declared)) {
        const evidence = ctx.facts.filter((f) => f.field === "salaryCredit" || (f.field === "docType" && (f.value === "employment_contract" || f.value === "payslip")));
        if (!evidence.length) {
          const set = firstFact(ctx.facts, "documentSet");
          if (set) add("sourceOfFundsNotEvidenced", [set.id], `Sursa declarată a fondurilor („${declared}”) nu este susținută de documente`);
        }
      }

      const fraud = ctx.findings.filter((f) => f.agent === "risk-fraud" && (f.severity === "high" || f.severity === "medium"));
      if (fraud.length) add("documentFraudSignal", fraud.flatMap((f) => f.citations), "Semnale de alterare a documentelor");

      const score = factors.reduce((a, f) => a + f.weight, 0);
      const band = score >= AML_BANDS.high ? "high" : score >= AML_BANDS.medium ? "medium" : "low";
      const eddRequired = band === "high" || !!pep || sanctionHits.length > 0;
      const data: AmlData = { score, band, eddRequired, factors };

      const findings: Finding[] = [];
      if (band !== "low")
        findings.push(
          makeFinding({
            agent: "aml-risk",
            code: band === "high" ? "AML_RISK_HIGH" : "AML_RISK_MEDIUM",
            severity: band === "high" ? "high" : "medium",
            message: `Risc AML ${band === "high" ? "ridicat" : "mediu"} (scor ${score}): ${factors.map((f) => f.detail).join("; ")}.${eddRequired ? " Necesită măsuri suplimentare de cunoaștere a clientelei (art. 17 Legea 129/2019)." : ""}`,
            citations: factors.flatMap((f) => f.citations),
            values: [String(score), band],
            visibility: "compliance",
          }),
        );
      return { status: "ok", findings, data };
    },
  };
}
