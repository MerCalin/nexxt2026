/**
 * Generates SYNTHETIC onboarding (KYC) test cases under fixtures/synthetic-kyc-*.
 * All people, CNPs, addresses and companies are fictional. Dates are relative to today, so
 * re-run this before testing if the fixtures are older than a few weeks (bills expire after 90 days).
 *
 *   bun scripts/generate-kyc-fixtures.ts
 *
 * Output per case: the documents (ID cards/passports as PNG "scans", the rest as PDF), case.json,
 * expected-findings.json. Also writes fixtures/synthetic-onpcsb.csv and merges simulated authority
 * answers into fixtures/scenarios.json.
 */
import fontkit from "@pdf-lib/fontkit";
import { cnp } from "@dc/testkit";
import { mrzCheckDigit } from "@dc/rules";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";

/** FIXTURES_OUT redirects output (e.g. for a dry run); KEEP_PDF=1 keeps the PDF behind each PNG scan. */
const ROOT = process.env.FIXTURES_OUT ?? join(import.meta.dir, "..", "fixtures");
const KEEP_PDF = process.env.KEEP_PDF === "1";
const FONT_DIR = "/usr/share/fonts/liberation-sans-fonts";
const MONO = "/usr/share/fonts/liberation-mono-fonts/LiberationMono-Regular.ttf";

// ------------------------------------------------------------------ dates

