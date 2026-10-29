/**
 * Regulatory parameters. Every value carries its legal source and must be confirmed by the
 * bank's Compliance function before production use (`confirmedByCompliance`).
 */

export type RuleParam<T> = { value: T; source: string; confirmedByCompliance: boolean };

const p = <T>(value: T, source: string): RuleParam<T> => ({ value, source, confirmedByCompliance: false });

// ---------- Affordability (BNR Regulation 17/2012, as amended by Reg. 6/2018) ----------

export const DTI_LIMITS = {
  /** Max total debt service / net income for loans in the currency of income (RON). */
  localCurrency: p(0.4, "BNR Reg. 17/2012 art. 24^1 (as amended by Reg. 6/2018)"),
  /** Loans in foreign currency or indexed to it, unhedged borrowers. */
  foreignCurrency: p(0.2, "BNR Reg. 17/2012 art. 24^1 (as amended by Reg. 6/2018)"),
  /** Uplift for a loan to acquire the borrower's first home. */
  firstHomeUplift: p(0.05, "BNR Reg. 17/2012 art. 24^1 para. (3)"),
};

/** Stress-test buffer applied to variable-rate loans when computing the instalment. */
export const RATE_STRESS_PP = p(2.0, "BNR Reg. 17/2012 art. 24^2 — stress scenario (to be confirmed)");

// ---------- Collateral (BNR Reg. 17/2012 annex — LTV limits for mortgage loans) ----------

export const LTV_LIMITS: Record<string, RuleParam<number>> = {
  RON: p(0.85, "BNR Reg. 17/2012 annex, LTV for RON mortgage loans"),
  EUR: p(0.8, "BNR Reg. 17/2012 annex, LTV for EUR mortgage loans (borrower with EUR income: 0.80, otherwise 0.75)"),
  OTHER: p(0.6, "BNR Reg. 17/2012 annex, LTV for other currencies"),
};

/** Valuation must be performed by an ANEVAR-authorised valuer and be recent. */
export const VALUATION_MAX_AGE_DAYS = p(180, "ANEVAR SEV 2022 / bank credit policy");

// ---------- Document recency (bank KYC policy under Law 129/2019 art. 11) ----------

export const RECENCY_DAYS: Record<string, RuleParam<number>> = {
  utility_bill_water: p(90, "Bank KYC policy — proof of address no older than 3 months"),
  utility_bill_electricity: p(90, "Bank KYC policy — proof of address no older than 3 months"),
  domicile_certificate: p(180, "Bank KYC policy"),
  bank_statement: p(30, "Bank credit policy — statement period end within 30 days"),
  payslip: p(60, "Bank credit policy"),
  land_register_extract: p(30, "Law 7/1996 + bank policy — extras de carte funciară pentru informare ≤ 30 zile"),
  valuation_report: p(180, "ANEVAR SEV / bank credit policy"),
};

// ---------- KYC refresh (Law 129/2019 art. 13 para. (1)(d), risk-based) ----------

export const KYC_REFRESH_MONTHS: Record<"low" | "medium" | "high", RuleParam<number>> = {
  low: p(60, "Law 129/2019 art. 13 + BNR Reg. 2/2019 art. 21 — bank risk-based policy"),
  medium: p(36, "Law 129/2019 art. 13 + BNR Reg. 2/2019 art. 21 — bank risk-based policy"),
  high: p(12, "Law 129/2019 art. 13 + BNR Reg. 2/2019 art. 21 — bank risk-based policy"),
};

// ---------- AML (Law 129/2019 art. 17; EU Delegated Reg. 2016/1675 as amended) ----------

/**
 * High-risk third countries with strategic AML/CFT deficiencies, per Commission Delegated
 * Regulation (EU) 2016/1675 as amended (latest amendment applied: 2025). ISO 3166-1 alpha-3.
 * MUST be re-verified against the Official Journal on every amendment.
 */
export const HIGH_RISK_THIRD_COUNTRIES = p<string[]>(
  [
    "AFG", "DZA", "AGO", "BFA", "CMR", "CIV", "COD", "HTI", "IRN", "KEN", "LAO", "LBN", "MLI", "MCO",
    "MOZ", "MMR", "NAM", "NPL", "NGA", "PRK", "ZAF", "SSD", "SYR", "TZA", "TTO", "VUT", "VEN", "VNM", "YEM",
  ],
  "Commission Delegated Regulation (EU) 2016/1675 as amended — verify against current OJ",
);

export const AML_WEIGHTS = {
  pep: p(40, "Law 129/2019 art. 17 para. (1)(b) — PEP requires EDD"),
  highRiskCountry: p(40, "Law 129/2019 art. 17 para. (1)(a)"),
  sanctionsPossibleMatch: p(50, "Law 129/2019 + Reg. (EU) 2580/2001 — restrictive measures"),
  sourceOfFundsNotEvidenced: p(20, "Law 129/2019 art. 13 para. (1)(c)"),
  nonResident: p(10, "Law 129/2019 annex 2 — geographical risk factors"),
  documentFraudSignal: p(25, "Law 129/2019 annex 2 — product/transaction risk"),
};

export const AML_BANDS = { medium: 20, high: 40 } as const;

// ---------- Matching tolerances ----------

/** Relative tolerance between contract salary and average salary credits on the statement. */
/** Net/gross ratio for a standard employment contract: CAS 25 % + CASS 10 %, then 10 % income tax. */
export const NET_TO_GROSS_RATIO = p(0.585, "Codul fiscal (Law 227/2015) art. 138, 156, 64 — before personal deduction");
export const INCOME_TOLERANCE = p(0.1, "Bank credit policy");
export const MIN_OCR_CONFIDENCE = p(80, "Internal quality threshold (Textract confidence %)");
export const SANCTIONS_MATCH_THRESHOLD = p(0.88, "Internal screening calibration (Jaro-Winkler on folded names)");
export const SANCTIONS_LIST_MAX_AGE_HOURS = p(24, "Law 129/2019 art. 26 + ONPCSB guidance — lists applied without delay");
