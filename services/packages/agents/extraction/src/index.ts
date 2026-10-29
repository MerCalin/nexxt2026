import type { BBox, DocType, Fact, OcrLine, OcrPage, OcrResult } from "@dc/contracts";
import type { Agent, AgentContext, OcrQuery } from "@dc/ports";
import {
  canonicalRomanian,
  compareNames,
  findMrz,
  foldForMatch,
  isValidCnp,
  makeFact,
  mrzDateToIso,
  normalizeAddress,
  normalizeName,
  parseAddress,
  parseAmount,
  parseCurrency,
  parseDate,
  parseMrz,
} from "@dc/rules";

/**
 * Generic Textract Queries issued for every document in the OCR stage (max 15 per call).
 * Extraction prefers regex/checksum-validated values and uses query answers as candidates.
 */
export const EXTRACTION_QUERIES: OcrQuery[] = [
  { alias: "fullName", text: "What is the full name of the person (titular / nume și prenume)?" },
  { alias: "cnp", text: "What is the CNP (cod numeric personal)?" },
  { alias: "address", text: "What is the address (domiciliu / adresa)?" },
  { alias: "documentNumber", text: "What is the document series and number?" },
  { alias: "expiryDate", text: "What is the expiry date (valabilitate / data expirării)?" },
  { alias: "issueDate", text: "What is the issue date of the document (data emiterii)?" },
  { alias: "employer", text: "What is the employer name (angajator)?" },
  { alias: "grossSalary", text: "What is the gross monthly base salary (salariul de bază brut)?" },
  { alias: "netSalary", text: "What is the net salary (rest de plată / salariu net)?" },
  { alias: "iban", text: "What is the IBAN?" },
  { alias: "statementPeriod", text: "What is the statement period (perioada)?" },
  { alias: "cadastralNumber", text: "What is the cadastral number (nr. cadastral)?" },
  { alias: "marketValue", text: "What is the market value (valoarea de piață)?" },
  { alias: "startDate", text: "What is the employment start date (data începerii activității)?" },
  { alias: "employerCui", text: "What is the employer's fiscal code (CUI / CIF)?" },
];

type Candidate = { value: string; page: number; bbox?: BBox; confidence: number; extractor: string };

class DocReader {
  constructor(
    readonly ocr: OcrResult,
    readonly docType: DocType,
  ) {}

  get pages(): OcrPage[] {
    return this.ocr.pages;
  }

  lines(): (OcrLine & { page: number })[] {
    return this.pages.flatMap((p) => p.lines.map((l) => ({ ...l, page: p.page })));
  }

  query(alias: string): Candidate | undefined {
    for (const p of this.pages) {
      const q = p.queries.find((x) => x.alias === alias && x.answer.trim());
      if (q) return { value: q.answer.trim(), page: p.page, bbox: q.bbox, confidence: q.confidence, extractor: `textract-query:${alias}` };
    }
    return undefined;
  }

  /** Key-value pair whose key (folded) matches any pattern. */
  kv(patterns: RegExp[]): Candidate | undefined {
    for (const p of this.pages)
      for (const kv of p.keyValues) {
        const k = foldForMatch(kv.key);
        if (kv.value.trim() && patterns.some((re) => re.test(k)))
          return { value: kv.value.trim(), page: p.page, bbox: kv.bbox, confidence: kv.confidence, extractor: `textract-kv:${kv.key}` };
      }
    return undefined;
  }

  /** First regex match over OCR lines, with all capture groups. */
  match(re: RegExp, name: string): { m: RegExpMatchArray; at: Candidate } | undefined {
    for (const l of this.lines()) {
      const m = l.text.match(re);
      if (m) return { m, at: { value: m[0].trim(), page: l.page, bbox: l.bbox, confidence: l.confidence, extractor: `regex:${name}` } };
    }
    return undefined;
  }

