import type { AgentResult, ExternalCheck, Finding, Role, Run, Visibility } from "@dc/contracts";

/** compliance sees everything; credit/KYC officers see "all" + "credit_kyc"; nothing compliance-only leaves the service for them. */
export const canSee = (role: Role, v: Visibility) => role === "compliance" || v !== "compliance";

const filterChecks = (role: Role, checks: ExternalCheck[]) => checks.filter((c) => canSee(role, c.visibility));
const filterFindings = (role: Role, findings: Finding[]) => findings.filter((f) => canSee(role, f.visibility));

/** Agent outputs whose structured data is itself compliance-sensitive. */
const COMPLIANCE_DATA_AGENTS = new Set(["sanctions-pep", "aml-risk"]);

export function runForRole(run: Run, role: Role): Run {
  const visibleIds = new Set<string>();
  const results: AgentResult[] = run.results.map((r) => {
    const findings = filterFindings(role, r.findings);
    const checks = filterChecks(role, r.checks);
    for (const f of findings) visibleIds.add(f.id);
    for (const c of checks) visibleIds.add(c.id);
    const hideData = role !== "compliance" && COMPLIANCE_DATA_AGENTS.has(r.agent);
    return { ...r, findings, checks, data: hideData ? undefined : r.data };
  });
  for (const r of results) for (const f of r.facts) visibleIds.add(f.id);
  const rec = run.recommendation && {
    ...run.recommendation,
    // reasons pointing at hidden findings/checks are replaced by one neutral marker
    reasons: [
      ...run.recommendation.reasons.filter((id) => visibleIds.has(id) || id.startsWith("agent:")),
      ...(run.recommendation.reasons.some((id) => !visibleIds.has(id) && !id.startsWith("agent:")) ? ["compliance_review"] : []),
    ],
  };
  return {
    ...run,
    results,
    recommendation: rec,
    complianceSummary: role === "compliance" ? run.complianceSummary : undefined,
  };
}