const today = new Date();
const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000);
const yearsFrom = (d: Date, y: number) => new Date(Date.UTC(d.getUTCFullYear() + y, d.getUTCMonth(), d.getUTCDate()));
const ro = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
const yymmdd = (d: Date) => `${String(d.getUTCFullYear() % 100).padStart(2, "0")}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

// ------------------------------------------------------------------ people

type Person = {
  surname: string;
  given: string;
  sex: "M" | "F";
  birth: Date;
  county: string; // CNP county code
  seq: string; // 3-digit CNP serial
  address: string; // as printed on the ID card
  birthPlace: string;
};

function personCnp(p: Person): string {
  const y = p.birth.getUTCFullYear();
  const s = y >= 2000 ? (p.sex === "M" ? "5" : "6") : p.sex === "M" ? "1" : "2";
  return cnp(`${s}${yymmdd(p.birth)}${p.county}${p.seq}`);
}

const fullName = (p: Person) => `${p.given} ${p.surname}`;

// ------------------------------------------------------------------ MRZ

const pad = (s: string, n: number) => s.padEnd(n, "<").slice(0, n);
const mrzName = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z]+/g, "<");

/** Romanian classic CI, ICAO TD2 (2 × 36). Optional data = CNP first digit + last 6 digits. */
function td2(p: Person, docNum: string, expiry: Date, tamper?: "docnum-check"): [string, string] {
  const c = personCnp(p);
  const l1 = pad(`IDROU${mrzName(p.surname)}<<${mrzName(p.given)}`, 36);
  const dn = pad(docNum, 9);
  const birth = yymmdd(p.birth);
  const exp = yymmdd(expiry);
  const opt = pad(`${c[0]}${c.slice(7, 13)}`, 7);
  let dnCheck = mrzCheckDigit(dn);
  if (tamper === "docnum-check") dnCheck = (dnCheck + 3) % 10;
  const body = `${dn}${dnCheck}ROU${birth}${mrzCheckDigit(birth)}${p.sex}${exp}${mrzCheckDigit(exp)}${opt}`;
  const composite = body.slice(0, 10) + body.slice(13, 20) + body.slice(21, 35);
  return [l1, body + mrzCheckDigit(composite)];
}

/** Passport, ICAO TD3 (2 × 44). Personal number = CNP. */
function td3(p: Person, passportNo: string, expiry: Date): [string, string] {
  const l1 = pad(`P<ROU${mrzName(p.surname)}<<${mrzName(p.given)}`, 44);
  const dn = pad(passportNo, 9);
  const birth = yymmdd(p.birth);
  const exp = yymmdd(expiry);
  const personal = pad(personCnp(p), 14);
  const body = `${dn}${mrzCheckDigit(dn)}ROU${birth}${mrzCheckDigit(birth)}${p.sex}${exp}${mrzCheckDigit(exp)}${personal}${mrzCheckDigit(personal)}`;
  const composite = body.slice(0, 10) + body.slice(13, 20) + body.slice(21, 43);
  return [l1, body + mrzCheckDigit(composite)];
}

// ------------------------------------------------------------------ PDF helpers

type Fonts = { regular: PDFFont; bold: PDFFont; mono: PDFFont };

async function newDoc(meta: { producer: string; creator?: string; created: Date; modified?: Date; title: string }) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts: Fonts = {
    regular: await doc.embedFont(await Bun.file(`${FONT_DIR}/LiberationSans-Regular.ttf`).arrayBuffer(), { subset: true }),
    bold: await doc.embedFont(await Bun.file(`${FONT_DIR}/LiberationSans-Bold.ttf`).arrayBuffer(), { subset: true }),
    mono: await doc.embedFont(await Bun.file(MONO).arrayBuffer(), { subset: true }),
  };
  doc.setTitle(meta.title);
  doc.setProducer(meta.producer);
  doc.setCreator(meta.creator ?? meta.producer);
  doc.setCreationDate(meta.created);
  doc.setModificationDate(meta.modified ?? meta.created);
  return { doc, fonts };
}

class Writer {
  y: number;
  constructor(
    readonly page: PDFPage,
    readonly f: Fonts,
    readonly x = 50,
  ) {
    this.y = page.getHeight() - 50;
  }
  text(s: string, o: { size?: number; bold?: boolean; mono?: boolean; x?: number; gap?: number; color?: [number, number, number] } = {}) {
    const size = o.size ?? 10;
    this.page.drawText(s, { x: o.x ?? this.x, y: this.y, size, font: o.mono ? this.f.mono : o.bold ? this.f.bold : this.f.regular, color: o.color ? rgb(...o.color) : rgb(0, 0, 0) });
    this.y -= o.gap ?? size * 1.6;
    return this;
  }
  space(n = 8) {
    this.y -= n;
    return this;
  }
  rule() {
    this.page.drawLine({ start: { x: this.x, y: this.y + 6 }, end: { x: this.page.getWidth() - this.x, y: this.y + 6 }, thickness: 0.7, color: rgb(0.6, 0.6, 0.6) });
    this.y -= 8;
    return this;
  }
  /** Bordered table so Textract's TABLES feature picks it up. */
  table(rows: string[][], widths: number[], size = 9) {
    const h = size * 2;
    rows.forEach((row, ri) => {
      let x = this.x;
      row.forEach((cell, ci) => {
        const w = widths[ci]!;
        this.page.drawRectangle({ x, y: this.y - 5, width: w, height: h, borderColor: rgb(0.4, 0.4, 0.4), borderWidth: 0.6, color: ri === 0 ? rgb(0.92, 0.92, 0.92) : undefined });
        this.page.drawText(cell, { x: x + 4, y: this.y + 1, size, font: ri === 0 ? this.f.bold : this.f.regular });
        x += w;
      });
      this.y -= h;
    });
    this.y -= 10;
    return this;
  }
}

async function save(doc: PDFDocument, path: string) {
  // keep the producer/dates set above (pdf-lib would otherwise overwrite them on save)
  writeFileSync(path, await doc.save({ updateFieldAppearances: false }));
}

function toPng(pdfPath: string, pngPath: string) {
  const base = pngPath.replace(/\.png$/, "");
  const r = spawnSync("pdftoppm", ["-png", "-r", "200", "-singlefile", pdfPath, base]);
  if (r.status !== 0) throw new Error(`pdftoppm failed: ${r.stderr}`);
  if (!KEEP_PDF) rmSync(pdfPath);
}

// ------------------------------------------------------------------ documents

async function idCard(dir: string, p: Person, o: { series: string; number: string; issued: Date; expiry: Date; printedExpiry?: Date; tamper?: "docnum-check" }) {
  const { doc, fonts } = await newDoc({ producer: "scanner", title: "CI", created: daysAgo(1) });
  const page = doc.addPage([520, 340]);
  page.drawRectangle({ x: 8, y: 8, width: 504, height: 324, borderColor: rgb(0.3, 0.4, 0.6), borderWidth: 2, color: rgb(0.93, 0.95, 0.98) });
  page.drawRectangle({ x: 26, y: 120, width: 92, height: 118, color: rgb(0.8, 0.82, 0.86) }); // photo
  const w = new Writer(page, fonts, 135);
  w.y = 312;
  w.text("ROMANIA  ROUMANIE  ROMANIA", { bold: true, size: 11, x: 26 });
  w.text("CARTE DE IDENTITATE   IDENTITY CARD", { bold: true, size: 10, x: 26, gap: 18 });
  w.text(`SERIA ${o.series}  NR ${o.number}`, { bold: true, size: 10 });
  w.text(`CNP ${personCnp(p)}`, { bold: true, size: 10, gap: 18 });
  w.text("Nume/Nom/Last name", { size: 7, gap: 10 });
  w.text(p.surname.toUpperCase(), { bold: true, size: 10, gap: 14 });
  w.text("Prenume/Prenom/First name", { size: 7, gap: 10 });
  w.text(p.given.toUpperCase(), { bold: true, size: 10, gap: 14 });
  w.text("Cetățenie/Nationalité/Nationality", { size: 7, gap: 10 });
  w.text(`Română / ROU          Sex/Sexe/Sex  ${p.sex}`, { size: 9, gap: 14 });
  w.text("Loc naștere/Lieu de naissance/Place of birth", { size: 7, gap: 10 });
  w.text(p.birthPlace, { size: 9, gap: 14 });
  w.text("Domiciliu/Adresse/Address", { size: 7, gap: 10 });
  w.text(p.address, { size: 8.5, gap: 14 });
  w.text("Emisă de/Délivrée par/Issued by        Valabilitate/Validité/Validity", { size: 7, gap: 10 });
  w.text(`SPCLEP ${p.birthPlace.split(" ").at(-1)}                        ${ro(o.issued).slice(0, 6)}${String(o.issued.getUTCFullYear()).slice(2)}-${ro(o.printedExpiry ?? o.expiry)}`, { size: 9, gap: 16 });
  const [l1, l2] = td2(p, `${o.series}${o.number}`, o.expiry, o.tamper);
  page.drawText(l1, { x: 26, y: 40, size: 11.5, font: fonts.mono });
  page.drawText(l2, { x: 26, y: 22, size: 11.5, font: fonts.mono });
  const pdf = join(dir, "carte-identitate.pdf");
  await save(doc, pdf);
  toPng(pdf, join(dir, "carte-identitate.png"));
}

async function passport(dir: string, p: Person, o: { number: string; issued: Date; expiry: Date }) {
  const { doc, fonts } = await newDoc({ producer: "scanner", title: "Pasaport", created: daysAgo(1) });
  const page = doc.addPage([620, 420]);
  page.drawRectangle({ x: 8, y: 8, width: 604, height: 404, borderColor: rgb(0.35, 0.2, 0.25), borderWidth: 2, color: rgb(0.97, 0.95, 0.95) });
  page.drawRectangle({ x: 26, y: 140, width: 120, height: 155, color: rgb(0.8, 0.8, 0.82) });
  const w = new Writer(page, fonts, 170);
  w.y = 390;
  w.text("ROMÂNIA   ROMANIA   ROUMANIE", { bold: true, size: 12, x: 26 });
  w.text("PAȘAPORT / PASSPORT / PASSEPORT", { bold: true, size: 11, x: 26, gap: 20 });
  w.text(`Tipul/Type  P        Codul țării/Code  ROU        Pașaport nr./Passport No.  ${o.number}`, { size: 8, gap: 16 });
  w.text("Nume/Surname", { size: 7, gap: 10 });
  w.text(p.surname.toUpperCase(), { bold: true, size: 11, gap: 15 });
  w.text("Prenume/Given names", { size: 7, gap: 10 });
  w.text(p.given.toUpperCase(), { bold: true, size: 11, gap: 15 });
  w.text("Cetățenie/Nationality", { size: 7, gap: 10 });
  w.text("ROMÂNĂ / ROU", { size: 10, gap: 15 });
  w.text("Data nașterii/Date of birth", { size: 7, gap: 10 });
  w.text(`${ro(p.birth)}          Sex  ${p.sex}`, { size: 10, gap: 15 });
  w.text("Cod numeric personal/Personal No.", { size: 7, gap: 10 });
  w.text(personCnp(p), { size: 10, gap: 15 });
  w.text("Data eliberării/Date of issue", { size: 7, gap: 10 });
  w.text(ro(o.issued), { size: 10, gap: 15 });
  w.text("Data expirării/Date of expiry", { size: 7, gap: 10 });
  w.text(ro(o.expiry), { size: 10, gap: 15 });
  const [l1, l2] = td3(p, o.number, o.expiry);
  page.drawText(l1, { x: 26, y: 48, size: 12.5, font: fonts.mono });
  page.drawText(l2, { x: 26, y: 26, size: 12.5, font: fonts.mono });
  const pdf = join(dir, "pasaport.pdf");
  await save(doc, pdf);
  toPng(pdf, join(dir, "pasaport.png"));
}

type BillKind = "water" | "electricity" | "gas";
const BILL: Record<BillKind, { company: string; cui: string; product: string; unit: string; qty: string; price: string; extra: string[]; file: string }> = {
  water: { company: "APA NOVA EXEMPLU S.A.", cui: "RO 12276954", product: "Apă rece", unit: "metri cubi", qty: "8,40", price: "6,12", extra: ["Canalizare și epurare: 8,40 metri cubi"], file: "factura-apa.pdf" },
  electricity: { company: "ENEL ENERGIE EXEMPLU S.A.", cui: "RO 22000460", product: "Energie electrică activă", unit: "kWh", qty: "164", price: "0,68", extra: ["Loc de consum: rezidențial, contor monofazat"], file: "factura-energie.pdf" },
  gas: { company: "ENGIE ROMANIA EXEMPLU S.A.", cui: "RO 13093222", product: "Gaze naturale", unit: "kWh", qty: "1.230", price: "0,31", extra: ["Furnizare gaze naturale — client casnic"], file: "factura-gaze.pdf" },
};

async function bill(dir: string, kind: BillKind, holder: string, address: string, issued: Date, meta?: { producer: string; modified: Date }) {
  const b = BILL[kind];
  const { doc, fonts } = await newDoc({ producer: meta?.producer ?? `${b.company} Billing 4.2`, title: "Factura", created: issued, modified: meta?.modified });
  const page = doc.addPage([595, 842]);
  const w = new Writer(page, fonts);
  w.text(b.company, { bold: true, size: 15 });
  w.text(`CUI ${b.cui}   Reg. Com. J40/0000/2000   Capital social 10.000.000 lei`, { size: 8, gap: 22 });
  w.text("FACTURĂ FISCALĂ", { bold: true, size: 13 });
  w.text(`Seria EX nr. ${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, { size: 10 });
  w.text(`Data emiterii: ${ro(issued)}`, { size: 10 });
  w.text(`Data scadenței: ${ro(new Date(issued.getTime() + 20 * 86_400_000))}`, { size: 10, gap: 20 });
  w.rule();
  w.text(`Client: ${holder}`, { bold: true, size: 11 });
  w.text(`Cod client: ${Math.floor(1_000_000 + Math.random() * 8_999_999)}`, { size: 10 });
  w.text(`Adresa loc de consum: ${address}`, { size: 10, gap: 22 });
  w.rule();
  w.text(`Perioada de facturare: ${ro(new Date(issued.getTime() - 35 * 86_400_000))} - ${ro(new Date(issued.getTime() - 5 * 86_400_000))}`, { size: 10, gap: 18 });
  const qty = Number(b.qty.replace(".", "").replace(",", "."));
  const price = Number(b.price.replace(",", "."));
  const total = (qty * price).toFixed(2).replace(".", ",");
  w.table(
    [
      ["Produs / serviciu", "Cantitate", "UM", "Preț unitar", "Valoare (lei)"],
      [b.product, b.qty, b.unit === "metri cubi" ? "mc" : b.unit, b.price, total],
    ],
    [180, 75, 55, 85, 100],
  );
  for (const e of b.extra) w.text(e, { size: 9 });
  w.space(10);
  w.text(`Total de plată: ${total} lei`, { bold: true, size: 12, gap: 30 });
  w.text("Vă mulțumim că plătiți la timp. Factura poate fi achitată online, la bancă sau la casieriile partenere.", { size: 8 });
  await save(doc, join(dir, b.file));
}