  /** First regex match over OCR lines; returns capture group 1 (or full match). */
  regex(re: RegExp, name: string): Candidate | undefined {
    const hit = this.match(re, name);
    return hit && { ...hit.at, value: (hit.m[1] ?? hit.m[0]).trim() };
  }

  /** First OCR line that parses as a Romanian street address (street + number). */
  addressLine(): Candidate | undefined {
    for (const l of this.lines()) {
      const a = parseAddress(l.text);
      if (a.street && a.number) return { value: l.text.trim(), page: l.page, bbox: l.bbox, confidence: l.confidence, extractor: "line:address" };
    }
    return undefined;
  }

  /** Value printed on the line after a label line (common on ID cards: "Nume/Nom/Last name" then "POPESCU"). */
  afterLabel(label: RegExp, name: string): Candidate | undefined {
    const ls = this.lines();
    for (let i = 0; i < ls.length - 1; i++) {
      if (label.test(foldForMatch(ls[i]!.text))) {
        const n = ls[i + 1]!;
        return { value: n.text.trim(), page: n.page, bbox: n.bbox, confidence: n.confidence, extractor: `label:${name}` };
      }
    }
    return undefined;
  }
}

const first = (...c: (Candidate | undefined)[]) => c.find((x) => x && x.value);

const CNP_RE = /\b([1-9]\d{12})\b/;
const IBAN_RE = /\b(RO\d{2}\s?[A-Z]{4}(?:\s?[A-Z0-9]{4}){4})\b/;
const DATE_RE = /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/;
const CUI_RE = /\b(?:C\.?U\.?I\.?|C\.?I\.?F\.?|COD FISCAL|COD UNIC DE INREGISTRARE)[:\s.]*((?:RO)?\s?\d{2,10})\b/i;
const SALARY_CREDIT_RE = /(SALARIU|SALAR|DREPTURI SALARIALE|PLATA SAL|VENIT SALARIAL)/;

/** Extraction agent: pulls typed fields from the OCR output, without AI. */
export function createExtractionAgent(): Agent {
  return {
    name: "extraction",
    async run(ctx: AgentContext) {
      const docTypes = new Map(ctx.facts.filter((f) => f.field === "docType").map((f) => [f.docId, f.value as DocType]));
      const facts: Fact[] = [];
      const fieldsByDoc: Record<string, string[]> = {};

      for (const doc of ctx.case.documents) {
        const ocr = ctx.ocr[doc.id];
        const docType = docTypes.get(doc.id) ?? "unknown";
        if (!ocr || docType === "unknown") continue;
        const r = new DocReader(ocr, docType);
        const out = extractDocument(r, ctx.now);
        for (const [field, cands] of Object.entries(out)) {
          cands.forEach((c, i) =>
            facts.push(
              makeFact({
                docId: doc.id,
                docType,
                field,
                value: c.value,
                normalized: normalizeField(field, c.value),
                page: c.page,
                bbox: c.bbox,
                ocrConfidence: c.confidence,
                extractor: c.extractor,
                seq: cands.length > 1 ? i + 1 : undefined,
              }),
            ),
          );
        }
        fieldsByDoc[doc.id] = Object.keys(out);
      }
      return { status: "ok", facts, data: { fieldsByDoc } };
    },
  };
}

export function normalizeField(field: string, value: string): string {
  switch (field) {
    case "fullName":
    case "employer":
    case "salaryPayer":
    case "owner":
      return normalizeName(value);
    case "address":
    case "propertyAddress":
      return normalizeAddress(value);
    case "cnp":
    case "iban":
    case "employerCui":
      return value.replace(/\s/g, "").toUpperCase().replace(/^RO(?=\d{2,10}$)/, "");
    case "birthDate":
    case "expiryDate":
    case "mrzBirthDate":
    case "mrzExpiryDate":
    case "salaryCreditDate":
    case "issueDate":
    case "startDate":
    case "endDate":
    case "periodStart":
    case "periodEnd":
    case "valuationDate":
      return parseDate(value) ?? value;
    case "grossSalary":
    case "netSalary":
    case "salaryCredit":
    case "marketValue":
    case "declaredDebtInstalment":
      return String(parseAmount(value) ?? value);
    default:
      return foldForMatch(value);
  }
}

