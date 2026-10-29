/**
 * READ-ONLY survey of a folder of customer folders (e.g. the hackathon set): which customers are
 * internally consistent ("clean") and which contain which faults ("unclean").
 *
 * - OCR: AWS Textract DetectDocumentText (plain text, ~$0.0015/page; PDFs via a temporary S3 object
 *   that is deleted afterwards). Results are cached in reports/survey-cache/, so reruns are free.
 * - Form fields are reconstructed from the text layout ("Label: value" on one line, or a label with
 *   its value directly below) — an approximation of Textract FORMS, good enough for sorting.
 * - Runs the app's deterministic agents only (classification, extraction, document verification,
 *   cross-reference, risk & fraud). No AI, no cases created, nothing written to the app's database.
 *
 *   source ~/doccheck.env
 *   bun scripts/survey-folder.ts --src ~/Downloads/hackerton [--limit N] [--concurrency 4]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { type Block, DetectDocumentTextCommand, GetDocumentTextDetectionCommand, StartDocumentTextDetectionCommand, TextractClient } from "@aws-sdk/client-textract";
import { createClassificationAgent } from "@dc/agent-classification";
import { createCrossReferenceAgent } from "@dc/agent-cross-reference";
import { createDocumentVerificationAgent } from "@dc/agent-document-verification";
import { createExtractionAgent } from "@dc/agent-extraction";
import { createRiskFraudAgent } from "@dc/agent-risk-fraud";
import type { CaseDocument, Finding, OcrLine, OcrPage, OcrResult, Workflow } from "@dc/contracts";
import type { CaseStorePort } from "@dc/ports";
import { doc, makeCase, runChain } from "@dc/testkit";
import { extractFileMetadata } from "../apps/document-check/src/file-metadata";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : d;
};
const src = arg("--src");
if (!src) throw new Error("usage: bun scripts/survey-folder.ts --src <folder> [--limit N] [--concurrency 4]");
const limit = Number(arg("--limit", "0"));
const concurrency = Number(arg("--concurrency", "4"));
const region = process.env.AWS_REGION ?? "eu-central-1";
const bucket = process.env.DOC_BUCKET;

const textract = new TextractClient({ region });
const s3 = new S3Client({ region });
const outDir = join(import.meta.dir, "..", "reports");
const cacheDir = join(outDir, "survey-cache");
mkdirSync(cacheDir, { recursive: true });

// ---------------------------------------------------------------- OCR (cached)

async function detect(bytes: Uint8Array, isPdf: boolean): Promise<Block[]> {
  if (!isPdf) return (await textract.send(new DetectDocumentTextCommand({ Document: { Bytes: bytes } }))).Blocks ?? [];
  if (!bucket) throw new Error("DOC_BUCKET is needed for PDFs (temporary upload)");
  const key = `survey-tmp/${createHash("sha256").update(bytes).digest("hex")}.pdf`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: "application/pdf" }));
  try {
    const { JobId } = await textract.send(new StartDocumentTextDetectionCommand({ DocumentLocation: { S3Object: { Bucket: bucket, Name: key } } }));
    const blocks: Block[] = [];
    for (let i = 0; i < 120; i++) {
      await Bun.sleep(1500);
      const r = await textract.send(new GetDocumentTextDetectionCommand({ JobId }));
      if (r.JobStatus === "IN_PROGRESS") continue;
      if (r.JobStatus !== "SUCCEEDED" && r.JobStatus !== "PARTIAL_SUCCESS") throw new Error(`Textract ${r.JobStatus}: ${r.StatusMessage ?? ""}`);
      blocks.push(...(r.Blocks ?? []));
      for (let next = r.NextToken; next; ) {
        const more = await textract.send(new GetDocumentTextDetectionCommand({ JobId, NextToken: next }));
        blocks.push(...(more.Blocks ?? []));
        next = more.NextToken;
      }
      return blocks;
    }
    throw new Error("Textract job timed out");
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
  }
}

async function ocrFile(path: string, docId: string): Promise<{ ocr: OcrResult; bytes: Uint8Array; sha: string }> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex");
  const cached = Bun.file(join(cacheDir, `${sha}.json`));
  let lines: (OcrLine & { page: number })[];
  if (await cached.exists()) lines = await cached.json();
  else {
    const blocks = await detect(bytes, path.toLowerCase().endsWith(".pdf"));
    lines = blocks
      .filter((b) => b.BlockType === "LINE")
      .map((b) => {
        const g = b.Geometry?.BoundingBox;
        return { text: b.Text ?? "", confidence: b.Confidence ?? 0, page: b.Page ?? 1, bbox: { left: g?.Left ?? 0, top: g?.Top ?? 0, width: g?.Width ?? 0, height: g?.Height ?? 0 } };
      });
    writeFileSync(join(cacheDir, `${sha}.json`), JSON.stringify(lines));
  }
  return { ocr: { docId, engine: "textract-detect-text", pages: toPages(docId, lines) }, bytes, sha };
}

/** Rebuild key-value pairs from layout: "Label: value" on one line, or a short label line with its value right below it. */
function toPages(_docId: string, lines: (OcrLine & { page: number })[]): OcrPage[] {
  const byPage = new Map<number, (OcrLine & { page: number })[]>();
  for (const l of lines) byPage.set(l.page, [...(byPage.get(l.page) ?? []), l]);
  return [...byPage.entries()].map(([page, ls]) => {
    const keyValues: OcrPage["keyValues"] = [];
    for (const l of ls) {
      const m = l.text.match(/^([^:]{2,40}):\s*(.+)$/);
      if (m) {
        keyValues.push({ key: `${m[1]}:`, value: m[2]!.trim(), bbox: l.bbox, confidence: l.confidence });
        continue;
      }
      const t = l.text.trim();
      const isLabel = /^[A-ZĂÂÎȘȚ][A-ZĂÂÎȘȚa-zăâîșț ./]{1,30}:?$/.test(t) && (t === t.toUpperCase() || t.endsWith(":"));
      if (!isLabel) continue;
      const midY = (b: OcrLine["bbox"]) => b.top + b.height / 2;
      // "Nume:   Badea" — value on the same row, to the right (ID-card table layout)
      const right = t.endsWith(":")
        ? ls
            .filter((o) => o !== l && o.bbox.left > l.bbox.left + l.bbox.width - 0.01 && Math.abs(midY(o.bbox) - midY(l.bbox)) < Math.max(l.bbox.height, o.bbox.height) * 0.6)
            .sort((a, b) => a.bbox.left - b.bbox.left)[0]
        : undefined;
      // "SURNAME" with the value right below it (passport layout)
      const below = ls
        .filter((o) => o !== l && o.bbox.top > l.bbox.top && o.bbox.top - l.bbox.top < 0.09 && Math.abs(o.bbox.left - l.bbox.left) < 0.04)
        .sort((a, b) => a.bbox.top - b.bbox.top)[0];
      const value = right ?? below;
      if (value) keyValues.push({ key: t, value: value.text.trim(), bbox: value.bbox, confidence: value.confidence });
    }
    return { page, lines: ls.map(({ page: _p, ...x }) => x), keyValues, queries: [], tables: [rows(ls)] };
  });
}

