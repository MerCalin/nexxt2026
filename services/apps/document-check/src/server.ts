/** Composition root: wires real AWS adapters, sanctions lists, simulated authorities and agents. */
import { BedrockAiAdapter, DynamoAuditStore, DynamoCaseStore, S3DocumentStore, TextractOcrAdapter } from "@dc/adapters-aws";
import { officialListSources, SanctionsListAdapter } from "@dc/adapters-sanctions";
import { createSimulatedAuthorities, loadScenarioFile } from "@dc/adapters-simulated";
import { createAffordabilityAgent } from "@dc/agent-affordability";
import { createAmlRiskAgent } from "@dc/agent-aml-risk";
import { createAuditLog } from "@dc/agent-audit";
import { createBankVerificationAgent } from "@dc/agent-bank-verification";
import { createClassificationAgent } from "@dc/agent-classification";
import { createCollateralAgent } from "@dc/agent-collateral";
import { createCoordinator } from "@dc/agent-coordinator";
import { createCreditHistoryAgent } from "@dc/agent-credit-history";
import { createCrossReferenceAgent } from "@dc/agent-cross-reference";
import { createDocumentVerificationAgent } from "@dc/agent-document-verification";
import { createExtractionAgent, EXTRACTION_QUERIES } from "@dc/agent-extraction";
import { createInvestigationAgent } from "@dc/agent-investigation";
import { createKycFreshnessAgent } from "@dc/agent-kyc-freshness";
import { createRiskFraudAgent } from "@dc/agent-risk-fraud";
import { createSanctionsPepAgent } from "@dc/agent-sanctions-pep";
import { createSummaryCommunicationAgent } from "@dc/agent-summary-communication";
import { createTriageAgent } from "@dc/agent-triage";
import type { Clock } from "@dc/ports";
import { SANCTIONS_MATCH_THRESHOLD } from "@dc/rules";
import { createApp } from "./app";
import { loadConfig } from "./config";

export async function compose(cfg = loadConfig()) {
  const clock: Clock = { now: () => new Date() };
  const documents = new S3DocumentStore({ region: cfg.region, bucket: cfg.bucket, kmsKeyId: cfg.kmsKeyId });
  const cases = new DynamoCaseStore({ region: cfg.region, table: cfg.casesTable }, documents);
  const audit = createAuditLog(new DynamoAuditStore({ region: cfg.region, table: cfg.auditTable }), clock);
  const ai = new BedrockAiAdapter({ region: cfg.region, modelId: cfg.bedrockModelId, allowNonEu: cfg.allowNonEu });
  if (cfg.allowNonEu)
    console.warn(JSON.stringify({ level: "warn", msg: `NON-EU REGION ${cfg.region}: demo override active — synthetic documents only, never real customer data` }));
  const ocr = new TextractOcrAdapter({ region: cfg.region, bucket: cfg.bucket });

  const sim = createSimulatedAuthorities(await loadScenarioFile(cfg.scenarioFile));
  const lists = officialListSources({ onpcsbFile: cfg.onpcsbFile }).map((s) => new SanctionsListAdapter(s, { refreshHours: cfg.sanctionsRefreshHours, threshold: SANCTIONS_MATCH_THRESHOLD.value }));
  // warm the list caches at startup so the first screening is not slow
  void Promise.all(lists.map((l) => l.status()));

  const coordinator = createCoordinator({
    agents: {
      classification: createClassificationAgent(),
      extraction: createExtractionAgent(),
      "document-verification": createDocumentVerificationAgent(),
      "cross-reference": createCrossReferenceAgent(),
      "risk-fraud": createRiskFraudAgent({ cases }),
      "sanctions-pep": createSanctionsPepAgent({ lists: [...lists, sim.pepList] }),
      "aml-risk": createAmlRiskAgent(),
      "kyc-freshness": createKycFreshnessAgent({ kyc: sim.kycStore }),
      "credit-history": createCreditHistoryAgent({ bureau: sim.creditBureau, ccr: sim.centralCreditRegister }),
      affordability: createAffordabilityAgent(),
      collateral: createCollateralAgent({ landRegister: sim.landRegister }),
      "bank-verification": createBankVerificationAgent({ criminalRecord: sim.criminalRecord, anaf: sim.anaf }),
      investigation: createInvestigationAgent({ ai }),
      triage: createTriageAgent(),
      "summary-communication": createSummaryCommunicationAgent({ ai }),
    },
    ocr,
    ocrQueries: EXTRACTION_QUERIES,
    documents,
    cases,
    audit,
    clock,
    modelId: ai.modelId,
  });

  const app = createApp({
    cases,
    documents,
    audit,
    clock,
    signingKey: cfg.signingKey,
    maxUploadBytes: cfg.maxUploadBytes,
    startRun: (caseId, runId) => {
      coordinator.run(caseId, runId).catch((e) => console.error(JSON.stringify({ level: "error", msg: "run crashed", caseId, runId, error: String(e) })));
    },
  });
  return { app, coordinator, cfg };
}

if (import.meta.main) {
  const { app, cfg } = await compose();
  Bun.serve({ port: cfg.port, fetch: app.fetch, maxRequestBodySize: cfg.maxUploadBytes + 1024 * 1024 });
  console.log(JSON.stringify({ level: "info", msg: "document-check service listening", port: cfg.port, region: cfg.region, model: cfg.bedrockModelId }));
}
