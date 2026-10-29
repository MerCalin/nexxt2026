import { foldForMatch, hasRomanianDiacritics, jaroWinkler } from "./text";

export type NameComparison =
  | "exact"
  | "diacritics_only" // ION POPESCU vs ION POPESCU with ș/ş/ă differences
  | "token_reorder" // POPESCU ION vs ION POPESCU
  | "subset" // ION POPESCU vs ION ALEXANDRU POPESCU (missing middle name)
  | "near" // likely OCR or spelling variant, JW >= 0.92
  | "mismatch";

export const normalizeName = (s: string) =>
  foldForMatch(s)
    .split(" ")
    .filter((t) => t.length > 0)
    .join(" ");

const tokens = (s: string) => normalizeName(s).split(" ").filter(Boolean).sort();

export function compareNames(a: string, b: string): NameComparison {
  if (a.trim().toUpperCase() === b.trim().toUpperCase()) return "exact";
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) {
    // differences are only in diacritics; only meaningful when both sides carry diacritics
    return hasRomanianDiacritics(a) && hasRomanianDiacritics(b) ? "diacritics_only" : "exact";
  }
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.join(" ") === tb.join(" ")) return "token_reorder";
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (small.length >= 2 && small.every((t) => big.includes(t))) return "subset";
  if (jaroWinkler(ta.join(" "), tb.join(" ")) >= 0.92) return "near";
  return "mismatch";
}

/** Screening similarity 0..1 between a query name and a list name (order- and diacritic-insensitive). */
export function nameMatchScore(query: string, candidate: string): number {
  const q = tokens(query).join(" ");
  const c = tokens(candidate).join(" ");
  if (!q || !c) return 0;
  if (q === c) return 1;
  const qt = q.split(" ");
  const ct = c.split(" ");
  // token-set score: each query token's best match among candidate tokens
  const tokenScore = qt.reduce((a, t) => a + Math.max(...ct.map((x) => jaroWinkler(t, x))), 0) / qt.length;
  const coverage = Math.min(qt.length, ct.length) / Math.max(qt.length, ct.length);
  return Math.max(jaroWinkler(q, c), tokenScore * (0.85 + 0.15 * coverage));
}

/** Severity guidance for cross-reference findings; "exact" produces no finding. */
export const NAME_COMPARISON_SEVERITY: Record<Exclude<NameComparison, "exact">, "info" | "low" | "medium" | "high"> = {
  diacritics_only: "info",
  token_reorder: "info",
  subset: "low",
  near: "medium",
  mismatch: "high",
};
