import { describe, expect, test } from "bun:test";
import { createClassificationAgent } from "@dc/agent-classification";
import { createCrossReferenceAgent } from "@dc/agent-cross-reference";
import { createDocumentVerificationAgent } from "@dc/agent-document-verification";
import { createExtractionAgent } from "@dc/agent-extraction";
import { createRiskFraudAgent } from "@dc/agent-risk-fraud";
import { triage } from "@dc/agent-triage";
import type { CaseStorePort } from "@dc/ports";
import { mrzCheckDigit } from "@dc/rules";
import { cnp, doc, makeCase, ocrDoc, runChain } from "@dc/testkit";

const CNP = cnp("185031540012");

function td2(surname: string, given: string, docNum: string, birth: string, expiry: string, optional = "1400125") {
  const l1 = `IDROU${surname}<<${given}`.padEnd(36, "<");
  const dn = docNum.padEnd(9, "<");
  const opt = optional.padEnd(7, "<");
  const body = `${dn}${mrzCheckDigit(dn)}ROU${birth}${mrzCheckDigit(birth)}M${expiry}${mrzCheckDigit(expiry)}${opt}`;
  const composite = body.slice(0, 10) + body.slice(13, 20) + body.slice(21, 35);
  return [l1, body + mrzCheckDigit(composite)];
}

const idCard = (over: { expiry?: string; mrzExpiry?: string } = {}) =>
  ocrDoc(
    "ci",
    [
      "ROMANIA ROUMANIE ROMANIA",
      "CARTE DE IDENTITATE",
      "SERIA XV NR 123456",
      `CNP ${CNP}`,
      "Nume/Nom/Last name",
      "POPESCU",
      "Prenume/Prenom/First name",
      "ION",
      "Domiciliu/Adresse/Address",
      "Mun. București Sec. 3 Str. Lalelelor nr. 12 bl. A4 sc. 2 et. 3 ap. 45",
      "Valabilitate/Validite/Validity",
      `15.03.20-${over.expiry ?? "15.03.2030"}`,
      ...td2("POPESCU", "ION", "XV123456", "850315", over.mrzExpiry ?? "300315"),
    ],
  );

const statement = (credits: string[], apartment = "45") =>
  ocrDoc(
    "st",
    [
      "BANCA EXEMPLU S.A.",
      "EXTRAS DE CONT",
      "Perioada 01.10.2026 - 25.10.2026",
      `Str. Lalelelor nr. 12 bl. A4 sc. 2 ap. ${apartment} București`,
      "IBAN RO49 AAAA 1B31 0075 9384 0000",
      "SOLD INITIAL 1.200,00",
      "SOLD FINAL 3.900,00",
    ],
    {
      kv: { "Titular:": "POPESCU ION" },
      tables: [[["Data", "Descriere", "Suma"], ...credits.map((c, i) => [`1${i}.10.2026`, "PLATA SALARIU ACME SOFTWARE SRL", c])]],
    },
  );

const contract = ocrDoc(
  "cim",
  ["CONTRACT INDIVIDUAL DE MUNCĂ", "nr. 12 din 01.02.2024", "Angajator ACME SOFTWARE SRL, CUI 14399840", "salariul de bază lunar brut: 8.000 lei", "pe durată nedeterminată"],
  { kv: { "Angajator:": "ACME SOFTWARE SRL", "Salariat:": "Ion Popescu", "CNP:": CNP, "Data începerii activității:": "01.02.2024" } },
);

const gasBill = ocrDoc("gas", ["ENGIE ROMANIA", "FACTURA", "GAZE NATURALE", "Loc de consum Str. Lalelelor nr. 12"], { kv: { "Data emiterii:": "05.10.2026" } });

const noReuse: CaseStorePort = { findByPerceptualHash: async () => [] } as unknown as CaseStorePort;

const agents = () => [
  createClassificationAgent(),
  createExtractionAgent(),
  createDocumentVerificationAgent(),
  createCrossReferenceAgent(),
  createRiskFraudAgent({ cases: noReuse }),
];

