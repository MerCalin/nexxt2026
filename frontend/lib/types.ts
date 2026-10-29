/** Wire types returned by the staff API (mirrors services/packages/contracts). */
export type Role = "credit_officer" | "kyc_officer" | "compliance";
export type Workflow = "onboarding" | "loan" | "mortgage";
export type Severity = "info" | "low" | "medium" | "high";
export type Lane = "ready_for_officer" | "needs_info" | "human_review";

export type BBox = { left: number; top: number; width: number; height: number };
export type Fact = { id: string; docId: string; docType: string; field: string; value: string; normalized: string; page: number; bbox?: BBox; ocrConfidence: number; extractor: string };
export type ExternalCheck = { id: string; kind: string; source: string; simulated: boolean; status: "ok" | "hit" | "blocked" | "unavailable"; reason?: string; payload: unknown; retrievedAt: string; consentId?: string };
export type Finding = { id: string; code: string; severity: Severity; agent: string; message: string; citations: string[]; values: string[]; visibility: string; simulated: boolean };
export type AgentResult = { agent: string; status: string; findings: Finding[]; facts: Fact[]; checks: ExternalCheck[]; data?: unknown; error?: string; startedAt: string; finishedAt: string };
export type AiText = {
  sentences: { text: string; citations: string[] }[];
  modelId: string;
  promptVersion: string;
  fallback: boolean;
  fallbackReason?: "ai_call_failed" | "validation_failed" | "no_output";
  rejected: { text: string; reason: string }[];
};
export type Run = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  results: AgentResult[];
  ocrFailures?: { docId: string; fileName: string; error: string }[];
  recommendation?: { lane: Lane; reasons: string[]; rules: string[] };
  officerSummary?: AiText;
  complianceSummary?: AiText;
  customerMessage?: AiText;
  investigation?: AiText;
  error?: string;
};
export type CaseDocument = { id: string; fileName: string; contentType: string; sha256: string; sizeBytes: number; uploadedAt: string };
export type Consent = { id: string; purpose: string; noticeVersion: string; givenAt: string; channel: string; recordedBy: string; withdrawnAt?: string };
export type Decision = { outcome: "approved" | "rejected" | "info_requested"; reason: string; officerId: string; officerRole: Role; decidedAt: string };
export type Case = {
  id: string;
  workflow: Workflow;
  subject: { customerRef: string; isFirstHome?: boolean; declaredSourceOfFunds?: string; loan?: { amount: number; currency: string; termMonths: number; annualRatePct: number; purchasePrice?: number } };
  createdAt: string;
  createdBy: string;
  documents: CaseDocument[];
  consents: Consent[];
  runs: string[];
  decision?: Decision;
};
export type Requirement = { id: string; anyOf: string[]; optional?: boolean; label: string };
export type CaseView = { case: Case; run?: Run; requirements: Requirement[] };
export type CaseListItem = { id: string; workflow: Workflow; customerRef: string; createdAt: string; documents: number; runs: number; decision?: string };
export type AuditEntry = { seq: number; at: string; actor: string; action: string; detail: Record<string, unknown>; hash: string };
