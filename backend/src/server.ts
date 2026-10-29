import { createApp } from "./app";
import { cognitoVerifier, devVerifier } from "./auth";
import { createServiceClient } from "./service-client";

const env = process.env;
const need = (k: string) => {
  const v = env[k];
  if (!v) throw new Error(`Missing required environment variable ${k}`);
  return v;
};

const region = env.AWS_REGION ?? "eu-central-1";
const verify =
  env.AUTH_MODE === "dev"
    ? devVerifier()
    : cognitoVerifier({ region, userPoolId: need("COGNITO_USER_POOL_ID"), clientId: need("COGNITO_CLIENT_ID") });

const service = createServiceClient({
  baseUrl: need("DOC_CHECK_SERVICE_URL"),
  signingKey: need("STAFF_API_SIGNING_KEY"),
  latticeAuth: env.LATTICE_AUTH === "none" ? "none" : "sigv4",
  region,
});

const app = createApp({ verify, service });
const port = Number(env.PORT ?? 3001);
Bun.serve({ port, fetch: app.fetch, maxRequestBodySize: 12 * 1024 * 1024 });
console.log(JSON.stringify({ level: "info", msg: "staff API listening", port, auth: env.AUTH_MODE === "dev" ? "dev" : "cognito" }));
