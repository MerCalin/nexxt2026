import { expect, test } from "bun:test";
import type { Block } from "@aws-sdk/client-textract";
import { blocksToPages } from "../src/textract";

const geo = { Geometry: { BoundingBox: { Left: 0.1, Top: 0.2, Width: 0.3, Height: 0.05 } } };

test("blocksToPages maps lines, key-values, queries and tables", () => {
  const blocks: Block[] = [
    { Id: "l1", BlockType: "LINE", Text: "CARTE DE IDENTITATE", Confidence: 99, Page: 1, ...geo },
    { Id: "w1", BlockType: "WORD", Text: "Nume/Nom", Page: 1 },
    { Id: "w2", BlockType: "WORD", Text: "POPESCU", Page: 1 },
    { Id: "k1", BlockType: "KEY_VALUE_SET", EntityTypes: ["KEY"], Confidence: 95, Page: 1, Relationships: [{ Type: "CHILD", Ids: ["w1"] }, { Type: "VALUE", Ids: ["v1"] }], ...geo },
    { Id: "v1", BlockType: "KEY_VALUE_SET", EntityTypes: ["VALUE"], Confidence: 90, Page: 1, Relationships: [{ Type: "CHILD", Ids: ["w2"] }], ...geo },
    { Id: "q1", BlockType: "QUERY", Page: 2, Query: { Text: "What is the CNP?", Alias: "cnp" }, Relationships: [{ Type: "ANSWER", Ids: ["a1"] }] },
    { Id: "a1", BlockType: "QUERY_RESULT", Text: "1850315400123", Confidence: 88, Page: 2, ...geo },
    { Id: "t1", BlockType: "TABLE", Page: 2, Relationships: [{ Type: "CHILD", Ids: ["c1", "c2"] }] },
    { Id: "c1", BlockType: "CELL", RowIndex: 1, ColumnIndex: 1, Page: 2, Relationships: [{ Type: "CHILD", Ids: ["w3"] }] },
    { Id: "c2", BlockType: "CELL", RowIndex: 1, ColumnIndex: 2, Page: 2, Relationships: [{ Type: "CHILD", Ids: ["w4"] }] },
    { Id: "w3", BlockType: "WORD", Text: "SALARIU", Page: 2 },
    { Id: "w4", BlockType: "WORD", Text: "5.200,00", Page: 2 },
  ];
  const pages = blocksToPages(blocks);
  expect(pages.map((p) => p.page)).toEqual([1, 2]);
  expect(pages[0]!.lines[0]!.text).toBe("CARTE DE IDENTITATE");
  expect(pages[0]!.keyValues[0]).toMatchObject({ key: "Nume/Nom", value: "POPESCU", confidence: 90 });
  expect(pages[1]!.queries[0]).toMatchObject({ alias: "cnp", answer: "1850315400123" });
  expect(pages[1]!.tables[0]).toEqual([["SALARIU", "5.200,00"]]);
});
