import type { AgentName, AgentResult, AiText, Case, OcrResult, Recommendation, Run, Workflow } from "@dc/contracts";
import type { Agent, AgentContext, AuditLog, CaseStorePort, Clock, DocumentStorePort, OcrPort, OcrQuery } from "@dc/ports";
import { canonicalJson, sha256Hex } from "@dc/rules";

/** Stages run in order; agents inside a stage run in parallel (they only read earlier stages). */
export const WORKFLOWS: Record<Workflow, AgentName[][]> = {
  onboarding: [
    ["classification"],
    ["extraction"],
    ["document-verification", "cross-reference", "risk-fraud"],
    ["sanctions-pep", "bank-verification"],
    ["aml-risk"],
    ["investigation"],
    ["triage"],
    ["summary-communication"],
  ],
  loan: [
    ["classification"],
    ["extraction"],
    ["document-verification", "cross-reference", "risk-fraud"],
    ["kyc-freshness", "credit-history", "bank-verification"],
    ["affordability"],
    ["investigation"],
    ["triage"],
    ["summary-communication"],
  ],
  mortgage: [
    ["classification"],
    ["extraction"],
    ["document-verification", "cross-reference", "risk-fraud"],
    ["kyc-freshness", "credit-history", "bank-verification"],
    ["affordability", "collateral"],
    ["investigation"],
    ["triage"],
    ["summary-communication"],
  ],
};

export type CoordinatorDeps = {
  agents: Partial<Record<AgentName, Agent>>;
  ocr: OcrPort;
  ocrQueries: OcrQuery[];
  documents: DocumentStorePort;
  cases: CaseStorePort;
  audit: AuditLog;
  clock: Clock;
  timeoutsMs?: Partial<Record<AgentName | "ocr", number>>;
  /** Model id behind the AiPort, recorded in the audit trail (EU AI Act art. 12 logging). */
  modelId?: string;
};

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_TIMEOUTS: Partial<Record<AgentName | "ocr", number>> = { ocr: 180_000, investigation: 120_000, "summary-communication": 120_000, "sanctions-pep": 120_000 };

