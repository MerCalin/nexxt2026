# Document-check service (Romania — onboarding/KYC and loans)

The bank's staff app calls this service to cross-check a customer's documents. Deterministic rules
detect mismatches. AI is reached through one provider-neutral boundary (`AiPort`, backed by AWS
Bedrock in eu-central-1) and is used only to explain and summarise the findings, always with
citations. A human officer makes every decision.

```
/                 staff web app (TanStack Start + React 19 + Tailwind v4) — talks only to /api
backend/          staff API (Bun + Hono) — Cognito auth, the only caller of the service
services/         document-check service (Bun workspaces)
  packages/contracts, ports, rules, ai-kit
  packages/adapters-aws        Bedrock (Converse), Textract, S3, DynamoDB
  packages/adapters-sanctions  real EU FSF, UN and OFAC list files; ONPCSB export
  packages/adapters-simulated  CRC, Biroul de Credit, ANAF, cazier, ANCPI, KYC store, PEP — SIMULATED
  packages/agents/*            17 agents; never import each other (checked by test/architecture.test.ts)
  apps/document-check          HTTP API + composition root
infra/aws/        network, registries, staff-signin (Cognito), data, lattice, services (ECS + ALB)
services/infra/aws, backend/infra/aws   per-service task roles
```

## Pipelines

| Stage | Onboarding | Loan | Mortgage |
|---|---|---|---|
| 1–3 | classification → extraction → document-verification ∥ cross-reference ∥ risk-fraud | same | same |
| 4 | sanctions-pep ∥ bank-verification | kyc-freshness ∥ credit-history ∥ bank-verification | same as loan |
| 5 | aml-risk | affordability | affordability ∥ collateral |
| 6–8 | investigation (AI, ≤ 6 turns) → triage → summary-communication (AI) | same | same |

Every step is written to a hash-chained, append-only audit log.

## Run locally (against real AWS)

You need AWS credentials for an account with Bedrock model access in eu-central-1.

```sh
# 1. Dev resources (S3 bucket + DynamoDB tables)
cd services && bun install
bun scripts/bootstrap-dev.ts --prefix doccheck-dev-$USER       # prints the env vars to export

# 2. Service
export STAFF_API_SIGNING_KEY=dev-secret BEDROCK_MODEL_ID=eu.anthropic.claude-sonnet-4-5-20250929-v1:0
bun apps/document-check/src/server.ts                           # :8080

# 3. Staff API (dev auth, no Cognito)
cd ../backend && bun install
AUTH_MODE=dev LATTICE_AUTH=none DOC_CHECK_SERVICE_URL=http://localhost:8080 STAFF_API_SIGNING_KEY=dev-secret bun src/server.ts   # :3001

# 4. Web app
cd .. && bun install && VITE_AUTH_MODE=dev bun run dev          # :3000, proxies /api to :3001
```

## Tests

```sh
cd services && bun test                 # rules, agents, guards, audit chain, HTTP layer, agent isolation (no AWS)
cd services && bun run test:integration # real Textract + Bedrock over services/fixtures/<case>/ (see fixtures/README.md)
cd backend && bun test
```

## What still needs the bank

- **Regulatory parameters.** DTI/LTV caps, recency limits, KYC refresh periods, AML weights and the
  high-risk country list are in `services/packages/rules/src/tables.ts`, each with its source. All are
  `confirmedByCompliance: false` until Compliance signs them off.
- **Authority connections.** CRC, Biroul de Credit, ANAF, IGPR (cazier) and ANCPI are simulated. Production
  refuses to start with them unless `ALLOW_SIMULATED_AUTHORITIES` is set explicitly (demo only).
- **ONPCSB list.** Set `ONPCSB_LIST_FILE`; without it, onboarding screening is blocked, by design.
- **Data-processing notice.** `NOTICE_VERSION` in `frontend/lib/labels.ts` must match the DPO-approved notice.