type Out = Record<string, Candidate[]>;

/** Address-like fields must contain letters: a label filled with a date or number is not an address. */
const ADDRESS_FIELDS = new Set(["address", "propertyAddress"]);

function put(out: Out, field: string, c: Candidate | undefined) {
  if (!c?.value) return;
  if (ADDRESS_FIELDS.has(field) && !/\p{L}{3,}/u.test(c.value)) return;
  (out[field] ??= []).push({ ...c, value: canonicalRomanian(c.value) });
}

function extractDocument(r: DocReader, now: Date): Out {
  const out: Out = {};
  switch (r.docType) {
    case "id_card":
    case "passport":
      extractIdentity(r, out, now);
      break;
    case "domicile_certificate":
    case "utility_bill_water":
    case "utility_bill_electricity":
    case "utility_bill_rejected":
    case "notary_contract":
      put(out, "fullName", first(r.kv([/^TITULAR/, /^CLIENT/, /^NUME SI PRENUME/, /^NUME$/, /^BENEFICIAR/]), r.query("fullName")));
      put(out, "address", first(r.kv([/^ADRESA/, /^LOC DE CONSUM/, /^DOMICILIU/, /^ADRESA DE CONSUM/]), r.query("address"), r.addressLine()));
      put(out, "issueDate", first(r.kv([/^DATA (EMITERII|FACTURII|FACTURARII)/, /^ELIBERAT/, /^DATA$/]), r.query("issueDate"), r.regex(DATE_RE, "date")));
      put(out, "cnp", validCnp(r));
      break;
    case "bank_statement":
      extractStatement(r, out);
      break;
    case "employment_contract":
      put(out, "fullName", first(r.kv([/^SALARIAT/, /^ANGAJAT$/, /^NUME SI PRENUME/, /^DOMNUL|^DOAMNA/]), r.query("fullName")));
      put(out, "cnp", validCnp(r));
      put(out, "address", first(r.kv([/^DOMICILIAT/, /^DOMICILIU/, /^CU DOMICILIUL/]), r.query("address")));
      put(out, "employer", first(r.kv([/^ANGAJATOR/, /^SOCIETATEA/, /^PERSOANA JURIDICA/]), r.query("employer")));
      put(out, "employerCui", first(r.regex(CUI_RE, "cui"), r.query("employerCui")));
      put(out, "grossSalary", first(r.kv([/SALARIUL DE BAZA/, /SALARIU(L)? BRUT/]), r.query("grossSalary"), r.regex(/salariul de baz[aă][^0-9]*([\d.,\s]+)\s*(?:lei|ron)/i, "salary")));
      put(out, "startDate", first(r.kv([/DATA INCEPERII/, /INCEPAND CU/]), r.query("startDate")));
      put(out, "endDate", r.kv([/DATA (EXPIRARII|INCETARII)/, /PANA LA DATA/]));
      put(out, "contractDuration", r.regex(/(nedeterminat[aă]|determinat[aă])/i, "duration"));
      put(out, "issueDate", r.kv([/^DATA (INCHEIERII|CONTRACTULUI)/, /^DIN DATA/]));
      break;
    case "payslip":
      put(out, "fullName", first(r.kv([/^NUME/, /^SALARIAT/, /^ANGAJAT$/]), r.query("fullName")));
      put(out, "cnp", validCnp(r));
      put(out, "employer", first(r.kv([/^ANGAJATOR/, /^SOCIETATEA/, /^FIRMA/]), r.query("employer")));
      put(out, "grossSalary", first(r.kv([/SALARIU(L)? (DE BAZA|BRUT)/, /TOTAL BRUT/, /VENIT BRUT/]), r.query("grossSalary")));
      put(out, "netSalary", first(r.kv([/REST DE PLATA/, /SALARIU NET/, /NET DE PLATA/]), r.query("netSalary")));
      put(out, "issueDate", first(r.kv([/^LUNA/, /^PERIOADA/]), r.query("issueDate")));
      break;
    case "debt_declaration":
      put(out, "fullName", first(r.kv([/^SUBSEMNATUL/, /^NUME/]), r.query("fullName")));
      put(out, "cnp", validCnp(r));
      for (const t of r.pages.flatMap((p) => p.tables.map((tb) => ({ tb, page: p.page }))))
        for (const row of t.tb.slice(1)) {
          const amount = row.map((c) => parseAmount(c)).find((n) => n !== undefined && n > 0);
          if (row[0] && amount !== undefined)
            put(out, "declaredDebt", { value: `${row[0]}|${amount}`, page: t.page, confidence: 90, extractor: "table:debts" });
        }
      put(out, "declaresNoDebts", r.regex(/(nu am (alte )?(datorii|credite|obliga[tț]ii))/i, "no-debts"));
      break;
    case "land_register_extract":
      put(out, "cadastralNumber", first(r.regex(/nr\.?\s*cadastral[:\s]*([\d-]+)/i, "cadastral"), r.query("cadastralNumber")));
      put(out, "carteFunciaraNumber", r.regex(/carte(?:a)? funciar[aă] nr\.?\s*([\d]+)/i, "cf"));
      put(out, "propertyAddress", first(r.kv([/^ADRESA/, /^AMPLASAMENT/]), r.query("address")));
      put(out, "issueDate", first(r.kv([/^DATA (EMITERII|ELIBERARII)/]), r.query("issueDate")));
      extractLandRegisterParts(r, out);
      break;
    case "valuation_report":
      put(out, "cadastralNumber", first(r.regex(/nr\.?\s*cadastral[:\s]*([\d-]+)/i, "cadastral"), r.query("cadastralNumber")));
      put(out, "propertyAddress", first(r.kv([/^ADRESA/, /^AMPLASAMENT/]), r.query("address")));
      put(out, "marketValue", first(r.kv([/VALOAREA DE PIATA/, /VALOARE DE PIATA/]), r.query("marketValue")));
      put(out, "marketValueCurrency", r.regex(/valoare(?:a)? de pia[tț][aă][^A-Z]*([\d.,\s]+\s*(?:EUR|RON|LEI|€))/i, "mv-ccy"));
      put(out, "valuationDate", first(r.kv([/DATA EVALUARII/, /DATA RAPORTULUI/]), r.query("issueDate")));
      put(out, "valuerAnevarId", r.regex(/legitima[tț]ie\s+ANEVAR\s*(?:nr\.?)?\s*([\d/]+)/i, "anevar"));
      put(out, "valuerName", r.kv([/^EVALUATOR/, /^INTOCMIT DE/]));
      break;
  }
  // a generic "employer?" query can answer with the employee's own name: drop such an employer
  const person = out.fullName?.[0]?.value;
  if (person && out.employer) {
    out.employer = out.employer.filter((e) => compareNames(e.value, person) === "mismatch");
    if (!out.employer.length) delete out.employer;
  }
  return out;
}