const hashOf = (v: unknown) => sha256Hex(canonicalJson(v)).slice(0, 16);

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; timeout: boolean; error: string }> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; timeout: true; error: string }>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ ok: false, timeout: true, error: `timed out after ${ms} ms` });
    }, ms);
  });
  try {
    return await Promise.race([fn(ac.signal).then((value) => ({ ok: true as const, value })), timeout]);
  } catch (e) {
    return { ok: false, timeout: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Coordinator agent: runs the workflow pipeline, enforces order and timeouts, merges agent
 * outputs into one run, and audits every step. It never decides — the run ends with a
 * recommendation lane for a human officer.
 */
export function createCoordinator(deps: CoordinatorDeps) {
  const timeoutOf = (k: AgentName | "ocr") => deps.timeoutsMs?.[k] ?? DEFAULT_TIMEOUTS[k] ?? DEFAULT_TIMEOUT;

  async function ingest(c: Case, runId: string): Promise<{ ocr: Record<string, OcrResult>; failures: Run["ocrFailures"] }> {
    const out: Record<string, OcrResult> = {};
    const failures: Run["ocrFailures"] = [];
    await Promise.all(
      c.documents.map(async (d) => {
        // OCR is cached by content hash: the same bytes are never sent to Textract twice
        const key = `ocr/${d.sha256}.json`;
        let res = await deps.documents.getJson<OcrResult>(key);
        const cached = !!res;
        if (!res) {
          const r = await withTimeout(timeoutOf("ocr"), (signal) => deps.ocr.analyze({ docId: d.id, storageKey: d.storageKey, contentType: d.contentType, queries: deps.ocrQueries }, signal));
          if (!r.ok) {
            failures.push({ docId: d.id, fileName: d.fileName, error: r.error });
            // ids and the engine's message only — no document content in logs
            console.error(JSON.stringify({ level: "error", msg: "OCR failed", caseId: c.id, runId, docId: d.id, error: r.error }));
            await deps.audit.append(c.id, "coordinator", "ocr.failed", { runId, docId: d.id, sha256: d.sha256, error: r.error });
            return;
          }
          res = r.value;
          await deps.documents.putJson(key, res);
        }
        out[d.id] = { ...res, docId: d.id };
        await deps.audit.append(c.id, "coordinator", "ocr.completed", { runId, docId: d.id, sha256: d.sha256, engine: res.engine, jobId: res.jobId, pages: res.pages.length, cached, ocrHash: hashOf(res) });
      }),
    );
    return { ocr: out, failures };
  }

  async function run(caseId: string, runId: string): Promise<Run> {
    const c = await deps.cases.getCase(caseId);
    if (!c) throw new Error(`case ${caseId} not found`);
    const startedAt = deps.clock.now().toISOString();
    let runRec: Run = { id: runId, caseId, status: "running", startedAt, results: [], ocrFailures: [] };
    await deps.cases.putRun(runRec);
    await deps.audit.append(caseId, "coordinator", "run.started", { runId, workflow: c.workflow, documents: c.documents.map((d) => d.sha256), consents: c.consents.map((x) => ({ id: x.id, purpose: x.purpose, noticeVersion: x.noticeVersion })) });

    try {
      const { ocr, failures } = await ingest(c, runId);
      runRec = { ...runRec, ocrFailures: failures };
      const results: Partial<Record<AgentName, AgentResult>> = {};
      const now = deps.clock.now();

      for (const stage of WORKFLOWS[c.workflow]) {
        const snapshot = (): AgentContext => {
          const done = Object.values(results) as AgentResult[];
          return {
            case: c,
            runId,
            ocr,
            results: { ...results },
            facts: done.flatMap((r) => r.facts),
            findings: done.flatMap((r) => r.findings),
            checks: done.flatMap((r) => r.checks),
            now,
            signal: new AbortController().signal,
          };
        };
        const ctx = snapshot();
        await Promise.all(
          stage.map(async (name) => {
            const agent = deps.agents[name];
            const t0 = deps.clock.now();
            if (!agent) throw new Error(`agent ${name} not registered`);
            const r = await withTimeout(timeoutOf(name), (signal) => agent.run({ ...ctx, signal }));
            const t1 = deps.clock.now();
            const result: AgentResult = r.ok
              ? { agent: name, status: r.value.status, findings: r.value.findings ?? [], facts: r.value.facts ?? [], checks: r.value.checks ?? [], data: r.value.data, error: r.value.error, startedAt: t0.toISOString(), finishedAt: t1.toISOString() }
              : { agent: name, status: r.timeout ? "timeout" : "error", findings: [], facts: [], checks: [], error: r.error, startedAt: t0.toISOString(), finishedAt: t1.toISOString() };
            results[name] = result;
            const ai = (result.data as Partial<AiText> | undefined)?.promptVersion ? (result.data as AiText) : undefined;
            await deps.audit.append(caseId, name, "agent.completed", {
              runId,
              status: result.status,
              durationMs: t1.getTime() - t0.getTime(),
              findings: result.findings.map((f) => ({ id: f.id, code: f.code, severity: f.severity })),
              facts: result.facts.length,
              factsHash: hashOf(result.facts),
              checks: result.checks.map((x) => ({ id: x.id, status: x.status, simulated: x.simulated, consentId: x.consentId })),
              dataHash: hashOf(result.data ?? null),
              error: result.error,
              ...(name === "investigation" || name === "summary-communication" ? { modelId: deps.modelId, promptVersion: ai?.promptVersion ?? (result.data as { officerSummary?: AiText })?.officerSummary?.promptVersion } : {}),
            });
          }),
        );
        runRec = { ...runRec, results: Object.values(results) as AgentResult[] };
        await deps.cases.putRun(runRec);
      }

      const summary = results["summary-communication"]?.data as { officerSummary?: AiText; complianceSummary?: AiText; customerMessage?: AiText } | undefined;
      const investigation = results.investigation?.status === "ok" ? (results.investigation.data as AiText) : undefined;
      runRec = {
        ...runRec,
        status: "completed",
        finishedAt: deps.clock.now().toISOString(),
        recommendation: results.triage?.data as Recommendation | undefined,
        officerSummary: summary?.officerSummary,
        complianceSummary: summary?.complianceSummary,
        customerMessage: summary?.customerMessage,
        investigation,
      };
      await deps.cases.putRun(runRec);
      await deps.audit.append(caseId, "coordinator", "run.completed", { runId, recommendation: runRec.recommendation, runHash: hashOf(runRec.results) });
      return runRec;
    } catch (e) {
      runRec = { ...runRec, status: "failed", finishedAt: deps.clock.now().toISOString(), error: e instanceof Error ? e.message : String(e) };
      await deps.cases.putRun(runRec);
      await deps.audit.append(caseId, "coordinator", "run.failed", { runId, error: runRec.error });
      return runRec;
    }
  }

  return { run };
}
