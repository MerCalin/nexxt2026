/**
 * Guard and loop behaviour. The AiPort here is a scripted test double so that we can assert
 * what happens when a model returns bad output; real Bedrock calls are covered by the
 * integration suite (INTEGRATION=1).
 */
import { describe, expect, test } from "bun:test";
import { createInvestigationAgent, MAX_MODEL_TURNS } from "@dc/agent-investigation";
import { createSummaryCommunicationAgent } from "@dc/agent-summary-communication";
import type { AiText } from "@dc/contracts";
import type { Agent, AiPort, AiResponse } from "@dc/ports";
import { guardSentences, makeFact, makeFinding } from "@dc/rules";
import { makeCase, runChain } from "@dc/testkit";

const facts = [
  makeFact({ docId: "ci", docType: "id_card", field: "fullName", value: "IOANA STEFANESCU", normalized: "IOANA STEFANESCU", page: 1, ocrConfidence: 99, extractor: "t" }),
  makeFact({ docId: "st", docType: "bank_statement", field: "fullName", value: "IOANA POPA", normalized: "IOANA POPA", page: 1, ocrConfidence: 99, extractor: "t" }),
  makeFact({ docId: "case", docType: "unknown", field: "documentSet", value: "id_card,bank_statement", normalized: "", page: 1, ocrConfidence: 100, extractor: "t" }),
];
const nameFinding = makeFinding({ agent: "cross-reference", code: "XREF_NAME_MISMATCH", severity: "high", message: "Numele diferă: IOANA STEFANESCU vs IOANA POPA.", citations: ["ci:fullName", "st:fullName"] });
const poaFinding = makeFinding({ agent: "classification", code: "CLASS_MISSING_REQUIRED", severity: "medium", message: "Lipsește documentul obligatoriu: Dovada reședinței legale.", citations: ["case:documentSet"], values: ["residence"] });
const sanctionsFinding = makeFinding({ agent: "sanctions-pep", code: "SANCTIONS_POSSIBLE_MATCH", severity: "high", message: "Posibilă potrivire pe lista UE.", citations: ["ci:fullName"], visibility: "compliance" });
const ev = { facts, checks: [], findings: [nameFinding, poaFinding] };

describe("citation guard", () => {
  test("accepts grounded sentences", () => {
    const r = guardSentences([{ text: "Numele din cartea de identitate este „IOANA STEFANESCU”, iar în extras „IOANA POPA”.", citations: ["ci:fullName", "st:fullName"] }], ev);
    expect(r.rejected).toEqual([]);
  });
  test("rejects missing/unknown citations, invented numbers and names, speculation", () => {
    const r = guardSentences(
      [
        { text: "Clientul are un venit bun.", citations: [] },
        { text: "Numele diferă.", citations: ["nope:1"] },
        { text: "Venitul este 9000 RON.", citations: ["st:fullName"] },
        { text: "Clienta s-a căsătorit cu Mihai Popa.", citations: ["st:fullName"] },
        { text: "Probabil numele s-a schimbat.", citations: ["st:fullName"] },
      ],
      ev,
    );
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "no citations",
      "unknown citation(s): nope:1",
      "number not in cited evidence: 9000",
      "name not in cited evidence: Mihai",
      "speculative wording",
    ]);
  });
  test("hypotheses allowed for investigation; tipping-off blocked for customers", () => {
    expect(guardSentences([{ text: "Poate fi numele de dinainte de căsătorie: POPA.", citations: ["st:fullName"] }], ev, { allowHypothesis: true }).rejected).toEqual([]);
    expect(guardSentences([{ text: "Dosarul este verificat pentru sancțiuni.", citations: ["case:documentSet"] }], ev, { customerFacing: true }).rejected[0]!.reason).toBe("tipping-off lexicon");
  });
});

/** Scripted AiPort: returns the queued responses in order. */
function scripted(responses: AiResponse[]): AiPort & { calls: number } {
  const port = {
    modelId: "test-model",
    calls: 0,
    async converse() {
      const r = responses[Math.min(port.calls, responses.length - 1)]!;
      port.calls++;
      return r;
    },
  };
  return port;
}
const submit = (name: string, sentences: unknown): AiResponse => ({ content: [{ type: "tool_use", id: "t1", name, input: { sentences } }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } });
const toolCall = (name: string, input: Record<string, unknown>): AiResponse => ({ content: [{ type: "tool_use", id: `x${Math.random()}`, name, input }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } });

const seedAgent: Agent = { name: "cross-reference", run: async () => ({ status: "ok", facts, findings: [nameFinding, poaFinding, sanctionsFinding] }) };
const triageAgent: Agent = { name: "triage", run: async () => ({ status: "ok", data: { lane: "needs_info", reasons: [poaFinding.id], rules: ["T6_CUSTOMER_FIXABLE"] } }) };

describe("investigation agent", () => {
  test("enforces the 6-turn step cap", async () => {
    const ai = scripted([toolCall("list_findings", {})]);
    const { results } = await runChain(makeCase("onboarding", []), {}, [seedAgent, createInvestigationAgent({ ai })]);
    expect(ai.calls).toBe(MAX_MODEL_TURNS);
    const data = results.investigation!.data as AiText;
    expect(data.fallback).toBe(true);
    expect(data.rejected.at(-1)!.reason).toContain("step cap");
  });

  test("labels accepted hypotheses and drops ungrounded ones", async () => {
    const ai = scripted([
      toolCall("get_fact", { id: "st:fullName" }),
      submit("submit_hypotheses", [
        { text: "POPA poate fi numele de căsătorie al clientei IOANA STEFANESCU.", citations: ["ci:fullName", "st:fullName"] },
        { text: "Clienta s-a mutat în Cluj.", citations: ["st:fullName"] },
      ]),
    ]);
    const { results } = await runChain(makeCase("onboarding", []), {}, [seedAgent, createInvestigationAgent({ ai })]);
    const data = results.investigation!.data as AiText & { turns: number };
    expect(data.sentences).toHaveLength(1);
    expect(data.sentences[0]!.text.startsWith("Posibilă explicație:")).toBe(true);
    expect(data.rejected[0]!.reason).toContain("Cluj");
    expect(data.turns).toBe(2);
  });
});

describe("summary & communication agent", () => {
  test("customer message that leaks compliance info falls back to the neutral template", async () => {
    const ai = scripted([
      submit("submit_summary", [{ text: "Numele diferă între „IOANA STEFANESCU” și „IOANA POPA”.", citations: ["ci:fullName", "st:fullName"] }]),
      submit("submit_summary", [{ text: "Numele diferă.", citations: ["ci:fullName"] }]),
      submit("submit_message", [{ text: "Am găsit o potrivire pe lista de sancțiuni.", citations: ["case:documentSet"] }]),
    ]);
    const { results } = await runChain(makeCase("onboarding", []), {}, [seedAgent, triageAgent, createSummaryCommunicationAgent({ ai })]);
    const d = results["summary-communication"]!.data as { officerSummary: AiText; complianceSummary?: AiText; customerMessage: AiText };
    expect(d.officerSummary.fallback).toBe(false);
    expect(d.complianceSummary).toBeDefined();
    expect(d.customerMessage.fallback).toBe(true);
    expect(d.customerMessage.rejected[0]!.reason).toBe("tipping-off lexicon");
    const text = d.customerMessage.sentences.map((s) => s.text).join(" ");
    expect(text).toContain("dovadă a adresei");
    expect(text.toLowerCase()).not.toContain("sancțiun");
  });

  test("speculative officer summary falls back to a template without compliance-only findings", async () => {
    const ai = scripted([submit("submit_summary", [{ text: "Posibilă potrivire pe lista UE.", citations: ["ci:fullName"] }])]);
    const { results } = await runChain(makeCase("onboarding", []), {}, [seedAgent, triageAgent, createSummaryCommunicationAgent({ ai })]);
    const d = results["summary-communication"]!.data as { officerSummary: AiText };
    // the model's sentence is speculative → template; the template excludes compliance findings
    expect(d.officerSummary.fallback).toBe(true);
    expect(d.officerSummary.sentences.map((s) => s.text).join(" ")).not.toContain("lista UE");
  });
});
