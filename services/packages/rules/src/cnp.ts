/**
 * Romanian personal numeric code (Cod Numeric Personal), structure S AA LL ZZ JJ NNN C.
 * Reference: Law 119/1996 on civil status documents, art. 6 + HG 64/2011 methodology.
 */

const CNP_WEIGHTS = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];

/** County codes 01–46 (incl. Bucharest sectors 41–46), 47/48 (former Bucharest sectors 7/8), 51/52 (Călărași, Giurgiu), 70 (any registration from 2024). */
const VALID_COUNTY = new Set([
  ...Array.from({ length: 48 }, (_, i) => String(i + 1).padStart(2, "0")),
  "51",
  "52",
  "70",
]);

export type CnpInfo = {
  valid: boolean;
  errors: string[];
  sex?: "M" | "F";
  birthDate?: string; // ISO yyyy-mm-dd
  countyCode?: string;
  foreignResident?: boolean;
};

export function parseCnp(raw: string): CnpInfo {
  const cnp = raw.replace(/\s/g, "");
  const errors: string[] = [];
  if (!/^\d{13}$/.test(cnp)) return { valid: false, errors: ["CNP must have exactly 13 digits"] };

  const d = cnp.split("").map(Number) as number[];
  const s = d[0]!;
  if (s === 0) errors.push("Invalid sex/century digit 0");

  const sum = CNP_WEIGHTS.reduce((acc, w, i) => acc + w * d[i]!, 0);
  const control = sum % 11 === 10 ? 1 : sum % 11;
  if (control !== d[12]) errors.push(`Control digit mismatch (expected ${control}, got ${d[12]})`);

  const yy = Number(cnp.slice(1, 3));
  const mm = Number(cnp.slice(3, 5));
  const dd = Number(cnp.slice(5, 7));
  let century: number | undefined;
  if (s === 1 || s === 2) century = 1900;
  else if (s === 3 || s === 4) century = 1800;
  else if (s === 5 || s === 6) century = 2000;
  // 7/8 = foreign residents, 9 = foreigners: century is not encoded, infer
  const foreignResident = s >= 7;
  if (century === undefined) century = yy <= new Date().getUTCFullYear() % 100 ? 2000 : 1900;

  const year = century + yy;
  const date = new Date(Date.UTC(year, mm - 1, dd));
  const birthOk = mm >= 1 && mm <= 12 && date.getUTCMonth() === mm - 1 && date.getUTCDate() === dd;
  if (!birthOk) errors.push("Encoded birth date is not a valid calendar date");

  const countyCode = cnp.slice(7, 9);
  if (!VALID_COUNTY.has(countyCode)) errors.push(`Unknown county code ${countyCode}`);

  return {
    valid: errors.length === 0,
    errors,
    sex: s === 9 ? undefined : s % 2 === 1 ? "M" : "F",
    birthDate: birthOk ? date.toISOString().slice(0, 10) : undefined,
    countyCode,
    foreignResident,
  };
}

export const isValidCnp = (cnp: string) => parseCnp(cnp).valid;

/** Masks a CNP for display in logs or roles that do not need it: 1******123456 → "1********3456". */
export const maskCnp = (cnp: string) => (cnp.length === 13 ? `${cnp[0]}********${cnp.slice(9)}` : "***");
