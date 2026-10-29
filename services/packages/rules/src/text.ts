/**
 * Romanian text folding. Handles both the correct comma-below letters (ș ț, U+0219/U+021B)
 * and the legacy cedilla forms (ş ţ, U+015F/U+0163) that many systems and OCR engines emit.
 */
export function foldDiacritics(s: string): string {
  return s
    .replace(/[șşȘŞ]/g, (c) => (c === c.toLowerCase() ? "s" : "S"))
    .replace(/[țţȚŢ]/g, (c) => (c === c.toLowerCase() ? "t" : "T"))
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

export function hasRomanianDiacritics(s: string): boolean {
  return /[ăâîșşțţĂÂÎȘŞȚŢ]/.test(s);
}

/** Uppercase, diacritics folded, punctuation turned to spaces, whitespace collapsed. */
export function foldForMatch(s: string): string {
  return foldDiacritics(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** Normalise the cedilla forms to comma-below forms, keep other characters. */
export function canonicalRomanian(s: string): string {
  return s.replace(/ş/g, "ș").replace(/Ş/g, "Ș").replace(/ţ/g, "ț").replace(/Ţ/g, "Ț").normalize("NFC");
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aM = new Array<boolean>(a.length).fill(false);
  const bM = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(i + range + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bM[j] || a[i] !== b[j]) continue;
      aM[i] = bM[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aM[i]) continue;
    while (!bM[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}