describe("phase 2 pipeline (loan)", () => {
  test("consistent documents → classified, extracted, only info findings, gas bill rejected", async () => {
    const c = makeCase("loan", [doc("ci"), doc("st"), doc("cim"), doc("gas")]);
    const { results, ctx } = await runChain(c, { ci: idCard(), st: statement(["4.700,00", "4.650,00"]), cim: contract, gas: gasBill }, agents());

    const cls = results.classification!.data as { docs: Record<string, { docType: string }>; requirements: Record<string, { satisfied: boolean }> };
    expect(cls.docs.ci!.docType).toBe("id_card");
    expect(cls.docs.st!.docType).toBe("bank_statement");
    expect(cls.docs.cim!.docType).toBe("employment_contract");
    expect(cls.docs.gas!.docType).toBe("utility_bill_rejected");
    expect(cls.requirements.residence!.satisfied).toBe(true); // statement shows the address

    const f = (field: string, docId: string) => ctx.facts.find((x) => x.field === field && x.docId === docId);
    expect(f("cnp", "ci")?.value).toBe(CNP);
    expect(f("fullName", "ci")?.value).toBe("ION POPESCU");
    expect(f("mrzChecks", "ci")?.value).toBe("ok");
    expect(f("employerCui", "cim")?.normalized).toBe("14399840");
    expect(ctx.facts.filter((x) => x.field === "salaryCredit").map((x) => x.normalized)).toEqual(["4700", "4650"]);

    const codes = ctx.findings.map((x) => x.code);
    expect(codes).toContain("CLASS_REJECTED_POA");
    expect(codes).not.toContain("XREF_INCOME_MISMATCH");
    expect(codes).not.toContain("XREF_CNP_MISMATCH");
    expect(codes).not.toContain("DOCVER_MRZ_CHECK_FAILED");
    expect(ctx.findings.every((x) => x.citations.length > 0)).toBe(true);
    expect(triage(ctx).lane).toBe("needs_info"); // only the rejected gas bill
  });

  test("income and address mismatches are found with both values cited", async () => {
    const c = makeCase("loan", [doc("ci"), doc("st"), doc("cim")]);
    const { ctx } = await runChain(c, { ci: idCard(), st: statement(["3.000,00"], "46"), cim: contract }, agents());
    const income = ctx.findings.find((x) => x.code === "XREF_INCOME_MISMATCH")!;
    expect(income.severity).toBe("medium");
    expect(income.citations).toContain("cim:grossSalary");
    expect(income.citations).toContain("st:salaryCredit");
    const addr = ctx.findings.find((x) => x.code === "XREF_ADDRESS_MISMATCH")!;
    expect(addr.citations).toEqual(["ci:address", "st:address"]);
    expect(addr.severity).toBe("low");
    expect(triage(ctx).lane).toBe("human_review");
  });

  test("expired ID card and tampered MRZ", async () => {
    const c = makeCase("onboarding", [doc("ci")]);
    const ci = idCard({ expiry: "15.03.2025", mrzExpiry: "300315" });
    const { ctx } = await runChain(c, { ci }, agents());
    const codes = ctx.findings.map((x) => x.code);
    expect(codes).toContain("DOCVER_EXPIRED");
    expect(codes).toContain("DOCVER_MRZ_VISUAL_MISMATCH"); // printed 2025 vs MRZ 2030
    expect(codes).toContain("CLASS_MISSING_REQUIRED"); // no proof of address
  });

  test("edited bank statement is flagged", async () => {
    const c = makeCase("loan", [doc("ci"), doc("st", { metadata: { producer: "Adobe Photoshop 25.0", creationDate: "2026-10-01T10:00:00Z", modDate: "2026-10-20T10:00:00Z" } }), doc("cim")]);
    const { ctx } = await runChain(c, { ci: idCard(), st: statement(["4.700,00"]), cim: contract }, agents());
    const fraud = ctx.findings.filter((x) => x.agent === "risk-fraud").map((x) => x.code);
    expect(fraud).toContain("FRAUD_EDITOR_SOFTWARE");
    expect(fraud).toContain("FRAUD_MODIFIED_AFTER_CREATION");
    expect(triage(ctx).lane).toBe("human_review");
  });
});

describe("file reuse across cases", () => {
  const runWith = (otherCnp: string) => {
    const store = {
      findByPerceptualHash: async () => [{ caseId: "other", docId: "x" }],
      getCase: async () => ({ runs: ["r-other"] }),
      getRun: async () => ({ results: [{ facts: [{ field: "cnp", docType: "id_card", normalized: otherCnp }] }] }),
    } as unknown as CaseStorePort;
    const c = makeCase("onboarding", [doc("ci")]);
    return runChain(c, { ci: idCard() }, [createClassificationAgent(), createExtractionAgent(), createRiskFraudAgent({ cases: store })]);
  };
  test("same customer re-submitting their own file is not flagged", async () => {
    const { ctx } = await runWith(CNP);
    expect(ctx.findings.map((f) => f.code)).not.toContain("FRAUD_FILE_REUSED");
  });
  test("a different customer's case with the same file is flagged", async () => {
    const { ctx } = await runWith(cnp("296010140017"));
    expect(ctx.findings.map((f) => f.code)).toContain("FRAUD_FILE_REUSED");
  });
});
