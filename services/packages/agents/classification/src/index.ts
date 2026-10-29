import { type DocType, type Fact, type Finding, PROOF_OF_ADDRESS, REQUIREMENTS, type Workflow } from "@dc/contracts";
import type { Agent, AgentContext } from "@dc/ports";
import { foldForMatch, makeFact, makeFinding, parseAddress } from "@dc/rules";

/** Romanian keywords per document type (matched on diacritic-folded, upper-cased text). Weight = evidence strength. */
export const KEYWORDS: Record<Exclude<DocType, "unknown">, [string, number][]> = {
  id_card: [["CARTE DE IDENTITATE", 5], ["CARTE ELECTRONICA DE IDENTITATE", 5], ["IDROU", 5], ["IDENTITY CARD", 3], ["CARTE D IDENTITE", 3], ["DOMICILIU", 1], ["SPCLEP", 2], ["VALABILITATE", 1]],
  passport: [["PASAPORT", 5], ["PASSPORT", 4], ["PASSEPORT", 3], ["P<ROU", 5], ["TIPUL TYPE", 1]],
  domicile_certificate: [["CERTIFICAT DE DOMICILIU", 6], ["DOVADA RESEDINTA", 6], ["DOVADA DE RESEDINTA", 6], ["CERTIFICAT DE RESEDINTA", 6], ["DOVADA DOMICILIULUI", 3], ["ADEVERINTA DE DOMICILIU", 4], ["DGEP", 2], ["EVIDENTA PERSOANELOR", 2]],
  utility_bill_water: [["APA NOVA", 5], ["APA CANAL", 5], ["APAVITAL", 5], ["COMPANIA DE APA", 5], ["APA RECE", 3], ["CANALIZARE", 3], ["METRI CUBI", 2], ["MC", 1], ["FACTURA", 1]],
  utility_bill_electricity: [["ENERGIE ELECTRICA", 5], ["ENEL ENERGIE", 5], ["ELECTRICA FURNIZARE", 5], ["PPC ENERGIE", 5], ["HIDROELECTRICA", 4], ["CEZ VANZARE", 4], ["KWH", 2], ["LOC DE CONSUM", 1], ["FACTURA", 1]],
  utility_bill_rejected: [["TELEFONIE", 5], ["TELEFON MOBIL", 5], ["INTERNET", 4], ["GAZE NATURALE", 6], ["DIGI", 3], ["RCS RDS", 4], ["ORANGE ROMANIA", 4], ["VODAFONE", 4], ["TELEKOM", 4], ["ABONAMENT TV", 4], ["CABLU", 2], ["FACTURA", 1]],
  notary_contract: [["CONTRACT NOTARIAL", 6], ["NOTAR PUBLIC", 5], ["BIROU NOTARIAL", 5], ["INCHEIERE DE AUTENTIFICARE", 5], ["CONTRACT DE VANZARE CUMPARARE", 4], ["CONTRACT DE INCHIRIERE", 4], ["AUTENTIFICAT", 2]],
  bank_statement: [["EXTRAS DE CONT", 6], ["EXTRAS CONT", 5], ["SOLD INITIAL", 3], ["SOLD FINAL", 3], ["SOLD PRECEDENT", 3], ["IBAN", 1], ["PERIOADA", 1], ["TOTAL DEBIT", 2], ["TOTAL CREDIT", 2]],
  employment_contract: [["CONTRACT INDIVIDUAL DE MUNCA", 7], ["CONTRACT MUNCA", 6], ["CONTRACT DE MUNCA", 6], ["ANGAJATOR", 2], ["SALARIAT", 2], ["SALARIUL DE BAZA", 3], ["DURATA NEDETERMINATA", 2], ["CODUL MUNCII", 2], ["REVISAL", 2]],
  payslip: [["FLUTURAS", 6], ["FLUTURAS DE SALARIU", 7], ["STAT DE PLATA", 4], ["REST DE PLATA", 4], ["SALARIU NET", 3], ["CAS", 1], ["CASS", 1]],
  debt_declaration: [["DECLARATIE", 2], ["PROPRIE RASPUNDERE", 3], ["DATORII", 3], ["OBLIGATII DE PLATA", 3], ["CREDITE IN CURS", 3]],
  land_register_extract: [["EXTRAS DE CARTE FUNCIARA", 7], ["CARTE FUNCIARA NR", 4], ["ANCPI", 3], ["OCPI", 3], ["NR CADASTRAL", 2], ["PARTEA I", 1], ["PARTEA II", 1], ["PARTEA III", 1]],
  valuation_report: [["RAPORT DE EVALUARE", 7], ["ANEVAR", 5], ["VALOARE DE PIATA", 4], ["EVALUATOR AUTORIZAT", 4], ["SEV", 1]],
};

const MIN_SCORE = 5;

export type ClassificationData = {
  docs: Record<string, { docType: DocType; score: number; matched: string[]; runnerUp?: DocType }>;
  requirements: Record<string, { satisfied: boolean; docIds: string[]; optional: boolean }>;
  proofOfAddressDocIds: string[];
};

/** MRZ document codes are glued to the surname ("IDROUPOPESCU<<ION"), so they match as raw substrings. */
const MRZ_PREFIXES = new Set(["IDROU", "P<ROU"]);