async function bankStatement(dir: string, holder: string, address: string, periodEnd: Date) {
  const { doc, fonts } = await newDoc({ producer: "BANCA EXEMPLU Core Banking Statements 9.1", title: "Extras de cont", created: periodEnd });
  const page = doc.addPage([595, 842]);
  const w = new Writer(page, fonts);
  const start = new Date(periodEnd.getTime() - 29 * 86_400_000);
  w.text("BANCA EXEMPLU S.A.", { bold: true, size: 15 });
  w.text("Sucursala Cluj-Napoca   CUI RO 5022670", { size: 8, gap: 22 });
  w.text("EXTRAS DE CONT", { bold: true, size: 14 });
  w.text(`Perioada ${ro(start)} - ${ro(periodEnd)}`, { size: 10, gap: 18 });
  w.text(`Titular: ${holder}`, { bold: true, size: 11 });
  w.text(`Adresa: ${address}`, { size: 10 });
  w.text("IBAN RO49 AAAA 1B31 0075 9384 0000      Moneda: RON", { size: 10, gap: 20 });
  w.text("Sold inițial: 3.412,18", { size: 10 });
  const d = (n: number) => ro(new Date(start.getTime() + n * 86_400_000));
  w.table(
    [
      ["Data", "Descriere", "Debit", "Credit"],
      [d(2), "Plată POS MEGA IMAGE CLUJ", "143,20", ""],
      [d(6), "Transfer primit DE LA RUSU ANA", "", "250,00"],
      [d(9), "Plată factură utilități", "212,75", ""],
      [d(14), "Retragere numerar ATM", "400,00", ""],
      [d(21), "Plată POS LIBRARIA CARTURESTI", "89,90", ""],
      [d(25), "Abonament telefonie", "54,00", ""],
    ],
    [70, 270, 75, 75],
  );
  w.text("Total debit: 899,85      Total credit: 250,00", { size: 10 });
  w.text("Sold final: 2.762,33", { bold: true, size: 10, gap: 24 });
  w.text("Prezentul extras este generat electronic și este valabil fără semnătură și ștampilă.", { size: 8 });
  await save(doc, join(dir, "extras-de-cont.pdf"));
}