/** Group text lines into table rows by vertical position (left to right), so "date | description | amount" become one row. */
function rows(ls: OcrLine[]): string[][] {
  const sorted = [...ls].sort((a, b) => a.bbox.top + a.bbox.height / 2 - (b.bbox.top + b.bbox.height / 2));
  const out: OcrLine[][] = [];
  for (const l of sorted) {
    const mid = l.bbox.top + l.bbox.height / 2;
    const row = out.at(-1);
    const rowMid = row ? row.reduce((a, x) => a + x.bbox.top + x.bbox.height / 2, 0) / row.length : -1;
    if (row && Math.abs(mid - rowMid) < l.bbox.height * 0.6) row.push(l);
    else out.push([l]);
  }
  return out.map((r) => r.sort((a, b) => a.bbox.left - b.bbox.left).map((x) => x.text));
}

// ---------------------------------------------------------------- analysis

const noReuse = { findByPerceptualHash: async () => [] } as unknown as CaseStorePort;
const agents = () => [createClassificationAgent(), createExtractionAgent(), createDocumentVerificationAgent(), createCrossReferenceAgent(), createRiskFraudAgent({ cases: noReuse })];

type FolderResult = {
  folder: string;
  types: string;
  names: string;
  cnps: string;
  kycFindings: Finding[];
  loanFindings: Finding[];
  error?: string;
};

async function analyse(folder: string): Promise<FolderResult> {
  const dir = join(src!, folder);
  const files = readdirSync(dir).filter((f) => /\.(pdf|png|jpe?g|tiff?)$/i.test(f)).sort();
  try {
    const docs: CaseDocument[] = [];
    const ocr: Record<string, OcrResult> = {};
    for (const f of files) {
      const id = f.replace(/\.[^.]+$/, "");
      const r = await ocrFile(join(dir, f), id);
      const ct = f.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/png";
      docs.push(doc(id, { fileName: f, contentType: ct, sha256: r.sha, metadata: extractFileMetadata(r.bytes, ct) }));
      ocr[id] = r.ocr;
    }
    const run = async (wf: Workflow, ds: CaseDocument[]) => (await runChain(makeCase(wf, ds), ocr, agents(), new Date())).ctx;
    const kycDocs = docs.filter((d) => /^[123]_/.test(d.fileName));
    const loan = await run("loan", docs);
    const kyc = await run("onboarding", kycDocs);
    const facts = loan.facts;
    const pick = (field: string) =>
      facts
        .filter((f) => f.field === field)
        .map((f) => `${f.docId.replace(/^\d_/, "")}=${f.value}`)
        .join("; ");
    return {
      folder,
      types: facts.filter((f) => f.field === "docType" && f.docId !== "case").map((f) => `${f.docId.replace(/^\d_/, "")}=${f.value}`).join(", "),
      names: pick("fullName"),
      cnps: pick("cnp"),
      kycFindings: kyc.findings.filter((f) => f.severity !== "info"),
      loanFindings: loan.findings.filter((f) => f.severity !== "info"),
    };
  } catch (e) {
    return { folder, types: "", names: "", cnps: "", kycFindings: [], loanFindings: [], error: String(e instanceof Error ? e.message : e) };
  }
}

