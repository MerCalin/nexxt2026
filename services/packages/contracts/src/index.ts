import { z } from "zod";

// ---------- Enumerations ----------

export const Workflow = z.enum(["onboarding", "loan", "mortgage"]);
export type Workflow = z.infer<typeof Workflow>;

export const Role = z.enum(["credit_officer", "kyc_officer", "compliance"]);
export type Role = z.infer<typeof Role>;

export const DocType = z.enum([
  "id_card",
  "passport",
  "domicile_certificate",
  "utility_bill_water",
  "utility_bill_electricity",
  "utility_bill_rejected", // phone / internet / gas / TV — NOT acceptable proof of address
  "notary_contract",
  "bank_statement",
  "employment_contract",
  "payslip",
  "debt_declaration",
  "land_register_extract",
  "valuation_report",
  "unknown",
]);
export type DocType = z.infer<typeof DocType>;

export const Severity = z.enum(["info", "low", "medium", "high"]);
export type Severity = z.infer<typeof Severity>;

export const Visibility = z.enum(["all", "credit_kyc", "compliance"]);
export type Visibility = z.infer<typeof Visibility>;

export const AgentName = z.enum([
  "coordinator",
  "classification",
  "extraction",
  "document-verification",
  "cross-reference",
  "investigation",
  "risk-fraud",
  "triage",
  "summary-communication",
  "audit",
  "sanctions-pep",
  "aml-risk",
  "kyc-freshness",
  "credit-history",
  "affordability",
  "collateral",
  "bank-verification",
]);
export type AgentName = z.infer<typeof AgentName>;

// ---------- Geometry / OCR ----------

/** Normalised bounding box (0..1 relative to page), as returned by Textract. */
export const BBox = z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() });
export type BBox = z.infer<typeof BBox>;

export const OcrLine = z.object({ text: z.string(), bbox: BBox, confidence: z.number() });
export type OcrLine = z.infer<typeof OcrLine>;

export const OcrKeyValue = z.object({
  key: z.string(),
  value: z.string(),
  bbox: BBox,
  confidence: z.number(),
});
export type OcrKeyValue = z.infer<typeof OcrKeyValue>;

export const OcrQueryAnswer = z.object({
  alias: z.string(),
  answer: z.string(),
  bbox: BBox.optional(),
  confidence: z.number(),
});
export type OcrQueryAnswer = z.infer<typeof OcrQueryAnswer>;

export const OcrPage = z.object({
  page: z.number().int().positive(),
  lines: z.array(OcrLine),
  keyValues: z.array(OcrKeyValue),
  queries: z.array(OcrQueryAnswer),
  tables: z.array(z.array(z.array(z.string()))), // table -> row -> cell text
});
export type OcrPage = z.infer<typeof OcrPage>;

export const OcrResult = z.object({
  docId: z.string(),
  engine: z.string(), // e.g. "aws-textract"
  jobId: z.string().optional(),
  pages: z.array(OcrPage),
});
export type OcrResult = z.infer<typeof OcrResult>;

// ---------- Documents ----------

/** File-level technical metadata used by Risk & Fraud (PDF info dict, EXIF). */
export const FileMetadata = z.object({
  producer: z.string().optional(),
  creator: z.string().optional(),
  creationDate: z.string().optional(),
  modDate: z.string().optional(),
  incrementalUpdates: z.number().int().optional(),
  software: z.string().optional(),
  perceptualHash: z.string().optional(),
});
export type FileMetadata = z.infer<typeof FileMetadata>;

export const CaseDocument = z.object({
  id: z.string(),
  caseId: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  sha256: z.string(),
  storageKey: z.string(),
  sizeBytes: z.number().int(),
  uploadedAt: z.string(),
  metadata: FileMetadata.default({}),
  /** Optional chip/NFC read supplied by the staff app (e.g. eID reader). */
  chipRead: z.record(z.string(), z.string()).optional(),
});
export type CaseDocument = z.infer<typeof CaseDocument>;

// ---------- Evidence ----------

export const Fact = z.object({
  id: z.string(),
  docId: z.string(),
  docType: DocType,
  field: z.string(), // e.g. "fullName", "cnp", "address", "netSalary"
  value: z.string(), // exactly as read
  normalized: z.string(), // canonical form used for comparison
  page: z.number().int().positive(),
  bbox: BBox.optional(),
  ocrConfidence: z.number(),
  extractor: z.string(), // e.g. "textract-kv", "regex:cnp", "mrz"
});
export type Fact = z.infer<typeof Fact>;

