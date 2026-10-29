import type { Finding, Lane, Recommendation } from "@dc/contracts";
import type { Agent, AgentContext } from "@dc/ports";

/** Codes the customer can resolve by sending a new or better document. */
export const NEEDS_INFO_CODES = new Set([
  "CLASS_MISSING_REQUIRED",
  "CLASS_REJECTED_POA",
  "CLASS_UNKNOWN",
  "CLASS_STATEMENT_NO_ADDRESS",
  "DOCVER_EXPIRED",
  "DOCVER_EXPIRING_SOON",
  "DOCVER_STALE",
  "DOCVER_DATE_UNREADABLE",
  "DOCVER_EXPIRY_UNREADABLE",
  "DOCVER_CNP_MISSING",
  "DOCVER_CONTRACT_ENDED",
  "DOCVER_NO_ANEVAR",
  "XREF_ADDRESS_MISMATCH",
  "XREF_NO_SALARY_CREDITS",
  "KYC_REFRESH_REQUIRED",
]);

/** Codes that always require a human reviewer, whatever the severity. */
const ALWAYS_HUMAN_PREFIXES = ["FRAUD_", "SANCTIONS_", "PEP_", "AML_", "CREDIT_", "AFFORD_", "BANKVER_", "COLL_"];

type Rule = { id: string; lane: Lane; when: (ctx: AgentContext, f: readonly Finding[]) => string[] };

/** Fixed, ordered rule table. The first lane with any reasons wins: human_review > needs_info > ready_for_officer. */
export const TRIAGE_RULES: Rule[] = [
  {
    id: "T1_AGENT_NOT_COMPLETED",
    lane: "human_review",
    when: (ctx) =>
      Object.values(ctx.results)
        .filter((r) => r && r.status !== "ok" && r.status !== "skipped")
        .map((r) => `agent:${r!.agent}:${r!.status}`),
  },
  { id: "T2_HIGH_SEVERITY", lane: "human_review", when: (_, f) => f.filter((x) => x.severity === "high").map((x) => x.id) },
  {
    id: "T3_SPECIALIST_FINDING",
    lane: "human_review",
    when: (_, f) => f.filter((x) => x.severity !== "info" && ALWAYS_HUMAN_PREFIXES.some((p) => x.code.startsWith(p))).map((x) => x.id),
  },
  {
    id: "T4_BLOCKED_CHECK",
    lane: "human_review",
    when: (ctx) => ctx.checks.filter((c) => c.status === "blocked" || c.status === "unavailable").map((c) => c.id),
  },
  {
    id: "T5_UNRESOLVED_MEDIUM",
    lane: "human_review",
    when: (_, f) => f.filter((x) => x.severity === "medium" && !NEEDS_INFO_CODES.has(x.code)).map((x) => x.id),
  },
  { id: "T6_CUSTOMER_FIXABLE", lane: "needs_info", when: (_, f) => f.filter((x) => x.severity !== "info" && NEEDS_INFO_CODES.has(x.code)).map((x) => x.id) },
];

export function triage(ctx: AgentContext): Recommendation {
  const fired = TRIAGE_RULES.map((r) => ({ r, reasons: r.when(ctx, ctx.findings) })).filter((x) => x.reasons.length);
  const order: Lane[] = ["human_review", "needs_info"];
  for (const lane of order) {
    const hits = fired.filter((x) => x.r.lane === lane);
    if (hits.length) return { lane, reasons: [...new Set(hits.flatMap((h) => h.reasons))], rules: hits.map((h) => h.r.id) };
  }
  return { lane: "ready_for_officer", reasons: [], rules: ["T0_NO_ISSUES"] };
}

/** Triage agent: routes the case with fixed rules. It recommends a lane; it never approves or rejects. */
export function createTriageAgent(): Agent {
  return {
    name: "triage",
    async run(ctx) {
      return { status: "ok", data: triage(ctx) };
    },
  };
}
