import { randomUUID } from "node:crypto";
import { Consent, ConsentPurpose, type Case, type CaseDocument, Decision, REQUIREMENTS, type Role, Subject, Workflow } from "@dc/contracts";
import type { AuditLog, CaseStorePort, Clock, DocumentStorePort } from "@dc/ports";
import { sha256Hex } from "@dc/rules";
import { Hono } from "hono";
import { z } from "zod";
import { type Caller, verifyCaller } from "./auth";
import { ALLOWED_TYPES, extractFileMetadata, sniffType } from "./file-metadata";
import { runForRole } from "./visibility";

export type AppDeps = {
  cases: CaseStorePort;
  documents: DocumentStorePort;
  audit: AuditLog;
  clock: Clock;
  signingKey: string;
  maxUploadBytes: number;
  /** Starts a run in the background; resolves when the run has been recorded as queued. */
  startRun: (caseId: string, runId: string) => void;
};

type Env = { Variables: { caller: Caller } };

/** Who may record the final decision. AI never decides; these are human roles. */
const DECIDERS: Record<Workflow, Role[]> = {
  onboarding: ["kyc_officer", "compliance"],
  loan: ["credit_officer", "compliance"],
  mortgage: ["credit_officer", "compliance"],
};

export function createApp(deps: AppDeps) {
  const app = new Hono<Env>();
  const now = () => deps.clock.now().toISOString();

  app.get("/healthz", (c) => c.json({ ok: true }));

  // ---- caller authentication (signed by the staff API) ----
  app.use("/v1/*", async (c, next) => {
    const url = new URL(c.req.url);
    const caller = verifyCaller(deps.signingKey, c.req.raw.headers, c.req.method, url.pathname + url.search);
    if (!caller) return c.json({ error: "unauthenticated" }, 401);
    c.set("caller", caller);
    await next();
  });

  const loadCase = async (id: string) => deps.cases.getCase(id);

  app.get("/v1/requirements/:workflow", (c) => {
    const wf = Workflow.safeParse(c.req.param("workflow"));
    return wf.success ? c.json(REQUIREMENTS[wf.data]) : c.json({ error: "unknown workflow" }, 400);
  });

  app.get("/v1/cases", async (c) => {
    const list = await deps.cases.listCases(Number(c.req.query("limit") ?? 50));
    return c.json(list.map((x) => ({ id: x.id, workflow: x.workflow, customerRef: x.subject.customerRef, createdAt: x.createdAt, documents: x.documents.length, runs: x.runs.length, decision: x.decision?.outcome })));
  });

  app.post("/v1/cases", async (c) => {
    const body = z.object({ workflow: Workflow, subject: Subject }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    const caller = c.get("caller");
    const created: Case = { id: randomUUID(), workflow: body.data.workflow, subject: body.data.subject, createdAt: now(), createdBy: caller.actor, documents: [], consents: [], runs: [] };
    await deps.cases.createCase(created);
    await deps.audit.append(created.id, `officer:${caller.actor}`, "case.created", { workflow: created.workflow, customerRef: created.subject.customerRef, role: caller.role });
    return c.json(created, 201);
  });

  app.get("/v1/cases/:id", async (c) => {
    const caller = c.get("caller");
    const found = await loadCase(c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const lastRunId = found.runs.at(-1);
    const run = lastRunId ? await deps.cases.getRun(lastRunId) : undefined;
    // the web app re-fetches every few seconds while a run is in progress (?poll=1); only real opens are logged
    if (c.req.query("poll") !== "1") await deps.audit.append(found.id, `officer:${caller.actor}`, "case.viewed", { role: caller.role, runId: lastRunId });
    return c.json({ case: found, run: run && runForRole(run, caller.role), requirements: REQUIREMENTS[found.workflow] });
  });

  app.post("/v1/cases/:id/documents", async (c) => {
    const caller = c.get("caller");
    const found = await loadCase(c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.decision) return c.json({ error: "case already decided" }, 409);
    const form = await c.req.formData().catch(() => undefined);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "multipart field 'file' required" }, 400);
    if (file.size > deps.maxUploadBytes) return c.json({ error: `file larger than ${deps.maxUploadBytes} bytes` }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffType(bytes);
    if (!type || !ALLOWED_TYPES.has(type)) return c.json({ error: "only PDF, PNG, JPEG or TIFF documents are accepted" }, 415);

    const id = randomUUID();
    const sha256 = sha256Hex(bytes);
    const storageKey = `cases/${found.id}/${id}.${ALLOWED_TYPES.get(type)}`;
    await deps.documents.put(storageKey, bytes, type);
    const doc: CaseDocument = { id, caseId: found.id, fileName: file.name.slice(0, 200), contentType: type, sha256, storageKey, sizeBytes: bytes.length, uploadedAt: now(), metadata: extractFileMetadata(bytes, type) };
    // re-read to avoid losing concurrent uploads
    const fresh = (await loadCase(found.id))!;
    await deps.cases.putCase({ ...fresh, documents: [...fresh.documents, doc] });
    await deps.cases.indexPerceptualHash(`sha256:${sha256}`, found.id, id);
    if (doc.metadata.perceptualHash) await deps.cases.indexPerceptualHash(`phash:${doc.metadata.perceptualHash}`, found.id, id);
    await deps.audit.append(found.id, `officer:${caller.actor}`, "document.uploaded", { docId: id, sha256, contentType: type, sizeBytes: bytes.length });
    return c.json(doc, 201);
  });

  app.get("/v1/cases/:id/documents/:docId/file", async (c) => {
    const caller = c.get("caller");
    const found = await loadCase(c.req.param("id"));
    const doc = found?.documents.find((d) => d.id === c.req.param("docId"));
    if (!found || !doc) return c.json({ error: "not found" }, 404);
    const bytes = await deps.documents.get(doc.storageKey);
    await deps.audit.append(found.id, `officer:${caller.actor}`, "document.viewed", { docId: doc.id, role: caller.role });
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { headers: { "content-type": doc.contentType, "cache-control": "private, no-store" } });
  });

  app.post("/v1/cases/:id/consents", async (c) => {
    const caller = c.get("caller");
    const found = await loadCase(c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const body = z
      .object({ purpose: ConsentPurpose, noticeVersion: z.string().min(1), givenAt: z.string(), channel: Consent.shape.channel })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    const consent: Consent = { id: randomUUID(), caseId: found.id, ...body.data, recordedBy: caller.actor };
    await deps.cases.putCase({ ...found, consents: [...found.consents.filter((x) => x.purpose !== consent.purpose || x.withdrawnAt), consent] });
    await deps.audit.append(found.id, `officer:${caller.actor}`, "consent.recorded", { consentId: consent.id, purpose: consent.purpose, noticeVersion: consent.noticeVersion, channel: consent.channel, givenAt: consent.givenAt });
    return c.json(consent, 201);
  });

  app.delete("/v1/cases/:id/consents/:consentId", async (c) => {
    const caller = c.get("caller");
    const found = await loadCase(c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    const consents = found.consents.map((x) => (x.id === c.req.param("consentId") ? { ...x, withdrawnAt: now() } : x));
    await deps.cases.putCase({ ...found, consents });
    await deps.audit.append(found.id, `officer:${caller.actor}`, "consent.withdrawn", { consentId: c.req.param("consentId") });
    return c.body(null, 204);
  });

  app.post("/v1/cases/:id/runs", async (c) => {
    const caller = c.get("caller");
    const found = await loadCase(c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.decision) return c.json({ error: "case already decided" }, 409);
    if (!found.documents.length) return c.json({ error: "no documents uploaded" }, 400);
    const runId = randomUUID();
    await deps.cases.putRun({ id: runId, caseId: found.id, status: "queued", startedAt: now(), results: [], ocrFailures: [] });
    await deps.cases.putCase({ ...found, runs: [...found.runs, runId] });
    await deps.audit.append(found.id, `officer:${caller.actor}`, "run.requested", { runId });
    deps.startRun(found.id, runId);
    return c.json({ runId, status: "queued" }, 202);
  });

  app.get("/v1/cases/:id/runs/:runId", async (c) => {
    const run = await deps.cases.getRun(c.req.param("runId"));
    if (!run || run.caseId !== c.req.param("id")) return c.json({ error: "not found" }, 404);
    return c.json(runForRole(run, c.get("caller").role));
  });

  app.post("/v1/cases/:id/decision", async (c) => {
    const caller = c.get("caller");
    const found = await loadCase(c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.decision) return c.json({ error: "case already decided" }, 409);
    const body = z.object({ outcome: Decision.shape.outcome, reason: Decision.shape.reason }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    const runId = found.runs.at(-1);
    const run = runId ? await deps.cases.getRun(runId) : undefined;
    if (!run || run.status !== "completed") return c.json({ error: "the latest check run must be completed before a decision" }, 409);
    if (!DECIDERS[found.workflow].includes(caller.role)) return c.json({ error: `role ${caller.role} cannot decide ${found.workflow} cases` }, 403);
    // open compliance-only matters must be cleared by Compliance (Law 129/2019 art. 17, 24)
    const complianceOpen = run.results.some((r) => r.findings.some((f) => f.visibility === "compliance" && (f.severity === "high" || f.severity === "medium")));
    if (complianceOpen && caller.role !== "compliance" && body.data.outcome === "approved")
      return c.json({ error: "compliance_review_required" }, 403);

    const decision: Decision = { ...body.data, officerId: caller.actor, officerRole: caller.role, decidedAt: now(), runId: run.id };
    await deps.cases.putCase({ ...found, decision });
    await deps.audit.append(found.id, `officer:${caller.actor}`, "decision.recorded", {
      outcome: decision.outcome,
      reasonHash: sha256Hex(decision.reason),
      role: caller.role,
      runId: run.id,
      recommendedLane: run.recommendation?.lane,
      // EU AI Act art. 14: record whether the human followed or departed from the AI-assisted recommendation
      followedRecommendation: run.recommendation ? (run.recommendation.lane === "ready_for_officer") === (decision.outcome === "approved") : undefined,
    });
    return c.json(decision, 201);
  });

  app.get("/v1/cases/:id/audit", async (c) => {
    const found = await loadCase(c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    return c.json(await deps.audit.list(found.id));
  });

  app.get("/v1/cases/:id/audit/verify", async (c) => {
    const found = await loadCase(c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    return c.json(await deps.audit.verify(found.id));
  });

  return app;
}
