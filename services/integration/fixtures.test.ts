/**
 * End-to-end over the real sample documents in fixtures/<case>/ against REAL AWS
 * (S3, Textract, Bedrock, DynamoDB in eu-central-1). Skipped unless INTEGRATION=1.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { signCaller } from "../apps/document-check/src/auth";
import { compose } from "../apps/document-check/src/server";

const enabled = process.env.INTEGRATION === "1";
const root = join(import.meta.dir, "..", "fixtures");
const caseDirs = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());

type CaseJson = { workflow: string; subject: Record<string, unknown>; consents?: string[] };
type Expected = { lane?: string; codes?: string[]; absent?: string[] };

if (!enabled) test.skip("fixtures against real AWS (set INTEGRATION=1)", () => {});
else {
  process.env.STAFF_API_SIGNING_KEY ??= "integration";
  const { app, coordinator, cfg } = await compose();
  describe("fixtures against real AWS", () => {
  const caller = { actor: "integration-test", role: "compliance" as const };
  const call = (method: string, path: string, body?: BodyInit, json = false) =>
    app.request(path, { method, body, headers: { ...signCaller(cfg.signingKey, caller, method, path), ...(json ? { "content-type": "application/json" } : {}) } });

  test.if(caseDirs.length === 0)("no fixture cases found — add folders under services/fixtures/", () => {
    expect(caseDirs.length).toBe(0);
  });

  for (const dir of caseDirs) {
    test(
      dir,
      async () => {
        const meta = (await Bun.file(join(root, dir, "case.json")).json()) as CaseJson;
        const expectedFile = Bun.file(join(root, dir, "expected-findings.json"));
        const expected: Expected = (await expectedFile.exists()) ? await expectedFile.json() : {};

        const created = await (await call("POST", "/v1/cases", JSON.stringify({ workflow: meta.workflow, subject: meta.subject }), true)).json();
        for (const purpose of meta.consents ?? [])
          await call("POST", `/v1/cases/${created.id}/consents`, JSON.stringify({ purpose, noticeVersion: "integration-test", givenAt: new Date().toISOString(), channel: "branch_tablet" }), true);
        for (const f of readdirSync(join(root, dir)).filter((x) => /\.(pdf|png|jpe?g|tiff?)$/i.test(x))) {
          const fd = new FormData();
          fd.set("file", new File([await Bun.file(join(root, dir, f)).arrayBuffer()], f));
          const up = await call("POST", `/v1/cases/${created.id}/documents`, fd);
          expect(up.status).toBe(201);
        }
        // run synchronously here instead of the background queue
        const { runId } = await (await call("POST", `/v1/cases/${created.id}/runs`)).json();
        const run = await coordinator.run(created.id, runId);

        const codes = run.results.flatMap((r) => r.findings.map((f) => f.code));
        console.log(`\n[${dir}] lane=${run.recommendation?.lane} findings=${JSON.stringify(codes)}`);
        console.log(run.officerSummary?.sentences.map((s) => `  • ${s.text} [${s.citations.join(", ")}]`).join("\n"));
        expect(run.status).toBe("completed");
        for (const r of run.results) for (const f of r.findings) expect(f.citations.length).toBeGreaterThan(0);
        if (expected.lane) expect(run.recommendation?.lane as string | undefined).toBe(expected.lane);
        for (const c of expected.codes ?? []) expect(codes).toContain(c);
        for (const c of expected.absent ?? []) expect(codes).not.toContain(c);
        expect((await (await call("GET", `/v1/cases/${created.id}/audit/verify`)).json()).valid).toBe(true);
      },
      600_000,
    );
  }
  });
}
