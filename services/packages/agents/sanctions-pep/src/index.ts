import type { ExternalCheck, Finding } from "@dc/contracts";
import type { Agent, AgentContext, SanctionsListPort } from "@dc/ports";
import { factsOf, firstFact, IDENTITY_DOCS, makeCheck, makeFinding, parseCnp, SANCTIONS_LIST_MAX_AGE_HOURS } from "@dc/rules";

const LIST_LABEL: Record<string, string> = {
  eu: "UE (sancțiuni financiare)",
  un: "ONU (Consiliul de Securitate)",
  ofac: "OFAC SDN",
  onpcsb: "ONPCSB",
  pep: "PEP",
};

/**
 * Sanctions & PEP Screening agent (onboarding). Screens the identity-document name against
 * EU, UN, OFAC, ONPCSB and the PEP list. A list that is missing or stale BLOCKS the check.
 * All results are compliance-only (Law 129/2019 art. 38 — no tipping-off).
 */
export function createSanctionsPepAgent(deps: { lists: SanctionsListPort[] }): Agent {
  return {
    name: "sanctions-pep",
    async run(ctx: AgentContext) {
      const findings: Finding[] = [];
      const checks: ExternalCheck[] = [];
      const nameFact = firstFact(ctx.facts, "fullName", ["id_card"]) ?? firstFact(ctx.facts, "fullName", ["passport"]);
      const cnpFact = factsOf(ctx.facts, "cnp", IDENTITY_DOCS)[0];
      const birthDate = (cnpFact && parseCnp(cnpFact.value).birthDate) ?? firstFact(ctx.facts, "mrzBirthDate")?.normalized;
      const citizenship = firstFact(ctx.facts, "mrzNationality")?.value;

      if (!nameFact) {
        const set = firstFact(ctx.facts, "documentSet");
        const check = makeCheck({ kind: "sanctions:all", source: "screening", simulated: false, status: "blocked", reason: "Nu există nume din actul de identitate pentru screening", payload: null, retrievedAt: ctx.now.toISOString(), visibility: "compliance" });
        checks.push(check);
        findings.push(makeFinding({ agent: "sanctions-pep", code: "SANCTIONS_NO_SUBJECT", severity: "high", message: "Screeningul nu a putut fi efectuat: numele din actul de identitate lipsește.", citations: [check.id, ...(set ? [set.id] : [])], visibility: "compliance" }));
        return { status: "blocked", findings, checks };
      }

      let blocked = false;
      for (const list of deps.lists) {
        const status = await list.status();
        const ageH = status.fetchedAt ? (ctx.now.getTime() - new Date(status.fetchedAt).getTime()) / 3_600_000 : Infinity;
        const label = LIST_LABEL[list.listId] ?? list.listId;
        const base = { kind: `sanctions:${list.listId}`, source: label, simulated: status.simulated, retrievedAt: ctx.now.toISOString(), visibility: "compliance" as const };

        if (status.status !== "ok" || (!status.simulated && ageH > SANCTIONS_LIST_MAX_AGE_HOURS.value)) {
          blocked = true;
          const reason = status.status !== "ok" ? (status.reason ?? "indisponibilă") : `listă veche de ${Math.round(ageH)} ore`;
          const check = makeCheck({ ...base, status: "blocked", reason, payload: status });
          checks.push(check);
          findings.push(makeFinding({ agent: "sanctions-pep", code: "SANCTIONS_LIST_UNAVAILABLE", severity: "high", message: `Lista ${label} nu este disponibilă (${reason}); verificarea este blocată.`, citations: [check.id], values: [list.listId, reason], visibility: "compliance", simulated: status.simulated }));
          continue;
        }

        const matches = await list.search({ fullName: nameFact.value, birthDate, citizenship });
        const check = makeCheck({ ...base, status: matches.length ? "hit" : "ok", payload: { listVersion: status.version, fetchedAt: status.fetchedAt, query: { birthDate, citizenship }, matches } });
        checks.push(check);
        for (const m of matches)
          findings.push(
            makeFinding({
              agent: "sanctions-pep",
              code: list.listId === "pep" ? "PEP_MATCH" : "SANCTIONS_POSSIBLE_MATCH",
              severity: "high",
              message: `Posibilă potrivire pe lista ${label}: „${m.matchedName}” (scor ${m.score.toFixed(2)}${m.birthDates.length ? `, născut ${m.birthDates.join("/")}` : ""}${m.programme ? `, ${m.programme}` : ""}) pentru „${nameFact.value}”.`,
              citations: [nameFact.id, check.id, ...(cnpFact ? [cnpFact.id] : [])],
              values: [m.entryId, m.matchedName, m.score.toFixed(2)],
              visibility: "compliance",
              simulated: status.simulated,
            }),
          );
      }
      return { status: blocked ? "blocked" : "ok", findings, checks };
    },
  };
}
