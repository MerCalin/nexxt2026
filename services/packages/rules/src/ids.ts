/** Romanian fiscal code (CUI / CIF) checksum. Reference: OMFP 1.135/2011 algorithm, key 753217532. */
export function isValidCui(raw: string): boolean {
  const cui = raw.toUpperCase().replace(/^RO/, "").replace(/\s/g, "");
  if (!/^\d{2,10}$/.test(cui)) return false;
  const digits = cui.split("").map(Number);
  const control = digits.pop()!;
  const key = [7, 5, 3, 2, 1, 7, 5, 3, 2];
  const padded = Array(9 - digits.length).fill(0).concat(digits) as number[];
  const sum = padded.reduce((acc, dgt, i) => acc + dgt * key[i]!, 0);
  let c = (sum * 10) % 11;
  if (c === 10) c = 0;
  return c === control;
}

/** ISO 13616 IBAN check (mod 97); Romanian IBANs are 24 characters. */
export function isValidIban(raw: string): boolean {
  const iban = raw.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  if (iban.startsWith("RO") && iban.length !== 24) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}
