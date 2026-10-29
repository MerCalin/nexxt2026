import type { AgentName, DocType, ExternalCheck, Fact, Finding, OcrPage, Severity, Visibility } from "@dc/contracts";
import { sha256Hex } from "./canonical";

/** Deterministic finding id so reruns over the same evidence produce the same ids. */
export function makeFinding(f: {
  agent: AgentName;
  code: string;
  severity: Severity;
  message: string;
  citations: string[];
  values?: string[];
  visibility?: Visibility;
  simulated?: boolean;
}): Finding {
  if (f.citations.length === 0) throw new Error(`Finding ${f.code} has no citations`);
  const id = `${f.agent}:${f.code}:${sha256Hex(f.citations.join("|") + (f.values ?? []).join("|")).slice(0, 12)}`;
  return {
    id,
    code: f.code,
    severity: f.severity,
    agent: f.agent,
    message: f.message,
    citations: [...new Set(f.citations)],
    values: f.values ?? [],
    visibility: f.visibility ?? "all",
    simulated: f.simulated ?? false,
  };
}

export function makeFact(f: Omit<Fact, "id"> & { seq?: number }): Fact {
  const { seq, ...rest } = f;
  return { id: `${f.docId}:${f.field}${seq ? `#${seq}` : ""}`, ...rest };
}

export function makeCheck(c: Omit<ExternalCheck, "id" | "visibility"> & { visibility?: Visibility; key?: string }): ExternalCheck {
  const { key, ...rest } = c;
  return { id: `check:${c.kind}${key ? `:${key}` : ""}`, visibility: c.visibility ?? "all", ...rest };
}

export const factsOf = (facts: readonly Fact[], field: string, docTypes?: DocType[]) =>
  facts.filter((f) => f.field === field && (!docTypes || docTypes.includes(f.docType)));

export const firstFact = (facts: readonly Fact[], field: string, docTypes?: DocType[]) => factsOf(facts, field, docTypes)[0];

export const docTypeFact = (facts: readonly Fact[], docId: string) => facts.find((f) => f.docId === docId && f.field === "docType");

export const IDENTITY_DOCS: DocType[] = ["id_card", "passport"];

export const fullText = (pages: OcrPage[]) => pages.flatMap((p) => p.lines.map((l) => l.text)).join("\n");

export const severityRank: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };
