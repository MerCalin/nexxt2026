import { describe, expect, test } from "bun:test";
import { createAffordabilityAgent } from "@dc/agent-affordability";
import { createBankVerificationAgent, NEUTRAL_CRIMINAL_RECORD_MESSAGE } from "@dc/agent-bank-verification";
import { createCollateralAgent } from "@dc/agent-collateral";
import { createCreditHistoryAgent } from "@dc/agent-credit-history";
import { createKycFreshnessAgent } from "@dc/agent-kyc-freshness";
import { createSimulatedAuthorities } from "@dc/adapters-simulated";
import type { Consent, Fact } from "@dc/contracts";
import type { Agent } from "@dc/ports";
import { evidenceForAudience, makeFact } from "@dc/rules";
import { cnp, makeCase, runChain } from "@dc/testkit";

const CNP = cnp("185031540012");

/** Seeds extracted facts directly (the Phase 2 agents are covered in phase2.test.ts). */
const seed = (facts: Omit<Fact, "id" | "page" | "ocrConfidence" | "extractor">[]): Agent => ({
  name: "extraction",
  run: async () => ({ status: "ok", facts: facts.map((f, i) => makeFact({ ...f, page: 1, ocrConfidence: 99, extractor: "seed", seq: i + 1 })) }),
});

const base = [
  { docId: "ci", docType: "id_card" as const, field: "fullName", value: "ION POPESCU", normalized: "ION POPESCU" },
  { docId: "ci", docType: "id_card" as const, field: "cnp", value: CNP, normalized: CNP },
  { docId: "ci", docType: "id_card" as const, field: "address", value: "Str. Lalelelor nr. 12 ap. 45 București", normalized: "" },
  { docId: "st", docType: "bank_statement" as const, field: "salaryCredit", value: "5000", normalized: "5000" },
  { docId: "st", docType: "bank_statement" as const, field: "salaryCredit", value: "5000", normalized: "5000" },
];

const consent = (purpose: Consent["purpose"]): Consent => ({ id: `c-${purpose}`, caseId: "case-1", purpose, noticeVersion: "GDPR-2026-01", givenAt: "2026-10-28T09:00:00Z", channel: "branch_tablet", recordedBy: "officer-1" });

const sim = createSimulatedAuthorities({
  persons: {
    [CNP]: {
      creditBureau: { insolvency: false, records: [{ lender: "BANCA ALFA", product: "loan", role: "debtor", currency: "RON", outstanding: 20000, monthlyInstalment: 900, status: "current", daysPastDue: 0, openedAt: "2023-01-10" }] },
      centralCreditRegister: { insolvency: false, records: [{ lender: "BANCA ALFA", product: "loan", role: "debtor", currency: "RON", outstanding: 20000, monthlyInstalment: 900, status: "current", daysPastDue: 0, openedAt: "2023-01-10" }] },
      criminalRecord: { hasRecord: true, entries: [{ offence: "art. 244 C.pen.", date: "2019-05-01", final: true }] },
      anaf: { hasDebt: true, amountRon: 1250, asOf: "2026-10-27" },
    },
  },
  landRegister: { "123456": { cadastralNumber: "123456", carteFunciaraNumber: "123456", uat: "București S3", owners: [{ name: "MARIA IONESCU", share: "1/1" }], encumbrances: [{ type: "ipotecă", holder: "BANCA BETA", registeredAt: "2015-01-01" }] } },
  kyc: { "CUST-1": { customerRef: "CUST-1", fullName: "ION POPESCU", cnp: CNP, address: "Str. Florilor nr. 3 București", idDocumentNumber: "RX000001", idDocumentExpiry: "2024-01-01", riskLevel: "medium", lastReviewAt: "2021-06-01" } },
  pep: [],
});

const loanSubject = { customerRef: "CUST-1", loan: { amount: 100_000, currency: "RON", termMonths: 120, annualRatePct: 7 } };

describe("loan agents", () => {
  test("KYC file is stale: overdue review, expired ID on file, changed address", async () => {
    const c = makeCase("loan", [], { subject: loanSubject });
    const { results } = await runChain(c, {}, [seed(base), createKycFreshnessAgent({ kyc: sim.kycStore })]);
    const r = results["kyc-freshness"]!;
    expect((r.data as { reasons: string[] }).reasons).toEqual(["review_overdue", "id_expired_on_file", "address_changed"]);
    expect(r.findings.every((f) => f.simulated)).toBe(true);
  });

  test("credit history: merges CRC + bureau, flags undeclared debt; affordability uses it", async () => {
    const declaration = [
      { docId: "dd", docType: "debt_declaration" as const, field: "docType", value: "debt_declaration", normalized: "debt_declaration" },
      { docId: "dd", docType: "debt_declaration" as const, field: "declaresNoDebts", value: "nu am alte datorii", normalized: "" },
    ];
    const c = makeCase("loan", [], { subject: loanSubject, consents: [consent("credit_bureau_lookup")] });
    const { results } = await runChain(c, {}, [seed([...base, ...declaration]), createCreditHistoryAgent({ bureau: sim.creditBureau, ccr: sim.centralCreditRegister }), createAffordabilityAgent()]);
    const ch = results["credit-history"]!;
    expect((ch.data as { records: unknown[] }).records).toHaveLength(1); // same loan in both registers
    expect(ch.findings.find((f) => f.code === "CREDIT_UNDECLARED_DEBT")?.severity).toBe("high");
    const aff = results.affordability!.data as { dti: number; existingInstalmentsRon: number; limit: number; formula: string };
    expect(aff.existingInstalmentsRon).toBe(900);
    // (900 + 1161.08) / 5000 = 41.2 % > 40 %
    expect(aff.dti).toBeCloseTo(0.41, 2);
    expect(results.affordability!.findings.map((f) => f.code)).toContain("AFFORD_DTI_EXCEEDED");
  });

  test("credit history without consent is blocked, and affordability is marked incomplete", async () => {
    const c = makeCase("loan", [], { subject: loanSubject });
    const { results } = await runChain(c, {}, [seed(base), createCreditHistoryAgent({ bureau: sim.creditBureau, ccr: sim.centralCreditRegister }), createAffordabilityAgent()]);
    expect(results["credit-history"]!.status).toBe("blocked");
    expect(results.affordability!.findings.map((f) => f.code)).toContain("AFFORD_INCOMPLETE");
  });

  test("collateral: owner, encumbrance, registry mismatch, LTV", async () => {
    const facts = [
      ...base,
      { docId: "cf", docType: "land_register_extract" as const, field: "cadastralNumber", value: "123456", normalized: "123456" },
      { docId: "cf", docType: "land_register_extract" as const, field: "owner", value: "1. POPESCU ION, proprietar, cota 1/1", normalized: "" },
      { docId: "ev", docType: "valuation_report" as const, field: "cadastralNumber", value: "123457", normalized: "123457" },
      { docId: "ev", docType: "valuation_report" as const, field: "marketValue", value: "110.000 RON", normalized: "110000" },
    ];
    const c = makeCase("mortgage", [], { subject: loanSubject });
    const { results } = await runChain(c, {}, [seed(facts), createCollateralAgent({ landRegister: sim.landRegister })]);
    const codes = results.collateral!.findings.map((f) => f.code);
    expect(codes).toContain("COLL_CADASTRAL_MISMATCH");
    expect(codes).toContain("COLL_EXTRACT_REGISTRY_MISMATCH"); // ANCPI says MARIA IONESCU + an ipotecă
    expect(codes).toContain("COLL_LTV_EXCEEDED"); // 100k / 110k = 91 % > 85 %
  });
});

describe("phase 3 bank verification", () => {
  test("missing consent blocks both lookups (never silently skipped)", async () => {
    const c = makeCase("onboarding", []);
    const { results } = await runChain(c, {}, [seed(base), createBankVerificationAgent({ criminalRecord: sim.criminalRecord, anaf: sim.anaf })]);
    const r = results["bank-verification"]!;
    expect(r.status).toBe("blocked");
    expect(r.checks.map((x) => [x.kind, x.status])).toEqual([["cazier", "blocked"], ["anaf", "blocked"]]);
  });

  test("criminal record is compliance-only; others see only the neutral message", async () => {
    const c = makeCase("onboarding", [], { consents: [consent("criminal_record_lookup"), consent("anaf_tax_debt_lookup")] });
    const { ctx } = await runChain(c, {}, [seed(base), createBankVerificationAgent({ criminalRecord: sim.criminalRecord, anaf: sim.anaf })]);
    const officer = evidenceForAudience(ctx, "officer");
    expect(officer.findings.map((f) => f.code)).toEqual(["BANKVER_TAX_DEBT"]);
    expect(officer.checks.find((x) => x.kind === "cazier")?.payload).toEqual({ message: NEUTRAL_CRIMINAL_RECORD_MESSAGE });
    expect(evidenceForAudience(ctx, "compliance").findings.map((f) => f.code)).toContain("BANKVER_CRIMINAL_RECORD");
    const customer = evidenceForAudience(ctx, "customer");
    expect(customer.findings).toHaveLength(0);
    expect(customer.checks.some((x) => x.kind === "cazier")).toBe(false);
  });
});
