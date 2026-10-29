/**
 * ICAO Doc 9303 machine-readable zone parsing and check digits.
 * TD1 (3×30): Romanian electronic ID card (CEI, 2021+).
 * TD2 (2×36): Romanian classic ID card (CI).
 * TD3 (2×44): passports.
 */

const charValue = (c: string): number => {
  if (c === "<") return 0;
  if (c >= "0" && c <= "9") return Number(c);
  if (c >= "A" && c <= "Z") return c.charCodeAt(0) - 55;
  return -1;
};

export function mrzCheckDigit(field: string): number {
  const w = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const v = charValue(field[i]!);
    if (v < 0) return -1;
    sum += v * w[i % 3]!;
  }
  return sum % 10;
}

export type MrzFormat = "TD1" | "TD2" | "TD3";

export type Mrz = {
  format: MrzFormat;
  documentCode: string;
  issuingState: string;
  documentNumber: string;
  birthDate: string; // YYMMDD
  sex: string;
  expiryDate: string; // YYMMDD
  nationality: string;
  surname: string;
  givenNames: string;
  optional: string;
  checks: { field: string; ok: boolean }[];
  valid: boolean;
};

const chk = (data: string, digit: string | undefined) => digit !== undefined && mrzCheckDigit(data) === Number(digit);

/** Common OCR confusions inside MRZ lines (Textract does not know the OCR-B font). */
export function cleanMrzLine(line: string): string {
  return line.toUpperCase().replace(/\s/g, "").replace(/«/g, "<").replace(/[^A-Z0-9<]/g, "<");
}

function splitName(field: string): { surname: string; givenNames: string } {
  const [sur = "", given = ""] = field.split("<<");
  return {
    surname: sur.replace(/</g, " ").trim(),
    givenNames: given.replace(/</g, " ").trim(),
  };
}

export function findMrz(lines: string[]): string[] | undefined {
  // MRZ lines contain only A-Z, 0-9 and '<' (OCR may add spaces or read '<' as '«')
  const cleaned = lines
    .filter((l) => /^[A-Z0-9<«\s]+$/.test(l.trim()))
    .map(cleanMrzLine)
    .filter((l) => l.length >= 28);
  for (const [len, count] of [
    [44, 2],
    [36, 2],
    [30, 3],
  ] as const) {
    const cand = cleaned.filter((l) => Math.abs(l.length - len) <= 1).map((l) => l.padEnd(len, "<").slice(0, len));
    if (cand.length >= count) return cand.slice(-count);
  }
  return undefined;
}

export function parseMrz(lines: string[]): Mrz | undefined {
  const l = lines.map(cleanMrzLine);
  if (l.length === 3 && l.every((x) => x.length === 30)) return parseTd1(l as [string, string, string]);
  if (l.length === 2 && l.every((x) => x.length === 36)) return parseTd2(l as [string, string]);
  if (l.length === 2 && l.every((x) => x.length === 44)) return parseTd3(l as [string, string]);
  return undefined;
}

function finish(m: Omit<Mrz, "valid">): Mrz {
  return { ...m, valid: m.checks.every((c) => c.ok) };
}

function parseTd1([a, b, c]: [string, string, string]): Mrz {
  const docNum = a.slice(5, 14);
  const optional1 = a.slice(15, 30);
  const composite = a.slice(5, 30) + b.slice(0, 7) + b.slice(8, 15) + b.slice(18, 29);
  return finish({
    format: "TD1",
    documentCode: a.slice(0, 2).replace(/</g, ""),
    issuingState: a.slice(2, 5),
    documentNumber: docNum.replace(/</g, ""),
    birthDate: b.slice(0, 6),
    sex: b[7]!,
    expiryDate: b.slice(8, 14),
    nationality: b.slice(15, 18),
    ...splitName(c),
    optional: (optional1 + b.slice(18, 29)).replace(/</g, ""),
    checks: [
      { field: "documentNumber", ok: chk(docNum, a[14]) },
      { field: "birthDate", ok: chk(b.slice(0, 6), b[6]) },
      { field: "expiryDate", ok: chk(b.slice(8, 14), b[14]) },
      { field: "composite", ok: chk(composite, b[29]) },
    ],
  });
}

function parseTd2([a, b]: [string, string]): Mrz {
  const docNum = b.slice(0, 9);
  const composite = b.slice(0, 10) + b.slice(13, 20) + b.slice(21, 35);
  return finish({
    format: "TD2",
    documentCode: a.slice(0, 2).replace(/</g, ""),
    issuingState: a.slice(2, 5),
    ...splitName(a.slice(5)),
    documentNumber: docNum.replace(/</g, ""),
    nationality: b.slice(10, 13),
    birthDate: b.slice(13, 19),
    sex: b[20]!,
    expiryDate: b.slice(21, 27),
    optional: b.slice(28, 35).replace(/</g, ""),
    checks: [
      { field: "documentNumber", ok: chk(docNum, b[9]) },
      { field: "birthDate", ok: chk(b.slice(13, 19), b[19]) },
      { field: "expiryDate", ok: chk(b.slice(21, 27), b[27]) },
      { field: "composite", ok: chk(composite, b[35]) },
    ],
  });
}

function parseTd3([a, b]: [string, string]): Mrz {
  const docNum = b.slice(0, 9);
  const personal = b.slice(28, 42);
  const composite = b.slice(0, 10) + b.slice(13, 20) + b.slice(21, 43);
  return finish({
    format: "TD3",
    documentCode: a.slice(0, 2).replace(/</g, ""),
    issuingState: a.slice(2, 5),
    ...splitName(a.slice(5)),
    documentNumber: docNum.replace(/</g, ""),
    nationality: b.slice(10, 13),
    birthDate: b.slice(13, 19),
    sex: b[20]!,
    expiryDate: b.slice(21, 27),
    optional: personal.replace(/</g, ""),
    checks: [
      { field: "documentNumber", ok: chk(docNum, b[9]) },
      { field: "birthDate", ok: chk(b.slice(13, 19), b[19]) },
      { field: "expiryDate", ok: chk(b.slice(21, 27), b[27]) },
      // personal number check digit may be '<' when the field is empty
      { field: "personalNumber", ok: /^<+$/.test(personal) ? b[42] === "<" || b[42] === "0" : chk(personal, b[42]) },
      { field: "composite", ok: chk(composite, b[43]) },
    ],
  });
}

/** YYMMDD → ISO date. Birth dates pivot on the current year; expiry dates are always 20YY. */
export function mrzDateToIso(yymmdd: string, kind: "birth" | "expiry", now = new Date()): string | undefined {
  if (!/^\d{6}$/.test(yymmdd)) return undefined;
  const yy = Number(yymmdd.slice(0, 2));
  const century = kind === "expiry" ? 2000 : yy > now.getUTCFullYear() % 100 ? 1900 : 2000;
  return `${century + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}
