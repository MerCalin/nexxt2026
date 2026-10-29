# Document types and extracted fields (data-set reference)

Source of truth: `services/packages/contracts/src/index.ts` (types), `services/packages/agents/classification/src/index.ts`
(keywords), `services/packages/agents/extraction/src/index.ts` (fields), `services/packages/agents/document-verification/src/index.ts`
and `services/packages/rules/src/tables.ts` (checks). Update this file when those change.

Matching rules:
- Labels and keywords are matched **diacritic-insensitive and case-insensitive** (`Data emiterii:` = `DATA EMITERII`).
- Classification needs a keyword **score ≥ 5**; weights are in parentheses.
- If a label is not found, Textract's 15 generic Queries are the fallback for most fields.
- Write dates as `dd.mm.yyyy`.

---

## 1. `id_card` — Carte de identitate (CI classic / CEI electronic)

**Keywords:** `CARTE DE IDENTITATE` / `CARTE ELECTRONICA DE IDENTITATE` (5), `IDROU` (5, MRZ), `SPCLEP` (2), `DOMICILIU` (1), `VALABILITATE` (1).

| Field | Source / printed as |
|---|---|
| `fullName` | built from **Prenume** + **Nume**: label line `Nume/Nom/Last name` with value on the next line, or KV `Nume:` / `Prenume:` |
| `lastName` | the `Nume` value |
| `cnp` | 13 digits, e.g. `CNP 1850315400125` — must pass the checksum |
| `documentNumber` | `SERIA XV NR 123456`, KV `Serie/Nr:` / `Pass No.` / `Pașaport nr.`, else from MRZ |
| `expiryDate` | validity range `15.03.20-15.03.2030` (end date used), or `Valabilitate:` |
| `birthDate` | `Data nașterii:` / `Date of birth` / `DOB` (optional; normally derived from CNP) |
| `address` | (must contain letters — a date or number in the field is ignored) label line `Domiciliu/Adresse/Address` + value on next line, e.g. `Mun. București Sec. 3 Str. Lalelelor nr. 12 bl. A4 sc. 2 et. 3 ap. 45` |
| `nationality` | `Cetățenie:` or MRZ (`ROU`) |
| `mrz`, `mrzSurname`, `mrzGivenNames`, `mrzDocumentNumber`, `mrzBirthDate`, `mrzExpiryDate`, `mrzNationality`, `mrzChecks` | decoded from the MRZ — 2 lines × 36 chars (classic CI, TD2) or 3 × 30 (CEI, TD1), with valid check digits |

**Checks:** expired (high), expiring ≤ 30 days (low), CNP valid, MRZ check digits, MRZ ↔ printed surname / number / expiry, CNP birth date ↔ MRZ birth date, OCR confidence ≥ 80 %.

## 2. `passport` — Pașaport

**Keywords:** `PASAPORT` (5), `PASSPORT` (4), `PASSEPORT` (3), `P<ROU` (5), `TIPUL TYPE` (1).

Same fields as `id_card` **without `address`**; English labels `SURNAME`, `GIVEN NAME(S)`, `DOB`, `PASS NO.` are read too. MRZ is 2 × 44 (TD3). CNP printed as `Cod numeric personal / Personal No.`.
**Checks:** same as `id_card`. Not a proof of address.

## 3. `domicile_certificate` — Certificat de domiciliu

**Keywords:** `CERTIFICAT DE DOMICILIU` / `DOVADĂ (DE) REȘEDINȚĂ` / `CERTIFICAT DE REȘEDINȚĂ` (6), `ADEVERINTA DE DOMICILIU` (4), `DOVADA DOMICILIULUI` (3), `DGEP` (2), `EVIDENTA PERSOANELOR` (2).

| Field | Printed as |
|---|---|
| `fullName` | `Titular:` / `Client:` / `Nume și prenume:` / `Nume:` / `Beneficiar:` |
| `address` | `Adresa:` / `Domiciliu:` / `Loc de consum:` / `Adresa de consum:`, or any address-looking line (street + `nr.`) |
| `issueDate` | `Data emiterii:` / `Data facturii:` / `Data facturării:` / `Eliberat la data de:` / `Data:`, else first date on the page |
| `cnp` | `CNP:` |