function validCnp(r: DocReader): Candidate | undefined {
  const cands = [r.query("cnp"), r.kv([/^CNP/, /COD NUMERIC PERSONAL/, /PERSONAL NO/]), r.regex(CNP_RE, "cnp")];
  for (const c of cands) {
    const m = c?.value.replace(/\s/g, "").match(/\d{13}/);
    if (c && m && isValidCnp(m[0])) return { ...c, value: m[0] };
  }
  // keep an invalid CNP as evidence too — document verification reports it
  const raw = cands.find((c) => c && /\d{13}/.test(c.value.replace(/\s/g, "")));
  return raw ? { ...raw, value: raw.value.replace(/\s/g, "").match(/\d{13}/)![0] } : undefined;
}

function extractIdentity(r: DocReader, out: Out, now: Date) {
  const lines = r.lines();
  const mrzLines = findMrz(lines.map((l) => l.text));
  const mrz = mrzLines ? parseMrz(mrzLines) : undefined;
  const mrzLine = lines.find((l) => mrzLines && l.text.replace(/\s/g, "").toUpperCase().startsWith(mrzLines[0]!.slice(0, 10)));
  const mrzCand = (value: string, field: string): Candidate => ({
    value,
    page: mrzLine?.page ?? 1,
    bbox: mrzLine?.bbox,
    confidence: mrzLine?.confidence ?? 0,
    extractor: `mrz:${field}`,
  });

  const last = first(r.kv([/^NUME/, /LAST NAME/, /^SURNAME/]), r.afterLabel(/NUME\s*NOM|LAST NAME|SURNAME/, "lastName"));
  const given = first(r.kv([/^PRENUME/, /FIRST NAME/, /GIVEN NAMES?$/]), r.afterLabel(/PRENUME\s*PRENOM|FIRST NAME|GIVEN NAMES?$/, "firstName"));
  if (last && given) {
    put(out, "fullName", { ...given, value: `${given.value} ${last.value}`, extractor: `${given.extractor}+${last.extractor}` });
    put(out, "lastName", last);
  } else put(out, "fullName", r.query("fullName"));

  put(out, "cnp", validCnp(r));
  put(out, "address", first(r.kv([/^DOMICILIU/, /^ADRESSE/, /^ADDRESS/]), r.afterLabel(/^DOMICILIU/, "address"), r.query("address")));
  const series = r.match(/SERIA\s*([A-Z]{2})\s*NR\.?\s*(\d{6})/i, "series");
  put(
    out,
    "documentNumber",
    first(
      series && { ...series.at, value: `${series.m[1]!.toUpperCase()}${series.m[2]}` },
      r.kv([/^SERIE\s*NR/, /^SERIA SI NUMARUL/, /PASS(PORT)? NO/, /^PASAPORT NR/]),
      mrz ? mrzCand(mrz.documentNumber, "documentNumber") : undefined,
      r.query("documentNumber"),
    ),
  );
  // CI prints validity as "15.03.20-15.03.2030"
  const validity = r.match(/(\d{2}\.\d{2}\.\d{2,4})\s*[-–]\s*(\d{2}\.\d{2}\.\d{4})/, "validity");
  put(
    out,
    "expiryDate",
    // no Textract-query fallback here: on cards without a printed validity it answers with another
    // date (e.g. the birth date), which would raise a false "expired" finding
    first(validity && { ...validity.at, value: validity.m[2]! }, r.kv([/VALABILITATE/, /DATE OF EXPIRY/, /EXPIR/])),
  );
  put(out, "birthDate", r.kv([/DATA NASTERII/, /DATE OF BIRTH/, /^DOB$/]));
  put(out, "nationality", r.kv([/^CETATENIE/, /NATIONALITY/]));

  if (mrz && mrzLines) {
    put(out, "mrz", mrzCand(mrzLines.join("\n"), "raw"));
    put(out, "mrzSurname", mrzCand(mrz.surname, "surname"));
    put(out, "mrzGivenNames", mrzCand(mrz.givenNames, "givenNames"));
    put(out, "mrzDocumentNumber", mrzCand(mrz.documentNumber, "documentNumber"));
    put(out, "mrzBirthDate", mrzCand(mrzDateToIso(mrz.birthDate, "birth", now) ?? mrz.birthDate, "birthDate"));
    put(out, "mrzExpiryDate", mrzCand(mrzDateToIso(mrz.expiryDate, "expiry", now) ?? mrz.expiryDate, "expiryDate"));
    put(out, "mrzNationality", mrzCand(mrz.nationality, "nationality"));
    const failed = mrz.checks.filter((c) => !c.ok).map((c) => c.field);
    put(out, "mrzChecks", mrzCand(failed.length ? `failed:${failed.join(",")}` : "ok", "checks"));
    if (!out.nationality) put(out, "nationality", mrzCand(mrz.nationality, "nationality"));
  }
}

function extractStatement(r: DocReader, out: Out) {
  const firstPage = r.pages[0];
  put(out, "fullName", first(r.kv([/^TITULAR/, /^CLIENT/, /^NUME/]), r.query("fullName")));
  put(out, "address", first(r.kv([/^ADRESA/, /^DOMICILIU/]), r.query("address"), r.addressLine()));
  put(out, "iban", first(r.regex(IBAN_RE, "iban"), r.query("iban")));
  put(out, "cnp", validCnp(r));
  const period = r.match(/(\d{2}[./]\d{2}[./]\d{4})\s*[-–]\s*(\d{2}[./]\d{2}[./]\d{4})/, "period");
  if (period) {
    put(out, "periodStart", { ...period.at, value: period.m[1]! });
    put(out, "periodEnd", { ...period.at, value: period.m[2]! });
  }
  put(out, "currency", firstPage ? { value: parseCurrency(firstPage.lines.map((l) => l.text).join(" ")) ?? "RON", page: 1, confidence: 90, extractor: "currency" } : undefined);

  // Salary credits: table rows or lines mentioning salary, with a positive amount.
  for (const p of r.pages) {
    for (const t of p.tables)
      for (const row of t) {
        const joined = foldForMatch(row.join(" "));
        if (!SALARY_CREDIT_RE.test(joined)) continue;
        const amounts = row.map((c) => parseAmount(c)).filter((n): n is number => n !== undefined && n > 100);
        const date = row.map((c) => parseDate(c)).find(Boolean);
        if (amounts.length) {
          put(out, "salaryCredit", { value: String(amounts[amounts.length - 1]), page: p.page, confidence: 90, extractor: "table:salary" });
          put(out, "salaryCreditDate", date ? { value: date, page: p.page, confidence: 90, extractor: "table:salary" } : undefined);
          put(out, "salaryPayer", { value: row.join(" ").replace(/\s+/g, " "), page: p.page, confidence: 90, extractor: "table:salary" });
        }
      }
    if (!out.salaryCredit)
      for (const l of p.lines) {
        if (!SALARY_CREDIT_RE.test(foldForMatch(l.text))) continue;
        const nums = [...l.text.matchAll(/\d[\d.,]*\d/g)].map((m) => parseAmount(m[0])).filter((n): n is number => n !== undefined && n > 100);
        if (nums.length) {
          put(out, "salaryCredit", { value: String(nums[nums.length - 1]), page: p.page, bbox: l.bbox, confidence: l.confidence, extractor: "line:salary" });
          put(out, "salaryPayer", { value: l.text, page: p.page, bbox: l.bbox, confidence: l.confidence, extractor: "line:salary" });
        }
      }
  }
}

function extractLandRegisterParts(r: DocReader, out: Out) {
  const lines = r.lines();
  let part: "I" | "II" | "III" | undefined;
  for (const l of lines) {
    const f = foldForMatch(l.text);
    if (/\bPARTEA III\b/.test(f)) part = "III";
    else if (/\bPARTEA II\b/.test(f)) part = "II";
    else if (/\bPARTEA I\b/.test(f)) part = "I";
    const c: Candidate = { value: l.text, page: l.page, bbox: l.bbox, confidence: l.confidence, extractor: `cf:partea-${part}` };
    if (part === "II" && /\b(PROPRIETAR|PROPRIETATE)\b/.test(f) && /[A-Z]{3,} [A-Z]{3,}/.test(f)) put(out, "owner", c);
    if (part === "III" && /\b(IPOTECA|SECHESTRU|INTERDICTIE|PRIVILEGIU|URMARIRE)\b/.test(f)) put(out, "encumbrance", c);
  }
}
