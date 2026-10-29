/**
 * Layouts used by the hackathon data set ("Registrul Oficial" residence documents, label-value ID
 * cards, English-labelled passports). OCR output is written as Textract FORMS would return it.
 */
import { describe, expect, test } from "bun:test";
import { createClassificationAgent } from "@dc/agent-classification";
import { createCrossReferenceAgent } from "@dc/agent-cross-reference";
import { createDocumentVerificationAgent } from "@dc/agent-document-verification";
import { createExtractionAgent } from "@dc/agent-extraction";
import { triage } from "@dc/agent-triage";
import { doc, makeCase, ocrDoc, runChain } from "@dc/testkit";

const idCard = ocrDoc("id", ["CARTE DE IDENTITATE", "CNP:", "1660123390281", "Nume:", "Badea", "Prenume:", "Gabriel", "Serie/Nr:", "RX335967", "Data nașterii:", "23.01.1966", "Domiciliu:", "13.10.2026"], {
  kv: { "CNP:": "1660123390281", "Nume:": "Badea", "Prenume:": "Gabriel", "Serie/Nr:": "RX335967", "Data nașterii:": "23.01.1966", "Sex:": "M", "Domiciliu:": "13.10.2026" },
});
const passport = ocrDoc("pp", ["PAȘAPORT", "ROU", "SURNAME", "Albu", "PASS NO.", "465715566", "GIVEN NAME", "Adrian", "CNP", "1621216391456", "DOB", "16.12.1962"], {
  kv: { SURNAME: "Albu", "PASS NO.": "465715566", "GIVEN NAME": "Adrian", CNP: "1621216391456", DOB: "16.12.1962", SEX: "M" },
});
const residence = (title: string, name: string) =>
  ocrDoc("res", ["Registrul Oficial", title, `Nume: ${name}`, "Adresa: Calea Victoriei Nr. 100, Ap. 27, Timisoara, Romania", "Eliberat la data de: 13.10.2026", "Document valid."], {
    kv: { "Nume:": name, "Adresa:": "Calea Victoriei Nr. 100, Ap. 27, Timisoara, Romania", "Eliberat la data de:": "13.10.2026" },
  });

const agents = () => [createClassificationAgent(), createExtractionAgent(), createDocumentVerificationAgent(), createCrossReferenceAgent()];
const now = new Date("2026-10-28T12:00:00Z");

describe("hackathon layouts", () => {
  test.each([
    ["FACTURĂ ENERGIE ELECTRICĂ", "utility_bill_electricity"],
    ["FACTURĂ APĂ-CANAL", "utility_bill_water"],
    ["DOVADĂ REȘEDINȚĂ", "domicile_certificate"],
    ["CONTRACT NOTARIAL", "notary_contract"],
  ])("residence document %s is classified as %s and accepted", async (title, type) => {
    const { ctx } = await runChain(makeCase("onboarding", [doc("id"), doc("res")]), { id: idCard, res: residence(title, "Badea Gabriel") }, agents(), now);
    expect(ctx.facts.find((f) => f.docId === "res" && f.field === "docType")?.value).toBe(type);
    expect(ctx.findings.map((f) => f.code)).not.toContain("CLASS_MISSING_REQUIRED");
    expect(ctx.facts.find((f) => f.docId === "res" && f.field === "issueDate")?.normalized).toBe("2026-10-13");
  });

  test("ID card: label-value fields read; a date in 'Domiciliu' is not taken as an address", async () => {
    const { ctx } = await runChain(makeCase("onboarding", [doc("id")]), { id: idCard }, agents(), now);
    const f = (field: string) => ctx.facts.find((x) => x.docId === "id" && x.field === field)?.value;
    expect(f("fullName")).toBe("Gabriel Badea");
    expect(f("cnp")).toBe("1660123390281");
    expect(f("documentNumber")).toBe("RX335967");
    expect(f("birthDate")).toBe("23.01.1966");
    expect(f("address")).toBeUndefined();
    expect(ctx.findings.map((x) => x.code)).toContain("DOCVER_EXPIRY_UNREADABLE"); // no validity printed on these cards
  });

  test("a document the OCR engine could not read is reported as unreadable, not 'score 0'", async () => {
    const { ctx } = await runChain(makeCase("onboarding", [doc("id"), doc("res")]), { id: idCard }, agents(), now);
    const unreadable = ctx.findings.find((f) => f.code === "CLASS_UNREADABLE")!;
    expect(unreadable.values).toEqual(["res.pdf"]);
    expect(ctx.findings.some((f) => f.code === "CLASS_UNKNOWN")).toBe(false);
  });

  test("passport with English labels", async () => {
    const { ctx } = await runChain(makeCase("onboarding", [doc("pp")]), { pp: passport }, agents(), now);
    const f = (field: string) => ctx.facts.find((x) => x.docId === "pp" && x.field === field)?.value;
    expect(f("fullName")).toBe("Adrian Albu");
    expect(f("documentNumber")).toBe("465715566");
    expect(f("birthDate")).toBe("16.12.1962");
  });

  test("misspelled name on the residence document is flagged and sent to human review", async () => {
    const { ctx } = await runChain(makeCase("onboarding", [doc("id"), doc("res")]), { id: idCard, res: residence("FACTURĂ ENERGIE ELECTRICĂ", "Bdadea Gaebriel") }, agents(), now);
    const name = ctx.findings.find((x) => x.code.startsWith("XREF_NAME"))!;
    expect(["medium", "high"]).toContain(name.severity);
    expect(name.citations).toEqual(["id:fullName", "res:fullName"]);
    expect(triage(ctx).lane).toBe("human_review");
  });
});

