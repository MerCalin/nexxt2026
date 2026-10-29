# Synthetic KYC (onboarding) cases

Generated 28.10.2026 by `bun scripts/generate-kyc-fixtures.ts`. All persons, CNPs, addresses and companies are fictional.
Re-generate before testing if older than ~4 weeks (bill recency is checked against today).

Set `ONPCSB_LIST_FILE=<repo>/services/fixtures/synthetic-onpcsb.csv` (a fictional stand-in list) so the clean cases are not blocked on ONPCSB.

| Case | Scenario | Expected lane | Expected findings |
|---|---|---|---|
| `synthetic-kyc-01-clean` | Clean onboarding: CI + water bill, same person, same address. Baseline. Needs ONPCSB_LIST_FILE set (see README) — otherwise the ONPCSB check is blocked and the lane is human_review. | ready_for_officer | — |
| `synthetic-kyc-02-gas-bill-rejected` | Gas bill is not an acceptable proof of address. Customer message should ask for a domicile certificate / water or electricity bill / notary contract / statement with address. | needs_info | `CLASS_REJECTED_POA`, `CLASS_MISSING_REQUIRED` |
| `synthetic-kyc-03-expired-id` | ID card expired 8 months ago. Expired identity document is high severity. | human_review | `DOCVER_EXPIRED` |
| `synthetic-kyc-04-address-mismatch` | Water bill at a different address than the ID card. Customer is asked to confirm the current address. Investigation may suggest a recent move. | needs_info | `XREF_ADDRESS_MISMATCH` |
| `synthetic-kyc-05-maiden-name` | Electricity bill still in the customer's maiden name. Same first name and address, different surname — the Investigation agent should offer a maiden-name hypothesis (as a hypothesis, not a conclusion). | human_review | `XREF_NAME_MISMATCH` |
| `synthetic-kyc-06-mrz-tampered` | MRZ document-number check digit is wrong. Uses a domicile certificate as proof of address. | human_review | `DOCVER_MRZ_CHECK_FAILED` |
| `synthetic-kyc-07-passport-statement` | Passport + bank statement showing the address. A statement with the holder's address is acceptable proof of residence. Needs ONPCSB_LIST_FILE set. | ready_for_officer | — |
| `synthetic-kyc-08-pep` | Customer matches the (simulated) PEP list. Compliance-only findings: a credit/KYC officer sees only 'compliance_review' and cannot approve; log in as Conformitate to see details. | human_review | `PEP_MATCH`, `AML_RISK_HIGH` |
| `synthetic-kyc-09-no-consent` | Clean documents but no consent recorded for Phase 3 lookups. Criminal record and ANAF lookups are BLOCKED, never silently skipped. Record the consents in the UI and re-run to clear it. | human_review | `BANKVER_BLOCKED` |
| `synthetic-kyc-10-criminal-record` | Simulated criminal record (cazier) hit. Visible only to Conformitate; other roles see the neutral message 'Verificare finalizată – contactați departamentul Conformitate.' | human_review | `BANKVER_CRIMINAL_RECORD` |
| `synthetic-kyc-11-edited-bill` | Electricity bill PDF re-saved with an image editor. Customer message must stay neutral (no mention of fraud or editing). | human_review | `FRAUD_EDITOR_SOFTWARE`, `FRAUD_MODIFIED_AFTER_CREATION` |
| `synthetic-kyc-12-stale-bill` | Water bill is 5 months old. Proof of address must be at most 90 days old; the customer is asked for a recent one. | needs_info | `DOCVER_STALE` |

Each folder: documents (ID as PNG scan, others as PDF), `case.json` (workflow, subject, consents), `expected-findings.json`.