async function domicileCertificate(dir: string, p: Person, issued: Date) {
  const { doc, fonts } = await newDoc({ producer: "DEPABD Sistem Evidența Persoanelor", title: "Certificat de domiciliu", created: issued });
  const page = doc.addPage([595, 842]);
  const w = new Writer(page, fonts);
  w.text("ROMÂNIA", { bold: true, size: 12 });
  w.text("MINISTERUL AFACERILOR INTERNE — DIRECȚIA GENERALĂ PENTRU EVIDENȚA PERSOANELOR (DGEP)", { size: 8, gap: 30 });
  w.text("CERTIFICAT DE DOMICILIU", { bold: true, size: 16, gap: 28 });
  w.text(`Nr. ${Math.floor(100_000 + Math.random() * 899_999)}`, { size: 10 });
  w.text(`Data emiterii: ${ro(issued)}`, { size: 10, gap: 20 });
  w.text(`Titular: ${p.surname.toUpperCase()} ${p.given.toUpperCase()}`, { bold: true, size: 11 });
  w.text(`CNP: ${personCnp(p)}`, { size: 10 });
  w.text(`Domiciliu: ${p.address}`, { size: 10, gap: 22 });
  w.text("Se certifică faptul că persoana menționată mai sus are domiciliul la adresa indicată, conform evidenței persoanelor.", { size: 9 });
  await save(doc, join(dir, "certificat-domiciliu.pdf"));
}