export function scoreText(text: string): { docType: DocType; score: number; matched: string[]; runnerUp?: DocType } {
  const t = ` ${foldForMatch(text)} `;
  const upper = text.toUpperCase().replace(/\s/g, "");
  const scores = (Object.keys(KEYWORDS) as (keyof typeof KEYWORDS)[]).map((type) => {
    const matched = KEYWORDS[type].filter(([kw]) => t.includes(` ${foldForMatch(kw)} `) || (MRZ_PREFIXES.has(kw) && upper.includes(kw)));
    return { type, score: matched.reduce((a, [, w]) => a + w, 0), matched: matched.map(([k]) => k) };
  });
  scores.sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  if (!best || best.score < MIN_SCORE) return { docType: "unknown", score: best?.score ?? 0, matched: best?.matched ?? [] };
  return { docType: best.type, score: best.score, matched: best.matched, runnerUp: second?.score ? second.type : undefined };
}

/** Classification agent: assigns a document type from Romanian keywords and checks the required document set. */
export function createClassificationAgent(): Agent {
  return {
    name: "classification",
    async run(ctx: AgentContext) {
      const facts: Fact[] = [];
      const findings: Finding[] = [];
      const data: ClassificationData = { docs: {}, requirements: {}, proofOfAddressDocIds: [] };
      const statementsWithoutAddress: { fileName: string; factId: string }[] = [];

      for (const doc of ctx.case.documents) {
        const ocr = ctx.ocr[doc.id];
        const pages = ocr?.pages ?? [];
        const text = pages.flatMap((p) => p.lines.map((l) => l.text)).join("\n");
        const res = scoreText(text);
        data.docs[doc.id] = res;
        const anchorLine = pages[0]?.lines.find((l) => res.matched.some((kw) => foldForMatch(l.text).includes(foldForMatch(kw))));
        const fact = makeFact({
          docId: doc.id,
          docType: res.docType,
          field: "docType",
          value: res.docType,
          normalized: res.docType,
          page: 1,
          bbox: anchorLine?.bbox,
          ocrConfidence: anchorLine?.confidence ?? 0,
          extractor: `keywords:${res.matched.join("+")}`,
        });
        facts.push(fact);

        if (!ocr) {
          // the OCR engine failed for this file: nothing to classify, and not the customer's fault
          findings.push(
            makeFinding({
              agent: "classification",
              code: "CLASS_UNREADABLE",
              severity: "medium",
              message: `Documentul „${doc.fileName}” nu a putut fi citit automat (eroare OCR); verificați-l manual sau reluați verificarea.`,
              citations: [fact.id],
              values: [doc.fileName],
            }),
          );
        } else if (res.docType === "unknown") {
          findings.push(
            makeFinding({
              agent: "classification",
              code: "CLASS_UNKNOWN",
              severity: "medium",
              message: `Documentul „${doc.fileName}” nu a putut fi clasificat (scor ${res.score}).`,
              citations: [fact.id],
              values: [doc.fileName],
            }),
          );
        } else if (res.docType === "utility_bill_rejected") {
          findings.push(
            makeFinding({
              agent: "classification",
              code: "CLASS_REJECTED_POA",
              severity: "medium",
              message: `„${doc.fileName}” este o factură de telefonie/internet/gaze; nu este acceptată ca dovadă a reședinței.`,
              citations: [fact.id],
              values: [doc.fileName, res.matched.join(", ")],
            }),
          );
        }

        if (PROOF_OF_ADDRESS.includes(res.docType)) {
          // A bank statement is proof of address only if it shows the holder's address.
          const ok =
            res.docType !== "bank_statement" ||
            (pages[0]?.lines ?? []).some((l) => {
              const a = parseAddress(l.text);
              return !!a.street && !!a.number;
            });
          if (ok) data.proofOfAddressDocIds.push(doc.id);
          else statementsWithoutAddress.push({ fileName: doc.fileName, factId: fact.id });
        }
      }

      // only relevant when the statement was meant as the proof of address (no other document qualifies)
      if (!data.proofOfAddressDocIds.length)
        for (const s of statementsWithoutAddress)
          findings.push(
            makeFinding({
              agent: "classification",
              code: "CLASS_STATEMENT_NO_ADDRESS",
              severity: "low",
              message: `Extrasul de cont „${s.fileName}” nu conține adresa titularului; nu poate fi folosit ca dovadă a reședinței.`,
              citations: [s.factId],
            }),
          );

      // Required document set for the workflow
      const caseFact = makeFact({
        docId: "case",
        docType: "unknown",
        field: "documentSet",
        value: Object.values(data.docs).map((d) => d.docType).join(",") || "(none)",
        normalized: Object.values(data.docs).map((d) => d.docType).sort().join(","),
        page: 1,
        ocrConfidence: 100,
        extractor: "classification",
      });
      facts.push(caseFact);

      for (const req of REQUIREMENTS[ctx.case.workflow as Workflow]) {
        const docIds = Object.entries(data.docs)
          .filter(([id, d]) => req.anyOf.includes(d.docType) && (req.id !== "residence" || data.proofOfAddressDocIds.includes(id)))
          .map(([id]) => id);
        data.requirements[req.id] = { satisfied: docIds.length > 0, docIds, optional: !!req.optional };
        if (!docIds.length && !req.optional) {
          findings.push(
            makeFinding({
              agent: "classification",
              code: "CLASS_MISSING_REQUIRED",
              severity: "medium",
              message: `Lipsește documentul obligatoriu: ${req.label}.`,
              citations: [caseFact.id],
              values: [req.id],
            }),
          );
        }
      }

      return { status: "ok", facts, findings, data };
    },
  };
}
