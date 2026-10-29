# Fixtures

Put the real sample documents here, one folder per case:

```
fixtures/
  scenarios.json              # SIMULATED authority data (CRC, Biroul de Credit, ANAF, cazier, ANCPI, KYC, PEP)
  <case-name>/
    case.json                 # { "workflow": "loan", "subject": { ... }, "consents": ["credit_bureau_lookup", ...] }
    *.pdf | *.png | *.jpg     # the customer's documents, as uploaded
    expected-findings.json    # optional: { "lane": "needs_info", "codes": ["CLASS_REJECTED_POA"], "absent": ["XREF_CNP_MISMATCH"] }
```

`case.json` example:

```json
{
  "workflow": "mortgage",
  "subject": {
    "customerRef": "CUST-0001",
    "isFirstHome": true,
    "loan": { "amount": 350000, "currency": "RON", "termMonths": 360, "annualRatePct": 6.9, "purchasePrice": 420000 }
  },
  "consents": ["credit_bureau_lookup", "criminal_record_lookup", "anaf_tax_debt_lookup"]
}
```

The integration suite (`bun run test:integration`) uploads every document to the dev S3 bucket, runs
the full pipeline against **real AWS Textract and Bedrock (eu-central-1)** and compares the result
with `expected-findings.json`. It needs AWS credentials and the dev resources from
`bun scripts/bootstrap-dev.ts`.

Documents contain personal data: keep this folder out of version control unless the samples are
synthetic or anonymised (see `.gitignore`).
