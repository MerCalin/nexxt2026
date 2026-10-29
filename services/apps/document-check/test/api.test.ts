/**
 * HTTP layer: authentication, role-based visibility, decision gating, audit.
 * Storage here is an in-memory test double; production uses S3 + DynamoDB.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createAuditLog } from "@dc/agent-audit";
import type { AuditEntry, Case, Run } from "@dc/contracts";
import type { AuditStorePort, CaseStorePort, DocumentStorePort } from "@dc/ports";
import { makeCheck, makeFinding } from "@dc/rules";
import { createApp } from "../src/app";
import { type Caller, signCaller } from "../src/auth";

const KEY = "test-signing-key";

class Mem implements CaseStorePort, DocumentStorePort, AuditStorePort {
  cases = new Map<string, Case>();
  runs = new Map<string, Run>();
  blobs = new Map<string, Uint8Array>();
  audit: AuditEntry[] = [];
  hashes: { h: string; caseId: string; docId: string }[] = [];
  async createCase(c: Case) { this.cases.set(c.id, structuredClone(c)); }
  async getCase(id: string) { const c = this.cases.get(id); return c && structuredClone(c); }
  async putCase(c: Case) { this.cases.set(c.id, structuredClone(c)); }
  async listCases() { return [...this.cases.values()]; }
  async putRun(r: Run) { this.runs.set(r.id, structuredClone(r)); }
  async getRun(id: string) { const r = this.runs.get(id); return r && structuredClone(r); }
  async findByPerceptualHash(h: string) { return this.hashes.filter((x) => x.h === h); }
  async indexPerceptualHash(h: string, caseId: string, docId: string) { this.hashes.push({ h, caseId, docId }); }
  async put(k: string, b: Uint8Array) { this.blobs.set(k, b); }
  async get(k: string) { return this.blobs.get(k)!; }
  async putJson() {}
  async getJson() { return undefined; }
  async append(e: AuditEntry) { this.audit.push(e); }
  async list(caseId: string) { return this.audit.filter((e) => e.caseId === caseId); }
  async head(caseId: string) { return this.audit.filter((e) => e.caseId === caseId).at(-1); }
}

let mem: Mem;
let app: ReturnType<typeof createApp>;
const started: string[] = [];
const clock = { now: () => new Date() };

beforeEach(() => {
  mem = new Mem();
  started.length = 0;
  app = createApp({ cases: mem, documents: mem, audit: createAuditLog(mem, clock), clock, signingKey: KEY, maxUploadBytes: 1_000_000, startRun: (_c, r) => started.push(r) });
});

const officer: Caller = { actor: "ana.ionescu", role: "credit_officer" };
const compliance: Caller = { actor: "radu.pop", role: "compliance" };

function call(caller: Caller | undefined, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = caller ? signCaller(KEY, caller, method, path) : {};
  if (body !== undefined && !(body instanceof FormData)) headers["content-type"] = "application/json";
  return app.request(path, { method, headers, body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined });
}

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Producer (Adobe Photoshop 25) /CreationDate (D:20261001100000Z) /ModDate (D:20261020100000Z) >>\n%%EOF\n");

async function caseWithCompletedRun(compFinding: boolean) {
  const res = await call(officer, "POST", "/v1/cases", { workflow: "loan", subject: { customerRef: "C1" } });
  const c = (await res.json()) as Case;
  const runId = "run-1";
  const hidden = makeFinding({ agent: "sanctions-pep", code: "SANCTIONS_POSSIBLE_MATCH", severity: "high", message: "match", citations: ["check:sanctions:eu"], visibility: "compliance" });
  const visible = makeFinding({ agent: "cross-reference", code: "XREF_ADDRESS_MISMATCH", severity: "low", message: "addr", citations: ["ci:address"] });
  const run: Run = {
    id: runId,
    caseId: c.id,
    status: "completed",
    startedAt: new Date().toISOString(),
    ocrFailures: [],
    results: [
      { agent: "cross-reference", status: "ok", findings: [visible], facts: [], checks: [], startedAt: "", finishedAt: "" },
      { agent: "sanctions-pep", status: "ok", findings: compFinding ? [hidden] : [], facts: [], checks: [makeCheck({ kind: "sanctions:eu", source: "EU", simulated: false, status: compFinding ? "hit" : "ok", payload: { matches: ["X"] }, retrievedAt: "", visibility: "compliance" })], data: { secret: true }, startedAt: "", finishedAt: "" },
    ],
    recommendation: { lane: "human_review", reasons: compFinding ? [hidden.id, visible.id] : [visible.id], rules: ["T2_HIGH_SEVERITY"] },
    complianceSummary: { sentences: [{ text: "match", citations: ["check:sanctions:eu"] }], modelId: "m", promptVersion: "p", fallback: true, rejected: [] },
  };
  await mem.putRun(run);
  await mem.putCase({ ...(await mem.getCase(c.id))!, runs: [runId] });
  return c;
}

describe("service API", () => {
  test("rejects unsigned and tampered requests", async () => {
    expect((await call(undefined, "GET", "/v1/cases")).status).toBe(401);
    const h = signCaller(KEY, officer, "GET", "/v1/cases");
    const res = await app.request("/v1/cases", { headers: { ...h, "x-dc-role": "compliance" } });
    expect(res.status).toBe(401);
  });

  test("upload sniffs the type, extracts metadata, indexes the hash and audits", async () => {
    const c = (await (await call(officer, "POST", "/v1/cases", { workflow: "loan", subject: { customerRef: "C1" } })).json()) as Case;
    const fd = new FormData();
    fd.set("file", new File([PDF], "extras.pdf", { type: "application/octet-stream" }));
    const res = await call(officer, "POST", `/v1/cases/${c.id}/documents`, fd);
    expect(res.status).toBe(201);
    const doc = await res.json();
    expect(doc.contentType).toBe("application/pdf");
    expect(doc.metadata.producer).toBe("Adobe Photoshop 25");
    expect(doc.metadata.modDate).toBe("2026-10-20T10:00:00.000Z");
    expect(mem.hashes[0]!.h).toBe(`sha256:${doc.sha256}`);

    const bad = new FormData();
    bad.set("file", new File(["hello"], "x.pdf"));
    expect((await call(officer, "POST", `/v1/cases/${c.id}/documents`, bad)).status).toBe(415);
    expect(mem.audit.map((e) => e.action)).toEqual(["case.created", "document.uploaded"]);
  });

  test("credit officer never sees compliance findings, checks, data or summary", async () => {
    const c = await caseWithCompletedRun(true);
    const body = await (await call(officer, "GET", `/v1/cases/${c.id}`)).json();
    const s = JSON.stringify(body.run);
    expect(s).not.toContain("SANCTIONS_POSSIBLE_MATCH");
    expect(s).not.toContain("check:sanctions:eu");
    expect(body.run.complianceSummary).toBeUndefined();
    expect(body.run.recommendation.reasons).toContain("compliance_review");
    const comp = await (await call(compliance, "GET", `/v1/cases/${c.id}`)).json();
    expect(JSON.stringify(comp.run)).toContain("SANCTIONS_POSSIBLE_MATCH");
  });

  test("decision: human only, reason required, compliance must clear compliance findings", async () => {
    const c = await caseWithCompletedRun(true);
    expect((await call(officer, "POST", `/v1/cases/${c.id}/decision`, { outcome: "approved", reason: "short" })).status).toBe(400);
    expect((await call({ actor: "k", role: "kyc_officer" }, "POST", `/v1/cases/${c.id}/decision`, { outcome: "approved", reason: "Documente verificate manual." })).status).toBe(403);
    const blocked = await call(officer, "POST", `/v1/cases/${c.id}/decision`, { outcome: "approved", reason: "Documente verificate manual." });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toBe("compliance_review_required");
    const ok = await call(compliance, "POST", `/v1/cases/${c.id}/decision`, { outcome: "rejected", reason: "Potrivire confirmată pe lista UE." });
    expect(ok.status).toBe(201);
    expect((await call(compliance, "POST", `/v1/cases/${c.id}/decision`, { outcome: "approved", reason: "a doua decizie nu e permisă" })).status).toBe(409);
    const verify = await (await call(compliance, "GET", `/v1/cases/${c.id}/audit/verify`)).json();
    expect(verify.valid).toBe(true);
    const decided = mem.audit.find((e) => e.action === "decision.recorded")!;
    expect(decided.detail).toMatchObject({ outcome: "rejected", role: "compliance" });
    expect(JSON.stringify(decided.detail)).not.toContain("Potrivire"); // reason stored as hash only
  });

  test("run request queues a background run", async () => {
    const c = (await (await call(officer, "POST", "/v1/cases", { workflow: "onboarding", subject: { customerRef: "C2" } })).json()) as Case;
    expect((await call(officer, "POST", `/v1/cases/${c.id}/runs`)).status).toBe(400); // no documents
    const fd = new FormData();
    fd.set("file", new File([PDF], "ci.pdf"));
    await call(officer, "POST", `/v1/cases/${c.id}/documents`, fd);
    const res = await call(officer, "POST", `/v1/cases/${c.id}/runs`);
    expect(res.status).toBe(202);
    expect(started).toHaveLength(1);
  });
});
