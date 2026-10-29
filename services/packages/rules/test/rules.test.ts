import { describe, expect, test } from "bun:test";
import {
  annuityInstalment,
  canonicalJson,
  compareAddresses,
  compareNames,
  findMrz,
  foldForMatch,
  isValidCui,
  isValidIban,
  mrzCheckDigit,
  parseAddress,
  parseAmount,
  parseCnp,
  parseDate,
  parseMrz,
} from "../src";

/** Build a CNP with a correct control digit from its first 12 digits. */
export function cnpWithControl(first12: string): string {
  const w = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const sum = first12.split("").reduce((a, d, i) => a + Number(d) * w[i]!, 0);
  return first12 + String(sum % 11 === 10 ? 1 : sum % 11);
}

describe("CNP", () => {
  test("valid CNP decodes sex, birth date and county", () => {
    const cnp = cnpWithControl("185031540012"); // M, 1985-03-15, county 40 (Bucharest S1)
    const info = parseCnp(cnp);
    expect(info.valid).toBe(true);
    expect(info.sex).toBe("M");
    expect(info.birthDate).toBe("1985-03-15");
    expect(info.countyCode).toBe("40");
  });

  test("2000s female", () => {
    expect(parseCnp(cnpWithControl("602122912345")).birthDate).toBe("2002-12-29");
  });

  test("bad control digit, bad date, bad county", () => {
    const good = cnpWithControl("185031540012");
    const bad = good.slice(0, 12) + String((Number(good[12]) + 1) % 10);
    expect(parseCnp(bad).valid).toBe(false);
    expect(parseCnp(cnpWithControl("185023040012")).errors.join()).toContain("birth date");
    expect(parseCnp(cnpWithControl("185031599012")).errors.join()).toContain("county");
    expect(parseCnp("123").valid).toBe(false);
  });
});

describe("CUI / IBAN", () => {
  test("CUI checksum", () => {
    expect(isValidCui("14399840")).toBe(true);
    expect(isValidCui("RO14399840")).toBe(true);
    expect(isValidCui("14399841")).toBe(false);
  });
  test("IBAN mod 97", () => {
    expect(isValidIban("RO49 AAAA 1B31 0075 9384 0000")).toBe(true);
    expect(isValidIban("RO49AAAA1B31007593840001")).toBe(false);
    expect(isValidIban("RO49AAAA1B3100759384000")).toBe(false);
  });
});

describe("MRZ (ICAO 9303 specimen data)", () => {
  test("check digit", () => {
    expect(mrzCheckDigit("L898902C3")).toBe(6);
    expect(mrzCheckDigit("740812")).toBe(2);
  });
  test("TD3 passport", () => {
    const m = parseMrz([
      "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
      "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
    ])!;
    expect(m.format).toBe("TD3");
    expect(m.surname).toBe("ERIKSSON");
    expect(m.givenNames).toBe("ANNA MARIA");
    expect(m.valid).toBe(true);
  });
  test("TD1 card", () => {
    const m = parseMrz([
      "I<UTOD231458907<<<<<<<<<<<<<<<",
      "7408122F1204159UTO<<<<<<<<<<<6",
      "ERIKSSON<<ANNA<MARIA<<<<<<<<<<",
    ])!;
    expect(m.format).toBe("TD1");
    expect(m.documentNumber).toBe("D23145890");
    expect(m.valid).toBe(true);
  });
  test("TD2 card + tampered expiry fails", () => {
    const lines = ["I<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<", "D231458907UTO7408122F1204159<<<<<<<6"];
    expect(parseMrz(lines)!.valid).toBe(true);
    const tampered = parseMrz([lines[0]!, "D231458907UTO7408122F1304159<<<<<<<6"])!;
    expect(tampered.valid).toBe(false);
    expect(tampered.checks.find((c) => c.field === "expiryDate")!.ok).toBe(false);
  });
  test("findMrz picks MRZ lines out of OCR text", () => {
    const found = findMrz([
      "ROMANIA",
      "CARTE DE IDENTITATE",
      "I<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<",
      "D231458907UTO7408122F1204159<<<<<<<6",
    ]);
    expect(found?.length).toBe(2);
  });
});

describe("names", () => {
  test("diacritics: comma vs cedilla vs none", () => {
    expect(compareNames("Ștefănescu Ioana", "Ştefănescu Ioana")).toBe("diacritics_only");
    expect(compareNames("STEFANESCU IOANA", "Ștefănescu Ioana")).toBe("exact"); // OCR dropped diacritics
    expect(foldForMatch("Țăranu-Ștefan")).toBe("TARANU STEFAN");
  });
  test("reorder, subset, near, mismatch", () => {
    expect(compareNames("POPESCU ION", "Ion Popescu")).toBe("token_reorder");
    expect(compareNames("Ion Popescu", "Ion Alexandru Popescu")).toBe("subset");
    expect(compareNames("Ion Popescu", "Ion Popesku")).toBe("near");
    expect(compareNames("Ion Popescu", "Maria Ionescu")).toBe("mismatch");
  });
});

describe("addresses", () => {
  const ci = "Mun. București Sec. 3 Str. Lalelelor nr. 12 bl. A4 sc. 2 et. 3 ap. 45";
  test("parse", () => {
    const a = parseAddress(ci);
    expect(a.street).toBe("LALELELOR");
    expect(a.number).toBe("12");
    expect(a.block).toBe("A4");
    expect(a.apartment).toBe("45");
  });
  test("compare", () => {
    expect(compareAddresses(ci, "STRADA LALELELOR NR 12, BL A4, SC 2, AP 45, BUCURESTI")).toBe("same");
    expect(compareAddresses(ci, "Str. Lalelelor nr. 12 bl. A4 sc. 2 ap. 46 București")).toBe("same_building");
    expect(compareAddresses(ci, "Str. Lalelelor nr. 14 București")).toBe("same_street");
    expect(compareAddresses(ci, "Bd. Unirii nr. 1 București")).toBe("different");
  });
});

describe("values", () => {
  test("amounts", () => {
    expect(parseAmount("4.500,50 lei")).toBe(4500.5);
    expect(parseAmount("4 500,50 RON")).toBe(4500.5);
    expect(parseAmount("4,500.50")).toBe(4500.5);
    expect(parseAmount("12.000")).toBe(12000);
    expect(parseAmount("3500")).toBe(3500);
    expect(parseAmount("12,5")).toBe(12.5);
    expect(parseAmount("n/a")).toBeUndefined();
  });
  test("dates", () => {
    expect(parseDate("15.03.2024")).toBe("2024-03-15");
    expect(parseDate("2024-03-15")).toBe("2024-03-15");
    expect(parseDate("15 martie 2024")).toBe("2024-03-15");
    expect(parseDate("31.02.2024")).toBeUndefined();
  });
  test("annuity", () => {
    expect(Math.round(annuityInstalment(100_000, 6, 240))).toBe(716);
  });
  test("canonical json sorts keys", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});