let folders = readdirSync(src).filter((d) => statSync(join(src, d)).isDirectory()).sort();
if (limit > 0) folders = folders.slice(0, limit);
console.log(`Surveying ${folders.length} folders from ${src} (${region}) with ${concurrency} workers…`);
const results: FolderResult[] = [];
const queue = [...folders];
let done = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      results.push(await analyse(f));
      if (++done % 10 === 0 || done === folders.length) console.log(`  ${done}/${folders.length}`);
    }
  }),
);
results.sort((a, b) => a.folder.localeCompare(b.folder));

// Codes present in (almost) every folder are properties of the data set's templates, not of a customer.
const share = (key: "kycFindings" | "loanFindings") => {
  const counts = new Map<string, number>();
  for (const r of results) for (const c of new Set(r[key].map((f) => f.code))) counts.set(c, (counts.get(c) ?? 0) + 1);
  return counts;
};
const kycCounts = share("kycFindings");
const loanCounts = share("loanFindings");
const ok = results.filter((r) => !r.error).length || 1;
const datasetWide = (counts: Map<string, number>) => new Set([...counts].filter(([, n]) => n / ok >= 0.9).map(([c]) => c));
const kycWide = datasetWide(kycCounts);
const loanWide = datasetWide(loanCounts);
const specific = (fs: Finding[], wide: Set<string>) => fs.filter((f) => !wide.has(f.code));

const kycClean = results.filter((r) => !r.error && specific(r.kycFindings, kycWide).length === 0);
const loanClean = results.filter((r) => !r.error && specific(r.loanFindings, loanWide).length === 0);
const byCode = new Map<string, string[]>();
for (const r of results) for (const c of new Set(specific(r.loanFindings, loanWide).map((f) => f.code))) byCode.set(c, [...(byCode.get(c) ?? []), r.folder]);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const base = join(outDir, `survey-${basename(src)}-${stamp}`);
const fmtCounts = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([c, n]) => `- ${c}: ${n}/${ok}`).join("\n");
const md = [
  `# Survey of ${basename(src)} (${results.length} folders, ${new Date().toLocaleString("ro-RO")})`,
  "",
  "OCR = Textract plain-text detection with reconstructed form fields; deterministic agents only (no AI).",
  "Confirm chosen folders with a real run in the app before relying on them.",
  "",
  "## Data-set-wide findings (≥ 90 % of folders — template properties, ignored when sorting)",
  `KYC: ${[...kycWide].join(", ") || "none"}`,
  `Loan: ${[...loanWide].join(", ") || "none"}`,
  "",
  `## Clean for KYC (identity + residence consistent): ${kycClean.length}`,
  kycClean.map((r) => `- ${r.folder}`).join("\n") || "- none",
  "",
  `## Clean for a loan (all four documents consistent): ${loanClean.length}`,
  loanClean.map((r) => `- ${r.folder}`).join("\n") || "- none",
  "",
  "## Unclean, by fault (loan view, all documents)",
  ...[...byCode].sort((a, b) => b[1].length - a[1].length).map(([c, fs]) => `### ${c} (${fs.length})\n${fs.map((f) => `- ${f}`).join("\n")}`),
  "",
  "## All finding codes",
  "### KYC view",
  fmtCounts(kycCounts),
  "### Loan view",
  fmtCounts(loanCounts),
  "",
  "## Per folder",
  "| Folder | Documents | Names read | CNPs read | Customer-specific findings (loan view) |",
  "|---|---|---|---|---|",
  ...results.map((r) => `| ${r.folder} | ${r.types} | ${r.names} | ${r.cnps} | ${r.error ? `ERROR: ${r.error}` : specific(r.loanFindings, loanWide).map((f) => `[${f.severity}] ${f.code}`).join("; ") || "—"} |`),
].join("\n");
writeFileSync(`${base}.md`, md);
writeFileSync(
  `${base}.json`,
  JSON.stringify(results.map((r) => ({ ...r, kycSpecific: specific(r.kycFindings, kycWide).map((f) => ({ code: f.code, severity: f.severity, message: f.message })), loanSpecific: specific(r.loanFindings, loanWide).map((f) => ({ code: f.code, severity: f.severity, message: f.message })), kycFindings: undefined, loanFindings: undefined })), null, 1),
);
console.log(`\nClean KYC: ${kycClean.length}   clean loan: ${loanClean.length}   errors: ${results.filter((r) => r.error).length}`);
console.log(`Report: ${base}.md`);
