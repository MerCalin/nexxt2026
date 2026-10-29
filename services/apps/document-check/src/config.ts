export type Config = {
  port: number;
  region: string;
  /** true only under the explicit non-EU demo override */
  allowNonEu: boolean;
  bucket: string;
  kmsKeyId?: string;
  casesTable: string;
  auditTable: string;
  bedrockModelId: string;
  /** HMAC key shared with the staff API (from Secrets Manager); signs the caller identity headers. */
  signingKey: string;
  scenarioFile: string;
  onpcsbFile?: string;
  sanctionsRefreshHours: number;
  maxUploadBytes: number;
};

const req = (env: Record<string, string | undefined>, k: string) => {
  const v = env[k];
  if (!v) throw new Error(`Missing required environment variable ${k}`);
  return v;
};

/** Value that must be set, verbatim, to run outside the EU. Only for demos with synthetic documents. */
export const NON_EU_DEMO_OVERRIDE = "demo-synthetic-data-only";

/**
 * Customer documents must stay in the EU (GDPR ch. V, BNR outsourcing rules). A non-EU region is
 * accepted only with the explicit demo override, never with NODE_ENV=production.
 */
export function checkRegion(region: string, env: Record<string, string | undefined>): { allowNonEu: boolean } {
  if (region.startsWith("eu-")) return { allowNonEu: false };
  if (env.ALLOW_NON_EU_REGION !== NON_EU_DEMO_OVERRIDE)
    throw new Error(`AWS_REGION must be an EU region (data residency), got ${region}. For a demo with synthetic documents only, set ALLOW_NON_EU_REGION=${NON_EU_DEMO_OVERRIDE}.`);
  if (env.NODE_ENV === "production") throw new Error("ALLOW_NON_EU_REGION is not permitted in production");
  return { allowNonEu: true };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const region = env.AWS_REGION ?? "eu-central-1";
  const { allowNonEu } = checkRegion(region, env);
  return {
    port: Number(env.PORT ?? 8080),
    region,
    allowNonEu,
    bucket: req(env, "DOC_BUCKET"),
    kmsKeyId: env.KMS_KEY_ID,
    casesTable: req(env, "CASES_TABLE"),
    auditTable: req(env, "AUDIT_TABLE"),
    bedrockModelId: env.BEDROCK_MODEL_ID ?? "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
    signingKey: req(env, "STAFF_API_SIGNING_KEY"),
    scenarioFile: env.SIMULATED_SCENARIOS_FILE ?? new URL("../../../fixtures/scenarios.json", import.meta.url).pathname,
    onpcsbFile: env.ONPCSB_LIST_FILE,
    sanctionsRefreshHours: Number(env.SANCTIONS_REFRESH_HOURS ?? 12),
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
  };
}