**Checks:** ≤ 180 days old.

## 4. `utility_bill_water` — Factură apă

**Keywords:** `APA NOVA` / `APA CANAL` / `APAVITAL` / `COMPANIA DE APA` (5), `APA RECE` (3), `CANALIZARE` (3), `METRI CUBI` (2), `MC` (1), `FACTURA` (1).
**Fields:** same as §3. **Checks:** ≤ 90 days old.

## 5. `utility_bill_electricity` — Factură energie electrică

**Keywords:** `ENERGIE ELECTRICA` / `ENEL ENERGIE` / `ELECTRICA FURNIZARE` / `PPC ENERGIE` (5), `HIDROELECTRICA` / `CEZ VANZARE` (4), `KWH` (2), `LOC DE CONSUM` (1), `FACTURA` (1).
**Fields:** same as §3. **Checks:** ≤ 90 days old.

## 6. `utility_bill_rejected` — telephone / internet / gas / TV (NOT accepted)

**Keywords:** `GAZE NATURALE` (6), `TELEFONIE` / `TELEFON MOBIL` (5), `INTERNET` (4), `RCS RDS` / `ORANGE ROMANIA` / `VODAFONE` / `TELEKOM` / `ABONAMENT TV` (4), `DIGI` (3), `CABLU` (2), `FACTURA` (1).
**Fields:** same as §3. Always raises `CLASS_REJECTED_POA` → customer asked for a valid proof of address. Use as a negative test.

## 7. `notary_contract` — Contract notarial (sale / rental)

**Keywords:** `CONTRACT NOTARIAL` (6), `NOTAR PUBLIC` / `BIROU NOTARIAL` / `INCHEIERE DE AUTENTIFICARE` (5), `CONTRACT DE VANZARE CUMPARARE` / `CONTRACT DE INCHIRIERE` (4), `AUTENTIFICAT` (2).
**Fields:** same as §3. No age limit.

## 8. `bank_statement` — Extras de cont

**Keywords:** `EXTRAS DE CONT` (6), `EXTRAS CONT` (5), `SOLD INITIAL` / `SOLD FINAL` / `SOLD PRECEDENT` (3), `TOTAL DEBIT` / `TOTAL CREDIT` (2), `IBAN` (1), `PERIOADA` (1).

| Field | Printed as |
|---|---|
| `fullName` | `Titular:` / `Client:` / `Nume:` |
| `address` | `Adresa:` / `Domiciliu:` or an address line on **page 1** — without it the statement is not proof of address (`CLASS_STATEMENT_NO_ADDRESS`) |
| `iban` | `RO49 AAAA 1B31 0075 9384 0000` (valid mod-97, 24 chars) |
| `cnp` | `CNP:` (optional) |
| `periodStart`, `periodEnd` | `Perioada 01.10.2026 - 25.10.2026` |
| `currency` | `RON` / `LEI` / `EUR` anywhere on page 1 (default RON) |
| `salaryCredit` (multiple) | **table row** containing `SALARIU` / `SALAR` / `PLATA SAL…` / `DREPTURI SALARIALE` / `VENIT SALARIAL` and an amount > 100, e.g. `10.10.2026 \| PLATA SALARIU ACME SOFTWARE SRL \| 4.700,00` (falls back to plain lines if no table) |
| `salaryCreditDate` | the date in that row |
| `salaryPayer` | the row text — should contain the **employer name** from the contract |

**Checks:** period end ≤ 30 days old, IBAN valid, salary dates inside the period, average salary vs contract/payslip, payer = employer, fraud metadata (editor or office-suite producer, modified after creation, incremental PDF updates).

## 9. `employment_contract` — Contract individual de muncă