export const ExternalCheckStatus = z.enum(["ok", "hit", "blocked", "unavailable"]);
export type ExternalCheckStatus = z.infer<typeof ExternalCheckStatus>;

export const ExternalCheck = z.object({
  id: z.string(),
  kind: z.string(), // "sanctions:eu", "crc", "anaf", "cazier", ...
  source: z.string(),
  simulated: z.boolean(),
  status: ExternalCheckStatus,
  reason: z.string().optional(),
  payload: z.unknown(),
  retrievedAt: z.string(),
  consentId: z.string().optional(),
  visibility: Visibility.default("all"),
});
export type ExternalCheck = z.infer<typeof ExternalCheck>;

/** A citation is the id of a Fact or of an ExternalCheck. */
export const Citation = z.string();
export type Citation = z.infer<typeof Citation>;

export const Finding = z.object({
  id: z.string(),
  code: z.string(), // e.g. XREF_NAME_MISMATCH
  severity: Severity,
  agent: AgentName,
  message: z.string(), // deterministic template text, never AI
  citations: z.array(Citation).min(1),
  values: z.array(z.string()).default([]),
  visibility: Visibility.default("all"),
  simulated: z.boolean().default(false),
});
export type Finding = z.infer<typeof Finding>;

// ---------- AI output ----------

export const AiSentence = z.object({ text: z.string().min(1), citations: z.array(Citation).min(1) });
export type AiSentence = z.infer<typeof AiSentence>;

export const AiText = z.object({
  sentences: z.array(AiSentence),
  modelId: z.string(),
  promptVersion: z.string(),
  /** true when the deterministic template was used instead of AI output. */
  fallback: z.boolean(),
  /** Why the template was used: the AI call itself failed, or its output was rejected by the guard. */
  fallbackReason: z.enum(["ai_call_failed", "validation_failed", "no_output"]).optional(),
  rejected: z.array(z.object({ text: z.string(), reason: z.string() })).default([]),
});
export type AiText = z.infer<typeof AiText>;

// ---------- Agent results ----------

