import {
  AnalyzeDocumentCommand,
  type Block,
  type FeatureType,
  GetDocumentAnalysisCommand,
  type Query,
  StartDocumentAnalysisCommand,
  TextractClient,
} from "@aws-sdk/client-textract";
import type { BBox, OcrPage, OcrResult } from "@dc/contracts";
import type { OcrPort, OcrQuery } from "@dc/ports";

export type TextractConfig = { region: string; bucket: string; pollIntervalMs?: number; maxWaitMs?: number };

const bboxOf = (b: Block | undefined): BBox => {
  const g = b?.Geometry?.BoundingBox;
  return { left: g?.Left ?? 0, top: g?.Top ?? 0, width: g?.Width ?? 0, height: g?.Height ?? 0 };
};

/** Query text restricted to printable ASCII: Romanian diacritics folded (ă→a, ș→s, ț→t), anything else dropped. */
export const asciiQuery = (s: string) =>
  s
    .replace(/[șşȘŞ]/g, (c) => (c === c.toLowerCase() ? "s" : "S"))
    .replace(/[țţȚŢ]/g, (c) => (c === c.toLowerCase() ? "t" : "T"))
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, 200);

/** Turn the flat Textract block graph into pages of lines / key-values / query answers / tables. */
export function blocksToPages(blocks: Block[]): OcrPage[] {
  const byId = new Map(blocks.filter((b) => b.Id).map((b) => [b.Id!, b]));
  const pages = new Map<number, OcrPage>();
  const page = (n: number | undefined) => {
    const k = n ?? 1;
    if (!pages.has(k)) pages.set(k, { page: k, lines: [], keyValues: [], queries: [], tables: [] });
    return pages.get(k)!;
  };
  const childIds = (b: Block, type: string) => b.Relationships?.filter((r) => r.Type === type).flatMap((r) => r.Ids ?? []) ?? [];
  const textOf = (b: Block | undefined): string => {
    if (!b) return "";
    const words = childIds(b, "CHILD")
      .map((id) => byId.get(id))
      .map((w) => (w?.BlockType === "SELECTION_ELEMENT" ? (w.SelectionStatus === "SELECTED" ? "[X]" : "") : (w?.Text ?? "")))
      .filter(Boolean);
    return words.join(" ");
  };

  for (const b of blocks) {
    if (b.BlockType === "LINE") {
      page(b.Page).lines.push({ text: b.Text ?? "", bbox: bboxOf(b), confidence: b.Confidence ?? 0 });
    } else if (b.BlockType === "KEY_VALUE_SET" && b.EntityTypes?.includes("KEY")) {
      const valueBlock = childIds(b, "VALUE").map((id) => byId.get(id))[0];
      page(b.Page).keyValues.push({
        key: textOf(b),
        value: textOf(valueBlock),
        bbox: bboxOf(valueBlock ?? b),
        confidence: Math.min(b.Confidence ?? 0, valueBlock?.Confidence ?? 0),
      });
    } else if (b.BlockType === "QUERY") {
      const ans = childIds(b, "ANSWER").map((id) => byId.get(id))[0];
      page(b.Page).queries.push({
        alias: b.Query?.Alias ?? b.Query?.Text ?? "",
        answer: ans?.Text ?? "",
        bbox: ans ? bboxOf(ans) : undefined,
        confidence: ans?.Confidence ?? 0,
      });
    } else if (b.BlockType === "TABLE") {
      const cells = childIds(b, "CHILD")
        .map((id) => byId.get(id))
        .filter((c): c is Block => c?.BlockType === "CELL");
      const rows: string[][] = [];
      for (const c of cells) {
        const r = (c.RowIndex ?? 1) - 1;
        const col = (c.ColumnIndex ?? 1) - 1;
        rows[r] ??= [];
        rows[r]![col] = textOf(c);
      }
      page(b.Page).tables.push(rows.map((r) => Array.from(r ?? [], (x) => x ?? "")));
    }
  }
  return [...pages.values()].sort((a, b) => a.page - b.page);
}

/**
 * OcrPort on AWS Textract (eu-central-1). Images use synchronous AnalyzeDocument;
 * PDFs use asynchronous StartDocumentAnalysis so multi-page statements and contracts work.
 * Documents are read from S3 — bytes never leave the bank's AWS account.
 */
export class TextractOcrAdapter implements OcrPort {
  private client: TextractClient;
  constructor(
    private cfg: TextractConfig,
    client?: TextractClient,
  ) {
    this.client = client ?? new TextractClient({ region: cfg.region });
  }

  async analyze(
    input: { docId: string; storageKey: string; contentType: string; queries?: OcrQuery[] },
    signal?: AbortSignal,
  ): Promise<OcrResult> {
    const s3Object = { Bucket: this.cfg.bucket, Name: input.storageKey };
    // Textract rejects query text with non-ASCII characters ("Request has invalid parameters"): fold Romanian diacritics
    const queries: Query[] | undefined = input.queries?.slice(0, 15).map((q) => ({ Text: asciiQuery(q.text), Alias: q.alias }));
    const features: FeatureType[] = ["FORMS", "TABLES", ...(queries?.length ? (["QUERIES"] as const) : [])];

    if (input.contentType !== "application/pdf") {
      // single-page images: queries apply to page 1 by default, so no Pages parameter
      const out = await this.client.send(
        new AnalyzeDocumentCommand({
          Document: { S3Object: s3Object },
          FeatureTypes: features,
          ...(queries?.length ? { QueriesConfig: { Queries: queries } } : {}),
        }),
        { abortSignal: signal },
      );
      return { docId: input.docId, engine: "aws-textract", pages: blocksToPages(out.Blocks ?? []) };
    }

    const start = await this.client.send(
      new StartDocumentAnalysisCommand({
        DocumentLocation: { S3Object: s3Object },
        FeatureTypes: features,
        // multi-page PDFs: ask every query on every page
        ...(queries?.length ? { QueriesConfig: { Queries: queries.map((q) => ({ ...q, Pages: ["*"] })) } } : {}),
      }),
      { abortSignal: signal },
    );
    const jobId = start.JobId!;
    const deadline = Date.now() + (this.cfg.maxWaitMs ?? 120_000);
    const interval = this.cfg.pollIntervalMs ?? 1500;
    const blocks: Block[] = [];
    for (;;) {
      if (signal?.aborted) throw new Error("Textract analysis aborted");
      if (Date.now() > deadline) throw new Error(`Textract job ${jobId} timed out`);
      await Bun.sleep(interval);
      const first = await this.client.send(new GetDocumentAnalysisCommand({ JobId: jobId }), { abortSignal: signal });
      if (first.JobStatus === "IN_PROGRESS") continue;
      if (first.JobStatus !== "SUCCEEDED" && first.JobStatus !== "PARTIAL_SUCCESS") {
        throw new Error(`Textract job ${jobId} ${first.JobStatus}: ${first.StatusMessage ?? ""}`);
      }
      blocks.push(...(first.Blocks ?? []));
      let next = first.NextToken;
      while (next) {
        const more = await this.client.send(new GetDocumentAnalysisCommand({ JobId: jobId, NextToken: next }), {
          abortSignal: signal,
        });
        blocks.push(...(more.Blocks ?? []));
        next = more.NextToken;
      }
      break;
    }
    return { docId: input.docId, engine: "aws-textract", jobId, pages: blocksToPages(blocks) };
  }
}
