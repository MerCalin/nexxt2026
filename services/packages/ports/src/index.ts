import type {
  AgentName,
  AgentResult,
  AuditEntry,
  Case,
  CaseDocument,
  ExternalCheck,
  Fact,
  Finding,
  OcrResult,
  Run,
} from "@dc/contracts";

// =====================================================================
// AI boundary — the ONLY way any code reaches a language model.
// Provider-neutral: the Bedrock adapter implements it today.
// =====================================================================

export type AiContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export type AiMessage = { role: "user" | "assistant"; content: AiContent[] };

export type AiTool = {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  inputSchema: Record<string, unknown>;
};

export type AiRequest = {
  system: string;
  messages: AiMessage[];
  tools?: AiTool[];
  maxTokens: number;
  temperature?: number;
};

export type AiResponse = {
  content: AiContent[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "other";
  usage: { inputTokens: number; outputTokens: number };
};

export interface AiPort {
  readonly modelId: string;
  converse(req: AiRequest, signal?: AbortSignal): Promise<AiResponse>;
}

// =====================================================================
// Documents and OCR
// =====================================================================

export type OcrQuery = { alias: string; text: string };

export interface OcrPort {
  analyze(
    input: { docId: string; storageKey: string; contentType: string; queries?: OcrQuery[] },
    signal?: AbortSignal,
  ): Promise<OcrResult>;
}

export interface DocumentStorePort {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  putJson(key: string, value: unknown): Promise<void>;
  getJson<T>(key: string): Promise<T | undefined>;
}

export interface CaseStorePort {
  createCase(c: Case): Promise<void>;
  getCase(id: string): Promise<Case | undefined>;
  putCase(c: Case): Promise<void>;
  listCases(limit: number): Promise<Case[]>;
  putRun(r: Run): Promise<void>;
  getRun(id: string): Promise<Run | undefined>;
  /** Cross-case lookup used by Risk & Fraud to detect reused templates. */
  findByPerceptualHash(hash: string): Promise<{ caseId: string; docId: string }[]>;
  indexPerceptualHash(hash: string, caseId: string, docId: string): Promise<void>;
}

/** Raw append-only storage. Hash-chaining is done by the audit agent. */
export interface AuditStorePort {
  /** Must fail (throw AuditConflictError) if an entry with this seq already exists. */
  append(entry: AuditEntry): Promise<void>;
  list(caseId: string): Promise<AuditEntry[]>;
  head(caseId: string): Promise<AuditEntry | undefined>;
}

export class AuditConflictError extends Error {}

export type AuditVerification =
  | { valid: true; entries: number; headHash: string }
  | { valid: false; entries: number; brokenAtSeq: number; reason: string };

/** Hash-chained audit log (implemented by the audit agent). */
export interface AuditLog {
  append(caseId: string, actor: string, action: string, detail: Record<string, unknown>): Promise<AuditEntry>;
  list(caseId: string): Promise<AuditEntry[]>;
  verify(caseId: string): Promise<AuditVerification>;
}

// =====================================================================
// External sources (sanctions lists, Romanian authorities)
// =====================================================================

export type SourceMeta = {
  source: string;
  simulated: boolean;
  retrievedAt: string;
};

export type AuthorityResult<T> =
  | (SourceMeta & { status: "ok"; data: T })
  | (SourceMeta & { status: "unavailable"; reason: string });

export type SanctionsListId = "eu" | "un" | "ofac" | "onpcsb";

export type SanctionsQuery = { fullName: string; birthDate?: string; citizenship?: string };

export type SanctionsMatch = {
  listId: string;
  entryId: string;
  matchedName: string;
  score: number; // 0..1
  birthDates: string[];
  citizenships: string[];
  programme?: string;
};

export type ListStatus = {
  listId: string;
  status: "ok" | "unavailable";
  version?: string;
  fetchedAt?: string;
  entries?: number;
  reason?: string;
  simulated: boolean;
};

export interface SanctionsListPort {
  readonly listId: SanctionsListId | "pep";
  status(): Promise<ListStatus>;
  search(q: SanctionsQuery): Promise<SanctionsMatch[]>;
}

export type CreditRecord = {
  lender: string;
  product: "loan" | "mortgage" | "credit_card" | "overdraft" | "leasing" | "guarantee";
  role: "debtor" | "co_debtor" | "guarantor";
  currency: string;
  outstanding: number;
  monthlyInstalment: number;
  status: "current" | "overdue" | "closed" | "written_off";
  daysPastDue: number;
  openedAt: string;
  closedAt?: string;
};

export type CreditReport = { records: CreditRecord[]; insolvency: boolean; inquiriesLast6m?: number };

/** Biroul de Credit (private credit bureau). */
export interface CreditBureauPort {
  report(cnp: string, consentId: string): Promise<AuthorityResult<CreditReport>>;
}

/** Centrala Riscului de Credit (CRC) — BNR's central credit register. */
export interface CentralCreditRegisterPort {
  report(cnp: string, consentId: string): Promise<AuthorityResult<CreditReport>>;
}

export type TaxDebt = { hasDebt: boolean; amountRon: number; asOf: string };
export interface AnafPort {
  taxDebt(cnp: string, consentId: string): Promise<AuthorityResult<TaxDebt>>;
}

export type CriminalRecord = { hasRecord: boolean; entries: { offence: string; date: string; final: boolean }[] };
export interface CriminalRecordPort {
  lookup(cnp: string, consentId: string): Promise<AuthorityResult<CriminalRecord>>;
}

export type LandRegisterRecord = {
  cadastralNumber: string;
  carteFunciaraNumber: string;
  uat: string;
  owners: { name: string; share: string }[];
  encumbrances: { type: string; holder: string; registeredAt: string }[];
};
export interface LandRegisterPort {
  lookup(cadastralNumber: string): Promise<AuthorityResult<LandRegisterRecord>>;
}

export type KycRecord = {
  customerRef: string;
  fullName: string;
  cnp: string;
  address: string;
  idDocumentNumber: string;
  idDocumentExpiry: string;
  riskLevel: "low" | "medium" | "high";
  lastReviewAt: string;
};
export interface KycStorePort {
  get(customerRef: string): Promise<AuthorityResult<KycRecord | null>>;
}

export interface Clock {
  now(): Date;
}

// =====================================================================
// Agent contract
// =====================================================================

export type AgentContext = {
  readonly case: Case;
  readonly runId: string;
  readonly ocr: Readonly<Record<string, OcrResult>>;
  /** Results of agents that already ran in this run (read-only snapshot). */
  readonly results: Readonly<Partial<Record<AgentName, AgentResult>>>;
  readonly facts: readonly Fact[];
  readonly findings: readonly Finding[];
  readonly checks: readonly ExternalCheck[];
  readonly now: Date;
  readonly signal: AbortSignal;
};

export type AgentOutput = Pick<AgentResult, "status"> &
  Partial<Pick<AgentResult, "findings" | "facts" | "checks" | "data" | "error">>;

export interface Agent {
  readonly name: AgentName;
  run(ctx: AgentContext): Promise<AgentOutput>;
}

export type { CaseDocument };