// ------------------------------------------------------------------ cases

type CaseOut = {
  name: string;
  title: string;
  person: Person;
  consents?: string[];
  build: (dir: string) => Promise<void>;
  expect: { lane: string; codes: string[]; absent?: string[] };
  note: string;
};

const ALL_CONSENTS = ["criminal_record_lookup", "anaf_tax_debt_lookup"];
const ADDR = {
  lalelelor: "Mun. București Sec. 3 Str. Lalelelor nr. 12 bl. A4 sc. 2 et. 3 ap. 45",
  lalelelorBill: "Str. Lalelelor nr. 12, bl. A4, sc. 2, ap. 45, Mun. București, Sector 3",
};

const P = {
  ion: { surname: "Popescu", given: "Ion", sex: "M", birth: new Date(Date.UTC(1985, 2, 15)), county: "40", seq: "012", address: ADDR.lalelelor, birthPlace: "Mun. București Sec. 1" },
  maria: { surname: "Ionescu", given: "Maria", sex: "F", birth: new Date(Date.UTC(1992, 6, 3)), county: "41", seq: "238", address: "Mun. București Sec. 1 Str. Avram Iancu nr. 5 ap. 3", birthPlace: "Mun. București Sec. 1" },
  andrei: { surname: "Dumitru", given: "Andrei", sex: "M", birth: new Date(Date.UTC(1978, 10, 21)), county: "12", seq: "441", address: "Mun. Cluj-Napoca Jud. Cluj Str. Fabricii nr. 18 ap. 7", birthPlace: "Mun. Cluj-Napoca" },
  elena: { surname: "Stan", given: "Elena", sex: "F", birth: new Date(Date.UTC(1995, 0, 30)), county: "22", seq: "117", address: "Mun. Iași Jud. Iași Str. Florilor nr. 7 bl. C2 sc. A ap. 14", birthPlace: "Mun. Iași" },
  ioana: { surname: "Marinescu", given: "Ioana", sex: "F", birth: new Date(Date.UTC(1990, 4, 9)), county: "35", seq: "302", address: "Mun. Timișoara Jud. Timiș Str. Paris nr. 3 ap. 9", birthPlace: "Mun. Timișoara" },
  tudor: { surname: "Constantin", given: "Tudor", sex: "M", birth: new Date(Date.UTC(1983, 8, 12)), county: "46", seq: "555", address: "Mun. București Sec. 6 Bd. Iuliu Maniu nr. 61 bl. 4 sc. 1 ap. 22", birthPlace: "Mun. București Sec. 6" },
  radu: { surname: "Georgescu", given: "Radu", sex: "M", birth: new Date(Date.UTC(1990, 6, 22)), county: "12", seq: "001", address: "", birthPlace: "Mun. Cluj-Napoca" },
  serban: { surname: "Vlădescu", given: "Șerban", sex: "M", birth: new Date(Date.UTC(1966, 1, 4)), county: "40", seq: "778", address: "Mun. București Sec. 1 Str. Nordului nr. 90", birthPlace: "Mun. București Sec. 1" },
  ana: { surname: "Munteanu", given: "Ana", sex: "F", birth: new Date(Date.UTC(1998, 11, 1)), county: "04", seq: "190", address: "Mun. Bacău Jud. Bacău Str. Mărășești nr. 40 ap. 2", birthPlace: "Mun. Bacău" },
  victor: { surname: "Neagu", given: "Victor", sex: "M", birth: new Date(Date.UTC(1975, 3, 17)), county: "02", seq: "631", address: "Mun. Arad Jud. Arad Str. Mețianu nr. 11", birthPlace: "Mun. Arad" },
  cristina: { surname: "Lupu", given: "Cristina", sex: "F", birth: new Date(Date.UTC(1988, 9, 5)), county: "08", seq: "214", address: "Mun. Brașov Jud. Brașov Str. Lungă nr. 120 ap. 4", birthPlace: "Mun. Brașov" },
  mihai: { surname: "Toma", given: "Mihai", sex: "M", birth: new Date(Date.UTC(1981, 5, 28)), county: "13", seq: "822", address: "Mun. Constanța Jud. Constanța Bd. Tomis nr. 200 bl. T5 ap. 31", birthPlace: "Mun. Constanța" },
} satisfies Record<string, Person>;

