import { describe, expect, test } from "bun:test";
import { parseEuFsf, parseOfac, parseUn, SanctionsListAdapter, scoreName, searchEntries } from "../src";

const EU_XML = `<?xml version="1.0"?>
<export generationDate="2026-10-27T10:00:00">
  <sanctionEntity logicalId="13" euReferenceNumber="EU.27.28">
    <subjectType code="person" classificationCode="P"/>
    <regulation programme="SYR"/>
    <nameAlias wholeName="Ivan Petrovich Sidorov"/>
    <nameAlias wholeName="Ivan Sidorov"/>
    <birthdate birthdate="1971-05-04" year="1971"/>
    <citizenship countryIso2Code="RU"/>
  </sanctionEntity>
  <sanctionEntity logicalId="14"><subjectType code="enterprise" classificationCode="E"/><nameAlias wholeName="Acme Arms Ltd"/></sanctionEntity>
</export>`;

const UN_XML = `<CONSOLIDATED_LIST dateGenerated="2026-10-26">
  <INDIVIDUALS><INDIVIDUAL><DATAID>1</DATAID><REFERENCE_NUMBER>QDi.001</REFERENCE_NUMBER>
    <FIRST_NAME>ABDUL</FIRST_NAME><SECOND_NAME>RAHMAN</SECOND_NAME><UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE>
    <NATIONALITY><VALUE>Yemen</VALUE></NATIONALITY>
    <INDIVIDUAL_ALIAS><ALIAS_NAME>Abu Rahman</ALIAS_NAME></INDIVIDUAL_ALIAS>
    <INDIVIDUAL_DATE_OF_BIRTH><YEAR>1965</YEAR></INDIVIDUAL_DATE_OF_BIRTH>
  </INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>`;

const SDN = `36,"AEROCARIBBEAN AIRLINES",-0-,"CUBA",-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-
7157,"POPESCU, Mihai Andrei","individual","SDGT",-0-,-0-,-0-,-0-,-0-,-0-,-0-,"DOB 12 Mar 1980; nationality Romania; Passport 0000."`;
const ALT = `7157,1,"aka","POPESKU, Mihai",-0-`;

describe("list parsers", () => {
  test("EU FSF: persons only, aliases, DOB", () => {
    const l = parseEuFsf(EU_XML);
    expect(l.entries).toHaveLength(1);
    expect(l.entries[0]).toMatchObject({ entryId: "EU-13", birthDates: ["1971-05-04"], citizenships: ["RU"], programme: "SYR" });
    expect(l.entries[0]!.names).toContain("Ivan Sidorov");
  });
  test("UN consolidated", () => {
    const l = parseUn(UN_XML);
    expect(l.entries[0]).toMatchObject({ entryId: "UN-QDi.001", names: ["ABDUL RAHMAN", "Abu Rahman"], birthDates: ["1965"] });
  });
  test("OFAC SDN + ALT, individuals only", () => {
    const l = parseOfac(SDN, ALT);
    expect(l.entries).toHaveLength(1);
    expect(l.entries[0]).toMatchObject({ entryId: "OFAC-7157", birthDates: ["1980-03-12"], citizenships: ["Romania"] });
    expect(l.entries[0]!.names).toEqual(["Mihai Andrei POPESCU", "Mihai POPESKU"]);
  });
});

describe("matching", () => {
  test("token order and diacritics do not matter", () => {
    expect(scoreName("Popescu Mihai Andrei", "Mihai Andrei POPESCU")).toBe(1);
    expect(scoreName("Mihai Popescu", "Mihai Andrei POPESCU")).toBeGreaterThan(0.88);
    expect(scoreName("Ioana Ionescu", "Mihai Andrei POPESCU")).toBeLessThan(0.8);
  });
  test("DOB mismatch lowers the score below threshold", () => {
    const { entries } = parseOfac(SDN, ALT);
    expect(searchEntries(entries, { fullName: "Mihai Andrei Popescu", birthDate: "1980-03-12" }, "ofac", 0.88)).toHaveLength(1);
    expect(searchEntries(entries, { fullName: "Mihai Andrei Popescu", birthDate: "1995-01-01" }, "ofac", 0.88)).toHaveLength(0);
  });
});

describe("adapter", () => {
  test("unreachable source reports unavailable (check must block)", async () => {
    const a = new SanctionsListAdapter({ listId: "eu", sourceName: "EU", load: async () => Promise.reject(new Error("HTTP 503")) }, { refreshHours: 24, threshold: 0.88 });
    expect(await a.status()).toMatchObject({ status: "unavailable", reason: "HTTP 503" });
    await expect(a.search({ fullName: "x" })).rejects.toThrow();
  });
  test("caches and serves a loaded list", async () => {
    let loads = 0;
    const a = new SanctionsListAdapter({ listId: "eu", sourceName: "EU", load: async () => (loads++, parseEuFsf(EU_XML)) }, { refreshHours: 24, threshold: 0.88 });
    expect((await a.status()).entries).toBe(1);
    expect(await a.search({ fullName: "Sidorov Ivan" })).toHaveLength(1);
    expect(loads).toBe(1);
  });
});