describe("hackathon loan documents (Badea_Gabriel_12 findings)", () => {
  const withQueries = (o: ReturnType<typeof ocrDoc>, answers: Record<string, string>) => {
    o.pages[0]!.queries = Object.entries(answers).map(([alias, answer]) => ({ alias, answer, confidence: 60 }));
    return o;
  };
  // The card prints no validity; Textract's generic "expiry date?" query answered with the birth date.
  const idWithGuess = () => withQueries(ocrDoc("id", idCard.pages[0]!.lines.map((l) => l.text), { kv: Object.fromEntries(idCard.pages[0]!.keyValues.map((k) => [k.key, k.value])) }), { expiryDate: "23.01.1966" });
  const contract = withQueries(
    ocrDoc("cim", ["1990101123456", "CONTRACT MUNCĂ", "CUI: Global Construct SRL", "Angajat: Badea Gabriel", "Funcție: RO22334455", "Salariu lunar brut: Inginer RON", "Data începerii: 7697", "Adresa: 4502"], {
      kv: { "CUI:": "Global Construct SRL", "Angajat:": "Badea Gabriel", "Funcție:": "RO22334455", "Salariu lunar brut:": "Inginer RON", "Data începerii:": "7697", "Adresa:": "4502" },
    }),
    { employer: "Badea Gabriel" },
  );
  const statement = ocrDoc("st", ["1990101123456", "EXTRAS DE CONT", "Titular Cont: Badea Gabriel", "Perioada raportată: Ultimele Banca de Nord luni"], {
    kv: { "Titular Cont:": "Badea Gabriel" },
    tables: [[["Data Tranzacției", "Detalii / Comerciant", "Suma"], ["16.05.2026", "PLATA SALARIU Global Construct SRL", "+4502.00 RON"]]],
  });

  test("no expiry guessed from the birth date; employee name is not taken as employer; statement address note suppressed", async () => {
    const c = makeCase("loan", [doc("id"), doc("res"), doc("cim"), doc("st")]);
    const { ctx } = await runChain(c, { id: idWithGuess(), res: residence("FACTURĂ ENERGIE ELECTRICĂ", "Bdadea Gaebriel"), cim: contract, st: statement }, agents(), now);
    const codes = ctx.findings.map((f) => f.code);
    expect(codes).not.toContain("DOCVER_EXPIRED");
    expect(codes).toContain("DOCVER_EXPIRY_UNREADABLE");
    expect(ctx.facts.find((f) => f.docId === "cim" && f.field === "employer")).toBeUndefined();
    expect(codes).not.toContain("XREF_SALARY_PAYER_UNKNOWN");
    expect(codes).not.toContain("CLASS_STATEMENT_NO_ADDRESS"); // the electricity bill is the proof of address
    expect(codes.filter((x) => x === "XREF_CNP_MISMATCH")).toHaveLength(2); // the data set's real anomaly
  });
});