/** Same address, formatted the way a utility company prints it. */
const billAddress = (p: Person) =>
  p.address === ADDR.lalelelor ? ADDR.lalelelorBill : p.address.replace(/^(Mun\. [^ ]+(?: Sec\. \d)?(?: Jud\. [^ ]+)?) (.*)$/, "$2, $1");

const validId = (series: string, number: string) => ({ series, number, issued: yearsFrom(today, -3), expiry: yearsFrom(today, 7) });

const CASES: CaseOut[] = [
  {
    name: "synthetic-kyc-01-clean",
    title: "Clean onboarding: CI + water bill, same person, same address",
    person: P.ion,
    build: async (dir) => {
      await idCard(dir, P.ion, validId("XV", "123456"));
      await bill(dir, "water", "POPESCU ION", billAddress(P.ion), daysAgo(20));
    },
    expect: { lane: "ready_for_officer", codes: [], absent: ["XREF_NAME_MISMATCH", "XREF_ADDRESS_MISMATCH", "XREF_CNP_MISMATCH", "DOCVER_EXPIRED", "DOCVER_MRZ_CHECK_FAILED", "CLASS_MISSING_REQUIRED"] },
    note: "Baseline. Needs ONPCSB_LIST_FILE set (see README) — otherwise the ONPCSB check is blocked and the lane is human_review.",
  },
  {
    name: "synthetic-kyc-02-gas-bill-rejected",
    title: "Gas bill is not an acceptable proof of address",
    person: P.maria,
    build: async (dir) => {
      await idCard(dir, P.maria, validId("RD", "654321"));
      await bill(dir, "gas", "IONESCU MARIA", billAddress(P.maria), daysAgo(15));
    },
    expect: { lane: "needs_info", codes: ["CLASS_REJECTED_POA", "CLASS_MISSING_REQUIRED"] },
    note: "Customer message should ask for a domicile certificate / water or electricity bill / notary contract / statement with address.",
  },
  {
    name: "synthetic-kyc-03-expired-id",
    title: "ID card expired 8 months ago",
    person: P.andrei,
    build: async (dir) => {
      await idCard(dir, P.andrei, { series: "KX", number: "908172", issued: yearsFrom(daysAgo(240), -10), expiry: daysAgo(240) });
      await bill(dir, "electricity", "DUMITRU ANDREI", billAddress(P.andrei), daysAgo(30));
    },
    expect: { lane: "human_review", codes: ["DOCVER_EXPIRED"] },
    note: "Expired identity document is high severity.",
  },
  {
    name: "synthetic-kyc-04-address-mismatch",
    title: "Water bill at a different address than the ID card",
    person: P.elena,
    build: async (dir) => {
      await idCard(dir, P.elena, validId("MX", "445566"));
      await bill(dir, "water", "STAN ELENA", "Bd. Independenței nr. 21, ap. 6, Mun. Iași, Jud. Iași", daysAgo(10));
    },
    expect: { lane: "needs_info", codes: ["XREF_ADDRESS_MISMATCH"] },
    note: "Customer is asked to confirm the current address. Investigation may suggest a recent move.",
  },
  {
    name: "synthetic-kyc-05-maiden-name",
    title: "Electricity bill still in the customer's maiden name",
    person: P.ioana,
    build: async (dir) => {
      await idCard(dir, P.ioana, validId("TZ", "778899"));
      await bill(dir, "electricity", "DRAGOMIR IOANA", billAddress(P.ioana), daysAgo(25));
    },
    expect: { lane: "human_review", codes: ["XREF_NAME_MISMATCH"] },
    note: "Same first name and address, different surname — the Investigation agent should offer a maiden-name hypothesis (as a hypothesis, not a conclusion).",
  },
  {
    name: "synthetic-kyc-06-mrz-tampered",
    title: "MRZ document-number check digit is wrong",
    person: P.tudor,
    build: async (dir) => {
      await idCard(dir, P.tudor, { ...validId("RR", "246810"), tamper: "docnum-check" });
      await domicileCertificate(dir, P.tudor, daysAgo(40));
    },
    expect: { lane: "human_review", codes: ["DOCVER_MRZ_CHECK_FAILED"] },
    note: "Uses a domicile certificate as proof of address.",
  },
  {
    name: "synthetic-kyc-07-passport-statement",
    title: "Passport + bank statement showing the address",
    person: P.radu,
    build: async (dir) => {
      await passport(dir, P.radu, { number: "054987321", issued: yearsFrom(today, -2), expiry: yearsFrom(today, 3) });
      await bankStatement(dir, "GEORGESCU RADU", "Str. Mihai Eminescu nr. 45 bl. M3 sc. B ap. 12, Mun. Cluj-Napoca, Jud. Cluj", daysAgo(6));
    },
    expect: { lane: "ready_for_officer", codes: [], absent: ["CLASS_STATEMENT_NO_ADDRESS", "CLASS_MISSING_REQUIRED", "DOCVER_MRZ_CHECK_FAILED"] },
    note: "A statement with the holder's address is acceptable proof of residence. Needs ONPCSB_LIST_FILE set.",
  },
  {
    name: "synthetic-kyc-08-pep",
    title: "Customer matches the (simulated) PEP list",
    person: P.serban,
    build: async (dir) => {
      await idCard(dir, P.serban, validId("RT", "135790"));
      await bill(dir, "electricity", "VLĂDESCU ȘERBAN", billAddress(P.serban), daysAgo(12));
    },
    expect: { lane: "human_review", codes: ["PEP_MATCH", "AML_RISK_HIGH"] },
    note: "Compliance-only findings: a credit/KYC officer sees only 'compliance_review' and cannot approve; log in as Conformitate to see details.",
  },
  {
    name: "synthetic-kyc-09-no-consent",
    title: "Clean documents but no consent recorded for Phase 3 lookups",
    person: P.ana,
    consents: [],
    build: async (dir) => {
      await idCard(dir, P.ana, validId("XC", "112233"));
      await bill(dir, "water", "MUNTEANU ANA", billAddress(P.ana), daysAgo(18));
    },
    expect: { lane: "human_review", codes: ["BANKVER_BLOCKED"] },
    note: "Criminal record and ANAF lookups are BLOCKED, never silently skipped. Record the consents in the UI and re-run to clear it.",
  },
  {
    name: "synthetic-kyc-10-criminal-record",
    title: "Simulated criminal record (cazier) hit",
    person: P.victor,
    build: async (dir) => {
      await idCard(dir, P.victor, validId("AR", "556677"));
      await bill(dir, "water", "NEAGU VICTOR", billAddress(P.victor), daysAgo(22));
    },
    expect: { lane: "human_review", codes: ["BANKVER_CRIMINAL_RECORD"] },
    note: "Visible only to Conformitate; other roles see the neutral message 'Verificare finalizată – contactați departamentul Conformitate.'",
  },
  {
    name: "synthetic-kyc-11-edited-bill",
    title: "Electricity bill PDF re-saved with an image editor",
    person: P.cristina,
    build: async (dir) => {
      await idCard(dir, P.cristina, validId("BV", "998877"));
      await bill(dir, "electricity", "LUPU CRISTINA", billAddress(P.cristina), daysAgo(14), { producer: "Adobe Photoshop 25.0 (Windows)", modified: daysAgo(2) });
    },
    expect: { lane: "human_review", codes: ["FRAUD_EDITOR_SOFTWARE", "FRAUD_MODIFIED_AFTER_CREATION"] },
    note: "Customer message must stay neutral (no mention of fraud or editing).",
  },
  {
    name: "synthetic-kyc-12-stale-bill",
    title: "Water bill is 5 months old",
    person: P.mihai,
    build: async (dir) => {
      await idCard(dir, P.mihai, validId("KT", "334455"));
      await bill(dir, "water", "TOMA MIHAI", billAddress(P.mihai), daysAgo(150));
    },
    expect: { lane: "needs_info", codes: ["DOCVER_STALE"] },
    note: "Proof of address must be at most 90 days old; the customer is asked for a recent one.",
  },
];

