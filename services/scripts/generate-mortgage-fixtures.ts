/**
 * Generates SYNTHETIC mortgage documents (land-register extract + valuation report) to pair with a
 * customer's identity / residence / employment / statement files, plus SIMULATED land-register (ANCPI)
 * entries in fixtures/scenarios.json. All data is fictional; dates are relative to today.
 *
 *   bun scripts/generate-mortgage-fixtures.ts
 *
 * Output: fixtures/synthetic-mortgage-a-clean/ and fixtures/synthetic-mortgage-b-problems/
 */
import fontkit from "@pdf-lib/fontkit";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, type PDFFont, rgb } from "pdf-lib";

const ROOT = process.env.FIXTURES_OUT ?? join(import.meta.dir, "..", "fixtures");
const FONT_DIR = "/usr/share/fonts/liberation-sans-fonts";
const today = new Date();
const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000);
const ro = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;

async function pdf(title: string, producer: string, created: Date, lines: { text: string; size?: number; bold?: boolean; gap?: number }[]) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular: PDFFont = await doc.embedFont(await Bun.file(`${FONT_DIR}/LiberationSans-Regular.ttf`).arrayBuffer(), { subset: true });
  const bold: PDFFont = await doc.embedFont(await Bun.file(`${FONT_DIR}/LiberationSans-Bold.ttf`).arrayBuffer(), { subset: true });
  doc.setTitle(title);
  doc.setProducer(producer);
  doc.setCreator(producer);
  doc.setCreationDate(created);
  doc.setModificationDate(created);
  let page = doc.addPage([595, 842]);
  let y = 792;
  for (const l of lines) {
    const size = l.size ?? 10;
    if (y < 60) {
      page = doc.addPage([595, 842]);
      y = 792;
    }
    if (l.text) page.drawText(l.text, { x: 50, y, size, font: l.bold ? bold : regular, color: rgb(0, 0, 0) });
    y -= l.gap ?? size * 1.7;
  }
  return doc.save();
}

type Variant = {
  folder: string;
  title: string;
  cadastral: string;
  valuationCadastral: string;
  address: string;
  owners: string[];
  encumbrancesOnExtract: string[];
  registry: { owners: { name: string; share: string }[]; encumbrances: { type: string; holder: string; registeredAt: string }[] };
  marketValue: number;
  extractAge: number;
  valuationAge: number;
  loan: { amount: number; currency: string; termMonths: number; annualRatePct: number; purchasePrice: number };
  isFirstHome: boolean;
  expect: string[];
};

const VARIANTS: Variant[] = [
  {
    folder: "synthetic-mortgage-a-clean",
    title: "Purchase of a first home; extract, register and valuation consistent; LTV 75 %",
    cadastral: "231457",
    valuationCadastral: "231457",
    address: "Str. Lalelelor nr. 12, ap. 7, Mun. Timișoara, Jud. Timiș",
    owners: ["1. IONESCU MARIA, proprietar, cota 1/1"],
    encumbrancesOnExtract: [],
    registry: { owners: [{ name: "IONESCU MARIA", share: "1/1" }], encumbrances: [] },
    marketValue: 420_000,
    extractAge: 5,
    valuationAge: 20,
    loan: { amount: 300_000, currency: "RON", termMonths: 360, annualRatePct: 6.9, purchasePrice: 400_000 },
    isFirstHome: true,
    expect: ["no collateral findings", "LTV 0.75 (limit 0.85)", "DTI ≈ 44 % against the 45 % first-home limit → AFFORD_DTI_NEAR_LIMIT (low)"],
  },
  {
    folder: "synthetic-mortgage-b-problems",
    title: "Existing mortgage, seizure hidden from the uploaded extract, cadastral mismatch, LTV 95 %",
    cadastral: "318902",
    valuationCadastral: "318920",
    address: "Bd. Revoluției nr. 5, ap. 21, Mun. Timișoara, Jud. Timiș",
    owners: ["1. POPA ANDREI, proprietar, cota 1/1"],
    encumbrancesOnExtract: ["1. Intabulare drept de IPOTECĂ în favoarea BANCA BETA S.A., act nr. 4512/2019"],
    registry: {
      owners: [{ name: "POPA ANDREI", share: "1/1" }],
      encumbrances: [
        { type: "ipotecă", holder: "BANCA BETA S.A.", registeredAt: "2019-06-11" },
        { type: "sechestru asigurator", holder: "ANAF — DGRFP Timișoara", registeredAt: "2026-08-02" },
      ],
    },
    marketValue: 410_000,
    extractAge: 12,
    valuationAge: 30,
    loan: { amount: 380_000, currency: "RON", termMonths: 360, annualRatePct: 6.9, purchasePrice: 400_000 },
    isFirstHome: false,
    expect: ["COLL_ENCUMBRANCE (ipotecă on the extract)", "COLL_EXTRACT_REGISTRY_MISMATCH (register has 2 encumbrances, extract 1)", "COLL_CADASTRAL_MISMATCH (318902 vs 318920)", "COLL_LTV_EXCEEDED (95 % > 85 %)", "AFFORD_DTI_EXCEEDED"],
  },
];