**Keywords:** `CONTRACT INDIVIDUAL DE MUNCA` (7), `CONTRACT (DE) MUNCĂ` (6), `SALARIUL DE BAZA` (3), `ANGAJATOR` / `SALARIAT` / `DURATA NEDETERMINATA` / `CODUL MUNCII` / `REVISAL` (2).

| Field | Printed as |
|---|---|
| `fullName` | `Salariat:` / `Nume și prenume:` / `Domnul:` / `Doamna:` |
| `cnp` | `CNP:` |
| `address` | `Domiciliat în:` / `Domiciliu:` / `Cu domiciliul în:` |
| `employer` | `Angajator:` / `Societatea:` / `Persoana juridică:` — e.g. `ACME SOFTWARE SRL` |
| `employerCui` | `CUI 14399840` / `CIF RO14399840` / `Cod fiscal …` (must pass checksum) |
| `grossSalary` | `Salariul de bază lunar brut: 8.000 lei` |
| `startDate` | `Data începerii activității:` / `Începând cu:` |
| `endDate` | `Data expirării:` / `Data încetării:` / `Până la data:` (fixed-term only) |
| `contractDuration` | words `nedeterminată` / `determinată` |
| `issueDate` | `Data încheierii:` / `Data contractului:` / `Din data:` |

**Checks:** CUI valid; fixed-term contract already ended; net estimate (gross × 0.585) vs statement salary credits (−10 % / +20 % tolerance).

## 10. `payslip` — Fluturaș de salariu (optional)

**Keywords:** `FLUTURAS DE SALARIU` (7), `FLUTURAS` (6), `STAT DE PLATA` / `REST DE PLATA` (4), `SALARIU NET` (3), `CAS` / `CASS` (1).

| Field | Printed as |
|---|---|
| `fullName` | `Nume:` / `Salariat:` / `Angajat:` |
| `cnp` | `CNP:` |
| `employer` | `Angajator:` / `Societatea:` / `Firma:` |
| `grossSalary` | `Salariu de bază:` / `Salariu brut:` / `Total brut:` / `Venit brut:` |
| `netSalary` | `Rest de plată:` / `Salariu net:` / `Net de plată:` |
| `issueDate` | `Luna:` / `Perioada:` — **use a full date** (`31.10.2026`); `octombrie 2026` is not parsed → reported as undated |

**Checks:** ≤ 60 days old; net within 10 % of average statement salary credit; employer = contract employer.

## 11. `debt_declaration` — Declarație privind datoriile (optional)

**Keywords:** `PROPRIE RASPUNDERE` / `DATORII` / `OBLIGATII DE PLATA` / `CREDITE IN CURS` (3), `DECLARATIE` (2).

| Field | Printed as |
|---|---|
| `fullName` | `Subsemnatul:` / `Nume:` |
| `cnp` | `CNP:` |
| `declaredDebt` (multiple) | a **table** with a header row; one row per debt, **first column = lender**, any column with the monthly instalment, e.g. `BANCA ALFA \| credit nevoi personale \| 900` |
| `declaresNoDebts` | sentence `Nu am (alte) datorii` / `nu am credite` / `nu am obligații` |

**Checks:** debts in Credit Bureau / CRC missing from the declaration (high if the customer declared "no debts").

## 12. `land_register_extract` — Extras de carte funciară (mortgage)

**Keywords:** `EXTRAS DE CARTE FUNCIARA` (7), `CARTE FUNCIARA NR` (4), `ANCPI` / `OCPI` (3), `NR CADASTRAL` (2), `PARTEA I` / `PARTEA II` / `PARTEA III` (1 each).

| Field | Printed as |
|---|---|
| `cadastralNumber` | `Nr. cadastral 123456` |
| `carteFunciaraNumber` | `Carte funciară nr. 123456` |
| `propertyAddress` | `Adresa:` / `Amplasament:` |
| `issueDate` | `Data emiterii:` / `Data eliberării:` |
| `owner` (multiple) | lines **after a `PARTEA II` heading** containing `proprietar`/`proprietate` and a name in capitals, e.g. `1. POPESCU ION, proprietar, cota 1/1` |
| `encumbrance` (multiple) | lines **after a `PARTEA III` heading** containing `IPOTECĂ` / `SECHESTRU` / `INTERDICȚIE` / `PRIVILEGIU` / `URMĂRIRE` |