export const AgentStatus = z.enum(["ok", "blocked", "error", "skipped", "timeout"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentResult = z.object({
  agent: AgentName,
  status: AgentStatus,
  findings: z.array(Finding).default([]),
  facts: z.array(Fact).default([]),
  checks: z.array(ExternalCheck).default([]),
  /** Agent-specific structured output (classification map, DTI calculation, AML score, ...). */
  data: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
});
export type AgentResult = z.infer<typeof AgentResult>;

// ---------- Consent (Phase 3) ----------

export const ConsentPurpose = z.enum(["criminal_record_lookup", "anaf_tax_debt_lookup", "credit_bureau_lookup"]);
export type ConsentPurpose = z.infer<typeof ConsentPurpose>;

export const Consent = z.object({
  id: z.string(),
  caseId: z.string(),
  purpose: ConsentPurpose,
  noticeVersion: z.string(), // version of the GDPR Art. 13 data-processing notice shown
  givenAt: z.string(),
  channel: z.enum(["branch_paper", "branch_tablet", "online"]),
  recordedBy: z.string(),
  withdrawnAt: z.string().optional(),
});
export type Consent = z.infer<typeof Consent>;

// ---------- Case, recommendation, decision ----------

export const Lane = z.enum(["ready_for_officer", "needs_info", "human_review"]);
export type Lane = z.infer<typeof Lane>;

/** Recommendation deliberately has no approve/reject field: AI never decides. */
export const Recommendation = z.object({
  lane: Lane,
  reasons: z.array(z.string()), // finding ids or rule ids
  rules: z.array(z.string()), // triage rule ids that fired
});
export type Recommendation = z.infer<typeof Recommendation>;

export const Decision = z.object({
  outcome: z.enum(["approved", "rejected", "info_requested"]),
  reason: z.string().min(10),
  officerId: z.string(),
  officerRole: Role,
  decidedAt: z.string(),
  runId: z.string(),
});
export type Decision = z.infer<typeof Decision>;

export const Subject = z.object({
  /** The staff system's customer reference; no PII required to create a case. */
  customerRef: z.string(),
  declaredName: z.string().optional(),
  declaredCnp: z.string().optional(),
  declaredCitizenship: z.string().optional(), // ISO 3166 alpha-3
  declaredSourceOfFunds: z.string().optional(),
  isFirstHome: z.boolean().optional(),
  loan: z
    .object({
      amount: z.number().positive(),
      currency: z.string().default("RON"),
      termMonths: z.number().int().positive(),
      annualRatePct: z.number().nonnegative(),
      purchasePrice: z.number().positive().optional(),
    })
    .optional(),
});
export type Subject = z.infer<typeof Subject>;

export const RunStatus = z.enum(["queued", "running", "completed", "failed"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const Run = z.object({
  id: z.string(),
  caseId: z.string(),
  status: RunStatus,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  results: z.array(AgentResult).default([]),
  /** Documents the OCR engine could not read in this run (the agents then had no text for them). */
  ocrFailures: z.array(z.object({ docId: z.string(), fileName: z.string(), error: z.string() })).default([]),
  recommendation: Recommendation.optional(),
  officerSummary: AiText.optional(),
  complianceSummary: AiText.optional(),
  customerMessage: AiText.optional(),
  investigation: AiText.optional(),
  error: z.string().optional(),
});
export type Run = z.infer<typeof Run>;

export const Case = z.object({
  id: z.string(),
  workflow: Workflow,
  subject: Subject,
  createdAt: z.string(),
  createdBy: z.string(),
  documents: z.array(CaseDocument).default([]),
  consents: z.array(Consent).default([]),
  runs: z.array(z.string()).default([]),
  decision: Decision.optional(),
});
export type Case = z.infer<typeof Case>;

// ---------- Audit ----------

export const AuditEntry = z.object({
  caseId: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.string(),
  actor: z.string(), // agent name or "officer:<id>" or "system"
  action: z.string(), // "agent.completed", "document.uploaded", "decision.recorded", ...
  /** Hashes and identifiers only — never document bodies (GDPR minimisation). */
  detail: z.record(z.string(), z.unknown()),
  prevHash: z.string(),
  hash: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const GENESIS_HASH = "0".repeat(64);

// ---------- Required documents per workflow (Phase 1) ----------

export type Requirement = { id: string; anyOf: DocType[]; optional?: boolean; label: string };

export const PROOF_OF_IDENTITY: DocType[] = ["id_card", "passport"];
export const PROOF_OF_ADDRESS: DocType[] = [
  "domicile_certificate",
  "utility_bill_water",
  "utility_bill_electricity",
  "notary_contract",
  "bank_statement", // accepted only if it shows the address — checked by classification
];

export const REQUIREMENTS: Record<Workflow, Requirement[]> = {
  onboarding: [
    { id: "identity", anyOf: PROOF_OF_IDENTITY, label: "Act de identitate (CI sau pașaport)" },
    { id: "residence", anyOf: PROOF_OF_ADDRESS, label: "Dovada reședinței legale" },
  ],
  loan: [
    { id: "identity", anyOf: PROOF_OF_IDENTITY, label: "Act de identitate (CI sau pașaport)" },
    { id: "residence", anyOf: PROOF_OF_ADDRESS, label: "Dovada reședinței legale" },
    { id: "employment", anyOf: ["employment_contract"], label: "Contract individual de muncă" },
    { id: "statement", anyOf: ["bank_statement"], label: "Extras de cont" },
    { id: "payslip", anyOf: ["payslip"], optional: true, label: "Fluturaș de salariu" },
    { id: "debts", anyOf: ["debt_declaration"], optional: true, label: "Declarație privind datoriile" },
  ],
  mortgage: [
    { id: "identity", anyOf: PROOF_OF_IDENTITY, label: "Act de identitate (CI sau pașaport)" },
    { id: "residence", anyOf: PROOF_OF_ADDRESS, label: "Dovada reședinței legale" },
    { id: "employment", anyOf: ["employment_contract"], label: "Contract individual de muncă" },
    { id: "statement", anyOf: ["bank_statement"], label: "Extras de cont" },
    { id: "payslip", anyOf: ["payslip"], optional: true, label: "Fluturaș de salariu" },
    { id: "debts", anyOf: ["debt_declaration"], optional: true, label: "Declarație privind datoriile" },
    { id: "land_register", anyOf: ["land_register_extract"], label: "Extras de carte funciară" },
    { id: "valuation", anyOf: ["valuation_report"], label: "Raport de evaluare" },
  ],
};