const SELLER_NOTE = "Imobil dobândit prin contract de vânzare-cumpărare autentificat.";

for (const v of VARIANTS) {
  const dir = join(ROOT, v.folder);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const issued = daysAgo(v.extractAge);
  const valued = daysAgo(v.valuationAge);

  writeFileSync(
    join(dir, "extras-carte-funciara.pdf"),
    await pdf("Extras de carte funciara", "ANCPI e-Terra Extrase 3.4", issued, [
      { text: "AGENȚIA NAȚIONALĂ DE CADASTRU ȘI PUBLICITATE IMOBILIARĂ (ANCPI)", size: 9, bold: true },
      { text: "Oficiul de Cadastru și Publicitate Imobiliară Timiș (OCPI)", size: 9, gap: 26 },
      { text: "EXTRAS DE CARTE FUNCIARĂ PENTRU INFORMARE", size: 14, bold: true, gap: 26 },
      { text: `Carte Funciară nr. ${v.cadastral} Timișoara`, size: 11, bold: true },
      { text: `Nr. cadastral: ${v.cadastral}`, size: 10 },
      { text: `Data eliberării: ${ro(issued)}`, size: 10, gap: 24 },
      { text: "PARTEA I. Descrierea imobilului", size: 11, bold: true },
      { text: `Adresa: ${v.address}`, size: 10 },
      { text: "Apartament cu 3 camere, suprafață utilă 74 mp, cotă indiviză din părțile comune.", size: 10, gap: 24 },
      { text: "PARTEA II. Proprietari și acte", size: 11, bold: true },
      ...v.owners.map((o) => ({ text: o, size: 10 })),
      { text: SELLER_NOTE, size: 9, gap: 24 },
      { text: "PARTEA III. Sarcini", size: 11, bold: true },
      ...(v.encumbrancesOnExtract.length ? v.encumbrancesOnExtract.map((e) => ({ text: e, size: 10 })) : [{ text: "Nu sunt înscrise sarcini.", size: 10 }]),
      { text: "", gap: 30 },
      { text: "Extrasul de carte funciară pentru informare nu este valabil la autentificarea actelor juridice.", size: 8 },
    ]),
  );

  writeFileSync(
    join(dir, "raport-evaluare.pdf"),
    await pdf("Raport de evaluare", "EVAL Expert Raportare 2026", valued, [
      { text: "RAPORT DE EVALUARE", size: 16, bold: true, gap: 22 },
      { text: "Întocmit conform Standardelor de Evaluare ANEVAR (SEV 2022) în scopul garantării unui împrumut", size: 9, gap: 24 },
      { text: "Evaluator: EVALUATOR AUTORIZAT EXEMPLU SRL", size: 10 },
      { text: "Evaluator autorizat: ing. Radu Exemplu, legitimație ANEVAR nr. 12345", size: 10 },
      { text: `Data evaluării: ${ro(valued)}`, size: 10, gap: 24 },
      { text: "Identificarea proprietății", size: 11, bold: true },
      { text: `Adresa: ${v.address}`, size: 10 },
      { text: `Nr. cadastral: ${v.valuationCadastral}, înscris în Cartea Funciară a localității Timișoara`, size: 10 },
      { text: "Tip: apartament, 3 camere, 74 mp utili, an construcție 1985, renovat 2021", size: 10, gap: 24 },
      { text: "Abordări utilizate: abordarea prin piață (comparații directe), abordarea prin venit", size: 10, gap: 24 },
      { text: "Opinia evaluatorului", size: 11, bold: true },
      { text: `Valoarea de piață: ${v.marketValue.toLocaleString("de-DE")} RON`, size: 12, bold: true },
      { text: "Valoarea este exprimată fără TVA și este valabilă la data evaluării.", size: 9 },
    ]),
  );

  writeFileSync(
    join(dir, "case.json"),
    `${JSON.stringify(
      {
        workflow: "mortgage",
        subject: { customerRef: `BADEA-GABRIEL-${v.folder.includes("-a-") ? "A" : "B"}`, declaredSourceOfFunds: "salariu", isFirstHome: v.isFirstHome, loan: v.loan },
        consents: ["credit_bureau_lookup", "criminal_record_lookup", "anaf_tax_debt_lookup"],
        pairWith: "~/Downloads/hackerton/Badea_Gabriel_12 (1_ID_Card.png, 3_Residence_Doc.png, 4_Employment.png, 5_Payments_Report.pdf)",
        expect: v.expect,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`✓ ${v.folder}  — ${v.title}`);
}

// SIMULATED ANCPI register entries, keyed by cadastral number
const scenariosPath = join(ROOT, "scenarios.json");
const scenarios = (await Bun.file(scenariosPath).json()) as { landRegister: Record<string, unknown> };
for (const v of VARIANTS)
  scenarios.landRegister[v.cadastral] = { cadastralNumber: v.cadastral, carteFunciaraNumber: v.cadastral, uat: "Timișoara", ...v.registry };
writeFileSync(scenariosPath, `${JSON.stringify(scenarios, null, 2)}\n`);
console.log("✓ scenarios.json: land-register entries added (restart the service to load them)");
