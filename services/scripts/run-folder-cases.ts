/**
 * Runs a folder of customer folders (e.g. the hackathon data set) through the real pipeline
 * (S3, Textract, agents, Bedrock, DynamoDB) and writes a review report. There is no answer key:
 * the input data may itself be wrong, so the report lists what the system found per customer
 * for a human to review.
 *
 *   source ~/doccheck.env
 *   bun scripts/run-folder-cases.ts --src ~/Downloads/hackerton --workflow onboarding --limit 10
 *
 * Options: --workflow onboarding|loan (default onboarding), --limit N (default 10, 0 = all),
 *          --only <folder name>, --concurrency N (default 2).
 * Each customer becomes a normal case (customerRef = folder name), so results can be opened in the web app.
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Run } from "@dc/contracts";
import { signCaller } from "../apps/document-check/src/auth";
import { compose } from "../apps/document-check/src/server";

const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : def;
};
const src = arg("--src");
if (!src) throw new Error("usage: bun scripts/run-folder-cases.ts --src <folder> [--workflow onboarding|loan] [--limit N] [--only NAME] [--concurrency N]");
const workflow = (arg("--workflow", "onboarding") as "onboarding" | "loan");
const limit = Number(arg("--limit", "10"));
const only = arg("--only");
const concurrency = Number(arg("--concurrency", "2"));

/** Onboarding uses identity + residence only; loan uses every file. Files named 1_*, 2_* = identity, 3_* = residence. */
const pick = (files: string[]) =>
  files.filter((f) => /\.(pdf|png|jpe?g|tiff?)$/i.test(f) && (workflow === "loan" || /^[123]_/.test(f)));

process.env.STAFF_API_SIGNING_KEY ??= "batch";
const { app, coordinator, cfg } = await compose();
const caller = { actor: "batch-runner", role: "compliance" as const };
const call = (method: string, path: string, body?: BodyInit, json = false) =>
  app.request(path, { method, body, headers: { ...signCaller(cfg.signingKey, caller, method, path), ...(json ? { "content-type": "application/json" } : {}) } });

let folders = readdirSync(src)
  .filter((d) => statSync(join(src, d)).isDirectory())
  .sort();
if (only) folders = folders.filter((d) => d === only);
if (limit > 0) folders = folders.slice(0, limit);
console.log(`Running ${folders.length} ${workflow} case(s) from ${src} in ${cfg.region} (model ${cfg.bedrockModelId})\n`);

type Row = { folder: string; caseId: string; status: string; lane: string; types: string; names: string; findings: string; summary: string; seconds: number; error?: string };
const rows: Row[] = [];
const consents = workflow === "loan" ? ["credit_bureau_lookup", "criminal_record_lookup", "anaf_tax_debt_lookup"] : ["criminal_record_lookup", "anaf_tax_debt_lookup"];
const subject = (folder: string) =>
  workflow === "loan" ? { customerRef: folder, loan: { amount: 50_000, currency: "RON", termMonths: 60, annualRatePct: 8.5 } } : { customerRef: folder };

async function runOne(folder: string): Promise<Row> {
  const t0 = Date.now();
  const dir = join(src!, folder);
  try {
    const created = await (await call("POST", "/v1/cases", JSON.stringify({ workflow, subject: subject(folder) }), true)).json();
    if (!created.id) throw new Error(`create case failed: ${JSON.stringify(created)}`);
    for (const purpose of consents)
      await call("POST", `/v1/cases/${created.id}/consents`, JSON.stringify({ purpose, noticeVersion: "batch-test", givenAt: new Date().toISOString(), channel: "branch_tablet" }), true);
    for (const f of pick(readdirSync(dir)).sort()) {
      const fd = new FormData();
      fd.set("file", new File([await Bun.file(join(dir, f)).arrayBuffer()], f));
      const up = await call("POST", `/v1/cases/${created.id}/documents`, fd);
      if (up.status !== 201) throw new Error(`upload ${f}: HTTP ${up.status} ${await up.text()}`);
    }
    const { runId } = await (await call("POST", `/v1/cases/${created.id}/runs`)).json();
    const run: Run = await coordinator.run(created.id, runId);
    const facts = run.results.flatMap((r) => r.facts);
    const findings = run.results.flatMap((r) => r.findings).filter((f) => f.severity !== "info");
    return {
      folder,
      caseId: created.id,
      status: run.status,
      lane: run.recommendation?.lane ?? "-",
      types: facts.filter((f) => f.field === "docType" && f.docId !== "case").map((f) => f.value).join(" + "),
      names: [...new Set(facts.filter((f) => f.field === "fullName").map((f) => f.value))].join(" | "),
      findings: findings.map((f) => `[${f.severity}] ${f.code}`).join("; "),
      summary: (run.officerSummary?.sentences ?? []).map((s) => s.text).join(" "),
      seconds: Math.round((Date.now() - t0) / 1000),
      error: run.error ?? (run.results.filter((r) => r.status === "error" || r.status === "timeout").map((r) => `${r.agent}: ${r.error}`).join("; ") || undefined),
    };
  } catch (e) {
    return { folder, caseId: "-", status: "failed", lane: "-", types: "", names: "", findings: "", summary: "", seconds: Math.round((Date.now() - t0) / 1000), error: String(e instanceof Error ? e.message : e) };
  }
}

// small worker pool: Textract and Bedrock have per-account rate limits
const queue = [...folders];
await Promise.all(
  Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (let folder = queue.shift(); folder; folder = queue.shift()) {
      const row = await runOne(folder);
      rows.push(row);
      console.log(`${row.status === "completed" ? "✓" : "✗"} ${row.folder.padEnd(26)} ${row.lane.padEnd(18)} ${row.findings || "(no issues)"}${row.error ? `  ERROR: ${row.error}` : ""}`);
    }
  }),
);

rows.sort((a, b) => a.folder.localeCompare(b.folder));
const outDir = join(import.meta.dir, "..", "reports");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const base = join(outDir, `${basename(src)}-${workflow}-${stamp}`);
const csv = (v: string | number | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
writeFileSync(`${base}.csv`, ["folder,caseId,status,lane,documentTypes,namesRead,findings,officerSummary,seconds,error", ...rows.map((r) => [r.folder, r.caseId, r.status, r.lane, r.types, r.names, r.findings, r.summary, r.seconds, r.error].map(csv).join(","))].join("\n"));

const byLane = rows.reduce<Record<string, number>>((a, r) => ((a[r.lane] = (a[r.lane] ?? 0) + 1), a), {});
const byCode = rows.flatMap((r) => r.findings.split("; ").filter(Boolean)).reduce<Record<string, number>>((a, c) => ((a[c] = (a[c] ?? 0) + 1), a), {});
writeFileSync(
  `${base}.md`,
  [
    `# ${basename(src)} — ${workflow} batch (${new Date().toLocaleString("ro-RO")})`,
    "",
    "No answer key: the input data may itself be wrong. Review each flagged case in the web app (customer reference = folder name).",
    "",
    "## Lanes",
    ...Object.entries(byLane).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Findings (non-info) across all cases",
    ...Object.entries(byCode).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Per customer",
    "| Folder | Lane | Documents | Names read | Findings |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.folder} | ${r.lane} | ${r.types} | ${r.names} | ${r.error ? `ERROR: ${r.error}` : r.findings || "—"} |`),
  ].join("\n"),
);
console.log(`\nReport: ${base}.md\n        ${base}.csv`);
