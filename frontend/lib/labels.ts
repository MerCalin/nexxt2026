import type { Lane, Role, Severity, Workflow } from "./types";

export const WORKFLOW_LABEL: Record<Workflow, string> = { onboarding: "Deschidere cont (KYC)", loan: "Credit de consum", mortgage: "Credit ipotecar" };
export const ROLE_LABEL: Record<Role, string> = { credit_officer: "Ofițer credite", kyc_officer: "Ofițer KYC", compliance: "Conformitate" };
export const LANE_LABEL: Record<Lane, string> = { ready_for_officer: "Pregătit pentru decizie", needs_info: "Necesită informații de la client", human_review: "Necesită analiză umană" };
export const SEVERITY_LABEL: Record<Severity, string> = { info: "Info", low: "Scăzută", medium: "Medie", high: "Ridicată" };

export const AGENT_LABEL: Record<string, string> = {
  classification: "Clasificare",
  extraction: "Extragere",
  "document-verification": "Verificare documente",
  "cross-reference": "Comparare între documente",
  "risk-fraud": "Risc și fraudă",
  "sanctions-pep": "Sancțiuni și PEP",
  "aml-risk": "Risc AML",
  "kyc-freshness": "Actualitate KYC",
  "credit-history": "Istoric de credit",
  affordability: "Grad de îndatorare",
  collateral: "Garanție imobiliară",
  "bank-verification": "Verificări la autorități",
  investigation: "Investigație (AI)",
  triage: "Triere",
  "summary-communication": "Rezumat și comunicare (AI)",
};

export const CONSENT_LABEL: Record<string, string> = {
  credit_bureau_lookup: "Consultare Biroul de Credit / CRC",
  criminal_record_lookup: "Verificare cazier judiciar (direct la IGPR)",
  anaf_tax_debt_lookup: "Verificare datorii fiscale ANAF",
};

export const DOC_TYPE_LABEL: Record<string, string> = {
  id_card: "Carte de identitate",
  passport: "Pașaport",
  domicile_certificate: "Certificat de domiciliu",
  utility_bill_water: "Factură apă",
  utility_bill_electricity: "Factură energie electrică",
  utility_bill_rejected: "Factură neacceptată (telefon/internet/gaze)",
  notary_contract: "Contract notarial",
  bank_statement: "Extras de cont",
  employment_contract: "Contract de muncă",
  payslip: "Fluturaș de salariu",
  debt_declaration: "Declarație datorii",
  land_register_extract: "Extras de carte funciară",
  valuation_report: "Raport de evaluare",
  unknown: "Neclasificat",
};

/** Current GDPR Art. 13 data-processing notice version shown to customers before Phase 3 lookups. */
export const NOTICE_VERSION = "NOTA-INFORMARE-2026-10";
