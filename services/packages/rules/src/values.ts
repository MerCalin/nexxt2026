import { foldForMatch } from "./text";

/**
 * Parse an amount written in Romanian ("4.500,50 lei", "4 500,50 RON") or international ("4,500.50") style.
 * Returns undefined when the text contains no number.
 */
export function parseAmount(raw: string): number | undefined {
  const m = raw.replace(/ /g, " ").match(/-?\d[\d .,']*/);
  if (!m) return undefined;
  let s = m[0].replace(/[ ']/g, "").replace(/[.,]$/, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // both present: the last one is the decimal separator
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (lastDot > -1) {
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function parseCurrency(raw: string): string | undefined {
  const f = foldForMatch(raw);
  if (/\b(RON|LEI|LEU)\b/.test(f)) return "RON";
  if (/\bEUR(O)?\b/.test(f) || raw.includes("€")) return "EUR";
  if (/\bUSD\b/.test(f) || raw.includes("$")) return "USD";
  return undefined;
}

const RO_MONTHS: Record<string, number> = {
  IANUARIE: 1, IAN: 1, FEBRUARIE: 2, FEB: 2, MARTIE: 3, MAR: 3, APRILIE: 4, APR: 4, MAI: 5,
  IUNIE: 6, IUN: 6, IULIE: 7, IUL: 7, AUGUST: 8, AUG: 8, SEPTEMBRIE: 9, SEP: 9, SEPT: 9,
  OCTOMBRIE: 10, OCT: 10, NOIEMBRIE: 11, NOI: 11, NOV: 11, DECEMBRIE: 12, DEC: 12,
};

const iso = (y: number, m: number, d: number): string | undefined => {
  if (y < 100) y += y > 50 ? 1900 : 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return dt.toISOString().slice(0, 10);
};

/** Parse dd.mm.yyyy, dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd, "12 martie 2024". Returns ISO date. */
export function parseDate(raw: string): string | undefined {
  const s = raw.trim();
  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/);
  if (m) return iso(+m[3]!, +m[2]!, +m[1]!);
  const f = foldForMatch(s);
  m = f.match(/\b(\d{1,2}) ([A-Z]+) (\d{4})\b/);
  if (m && RO_MONTHS[m[2]!]) return iso(+m[3]!, RO_MONTHS[m[2]!]!, +m[1]!);
  return undefined;
}

export const daysBetween = (fromIso: string, to: Date): number =>
  Math.floor((to.getTime() - new Date(`${fromIso}T00:00:00Z`).getTime()) / 86_400_000);

export function addMonths(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Annuity instalment for a fixed-rate loan. */
export function annuityInstalment(principal: number, annualRatePct: number, termMonths: number): number {
  const r = annualRatePct / 100 / 12;
  if (r === 0) return principal / termMonths;
  return (principal * r) / (1 - (1 + r) ** -termMonths);
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
