/**
 * Test helpers only (never imported by production code). Builds agent contexts from
 * hand-written OCR output so deterministic agent logic can be unit-tested without AWS.
 */
import type { AgentName, AgentResult, Case, CaseDocument, OcrResult, Workflow } from "@dc/contracts";
import type { Agent, AgentContext } from "@dc/ports";

const box = { left: 0.1, top: 0.1, width: 0.5, height: 0.03 };

export function ocrDoc(
  docId: string,
  lines: string[],
  opts: { kv?: Record<string, string>; tables?: string[][][]; confidence?: number } = {},
): OcrResult {
  return {
    docId,
    engine: "test",
    pages: [
      {
        page: 1,
        lines: lines.map((text) => ({ text, bbox: box, confidence: opts.confidence ?? 99 })),
        keyValues: Object.entries(opts.kv ?? {}).map(([key, value]) => ({ key, value, bbox: box, confidence: opts.confidence ?? 95 })),
        queries: [],
        tables: opts.tables ?? [],
      },
    ],
  };
}

export function doc(id: string, extra: Partial<CaseDocument> = {}): CaseDocument {
  return {
    id,
    caseId: "case-1",
    fileName: `${id}.pdf`,
    contentType: "application/pdf",
    sha256: `sha-${id}`,
    storageKey: `cases/case-1/${id}`,
    sizeBytes: 1000,
    uploadedAt: "2026-10-01T00:00:00Z",
    metadata: {},
    ...extra,
  };
}

export function makeCase(workflow: Workflow, docs: CaseDocument[], extra: Partial<Case> = {}): Case {
  return {
    id: "case-1",
    workflow,
    subject: { customerRef: "CUST-1" },
    createdAt: "2026-10-01T00:00:00Z",
    createdBy: "officer-1",
    documents: docs,
    consents: [],
    runs: [],
    ...extra,
  };
}

/** Runs agents in order, accumulating facts/findings/checks the same way the coordinator does. */
export async function runChain(c: Case, ocr: Record<string, OcrResult>, agents: Agent[], now = new Date("2026-10-28T12:00:00Z")) {
  const results: Partial<Record<AgentName, AgentResult>> = {};
  const ctx = (): AgentContext => {
    const all = Object.values(results) as AgentResult[];
    return {
      case: c,
      runId: "run-1",
      ocr,
      results: { ...results },
      facts: all.flatMap((r) => r.facts),
      findings: all.flatMap((r) => r.findings),
      checks: all.flatMap((r) => r.checks),
      now,
      signal: new AbortController().signal,
    };
  };
  for (const a of agents) {
    const out = await a.run(ctx());
    results[a.name] = {
      agent: a.name,
      status: out.status,
      findings: out.findings ?? [],
      facts: out.facts ?? [],
      checks: out.checks ?? [],
      data: out.data,
      error: out.error,
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
    };
  }
  return { results, ctx: ctx() };
}

/** Builds a CNP with a valid control digit from the first 12 digits. */
export function cnp(first12: string): string {
  const w = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const sum = first12.split("").reduce((a, d, i) => a + Number(d) * w[i]!, 0);
  return first12 + String(sum % 11 === 10 ? 1 : sum % 11);
}