**Checks:** ≤ 30 days old; for refinancing (no purchase price) owner must be the applicant; ipotecă = medium, sechestru/urmărire/interdicție = high; cadastral number = valuation report; comparison with the (simulated) ANCPI register.

## 13. `valuation_report` — Raport de evaluare (mortgage)

**Keywords:** `RAPORT DE EVALUARE` (7), `ANEVAR` (5), `VALOARE DE PIATA` / `EVALUATOR AUTORIZAT` (4), `SEV` (1).

| Field | Printed as |
|---|---|
| `cadastralNumber` | `Nr. cadastral 123456` |
| `propertyAddress` | `Adresa:` / `Amplasament:` |
| `marketValue` | `Valoarea de piață: 420.000 RON` |
| `marketValueCurrency` | currency right after that amount (`RON` / `LEI` / `EUR` / `€`) |
| `valuationDate` | `Data evaluării:` / `Data raportului:` |
| `valuerAnevarId` | `legitimație ANEVAR nr. 12345` |
| `valuerName` | `Evaluator:` / `Întocmit de:` |

**Checks:** ≤ 180 days old; ANEVAR id present; LTV = loan / min(market value, purchase price) ≤ 85 % RON / 80 % EUR; value currency must equal loan currency.

## 14. `unknown`

Anything scoring < 5 on every keyword list → `CLASS_UNKNOWN`, skipped by extraction.

---

## Non-document inputs per case

**`case.json`** (integration runs; in the UI these come from the "Dosar nou" form and consent panel):
```json
{
  "workflow": "onboarding | loan | mortgage",
  "subject": {
    "customerRef": "CUST-0001",
    "declaredSourceOfFunds": "salariu",
    "isFirstHome": true,
    "loan": { "amount": 100000, "currency": "RON", "termMonths": 120, "annualRatePct": 7, "purchasePrice": 420000 }
  },
  "consents": ["credit_bureau_lookup", "criminal_record_lookup", "anaf_tax_debt_lookup"]
}
```

**`services/fixtures/scenarios.json`** — SIMULATED authority answers:
- `persons[<CNP>]`: `creditBureau`, `centralCreditRegister` (`{ records: [...], insolvency }`), `anaf` (`{ hasDebt, amountRon, asOf }`), `criminalRecord` (`{ hasRecord, entries }`), or `"unavailable"` for any of them.
- `landRegister[<cadastral number>]`: `{ cadastralNumber, carteFunciaraNumber, uat, owners: [{name, share}], encumbrances: [{type, holder, registeredAt}] }` — unknown numbers are "unavailable".
- `kyc[<customerRef>]`: existing KYC file `{ fullName, cnp, address, idDocumentNumber, idDocumentExpiry, riskLevel, lastReviewAt }`.
- `pep`: `[{ name, birthDate, position, country }]`.

**Required documents per workflow:**
- onboarding = ID card or passport + one proof of address
- loan = onboarding + employment contract + bank statement (payslip, debt declaration optional)
- mortgage = loan + land-register extract + valuation report

## Data-set tips

- Keep the **same person consistent** across a case (name, CNP, address, employer); derive each negative variant by changing **one thing**: other apartment number, expired ID, salary 30 % lower, gas bill instead of water bill, MRZ check digit off by one, PDF saved from Photoshop.
- Generate valid CNPs with `cnp()` in `services/packages/testkit/src/index.ts`; MRZ check digits with `mrzCheckDigit()` from `@dc/rules`; valid CUI example `14399840`, valid IBAN example `RO49AAAA1B31007593840000`.
- One document per file; 150–300 DPI or sharp photos; MRZ fully visible.
- Use **fictional** names, CNPs and IBANs — especially in the US-region workshop account.