// ------------------------------------------------------------------ write

const readme: string[] = [
  "# Synthetic KYC (onboarding) cases",
  "",
  `Generated ${ro(today)} by \`bun scripts/generate-kyc-fixtures.ts\`. All persons, CNPs, addresses and companies are fictional.`,
  "Re-generate before testing if older than ~4 weeks (bill recency is checked against today).",
  "",
  "Set `ONPCSB_LIST_FILE=<repo>/services/fixtures/synthetic-onpcsb.csv` (a fictional stand-in list) so the clean cases are not blocked on ONPCSB.",
  "",
  "| Case | Scenario | Expected lane | Expected findings |",
  "|---|---|---|---|",
];

for (const c of CASES) {
  const dir = join(ROOT, c.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await c.build(dir);
  writeFileSync(join(dir, "case.json"), `${JSON.stringify({ workflow: "onboarding", subject: { customerRef: c.name.replace("synthetic-", "").toUpperCase() }, consents: c.consents ?? ALL_CONSENTS }, null, 2)}\n`);
  writeFileSync(join(dir, "expected-findings.json"), `${JSON.stringify(c.expect, null, 2)}\n`);
  readme.push(`| \`${c.name}\` | ${c.title}. ${c.note} | ${c.expect.lane} | ${c.expect.codes.map((x) => `\`${x}\``).join(", ") || "—"} |`);
  console.log(`✓ ${c.name}  (${fullName(c.person)}, CNP ${personCnp(c.person)})`);
}
readme.push("", "Each folder: documents (ID as PNG scan, others as PDF), `case.json` (workflow, subject, consents), `expected-findings.json`.");
writeFileSync(join(ROOT, "SYNTHETIC-KYC.md"), `${readme.join("\n")}\n`);

// fictional ONPCSB stand-in list (no one in the cases is on it)
writeFileSync(
  join(ROOT, "synthetic-onpcsb.csv"),
  "name,birthDate,citizenship,reference\nFICTIV EXEMPLU PRIMUL,1970-01-01,ROU,TEST-001\nFICTIV EXEMPLU AL DOILEA,1965-06-15,ROU,TEST-002\n",
);

// merge simulated authority answers into scenarios.json
const scenariosPath = join(ROOT, "scenarios.json");
const scenarios = (await Bun.file(scenariosPath).json()) as { persons: Record<string, unknown>; pep: { name: string; birthDate?: string; position: string; country: string }[]; [k: string]: unknown };
scenarios.persons[personCnp(P.victor)] = { criminalRecord: { hasRecord: true, entries: [{ offence: "art. 244 C.pen. — înșelăciune (SIMULAT)", date: "2019-05-14", final: true }] } };
scenarios.pep = scenarios.pep.filter((x) => x.name !== "Șerban Vlădescu");
scenarios.pep.push({ name: "Șerban Vlădescu", birthDate: "1966-02-04", position: "Secretar de stat (exemplu simulat)", country: "ROU" });
writeFileSync(scenariosPath, `${JSON.stringify(scenarios, null, 2)}\n`);
console.log("\n✓ fixtures/SYNTHETIC-KYC.md, synthetic-onpcsb.csv, scenarios.json updated");
