import { expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { extractFileMetadata } from "../src/file-metadata";

test("reads producer and dates from a PDF whose Info dictionary is in a compressed object stream", async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.setProducer("Adobe Photoshop 25.0 (Windows)");
  doc.setCreationDate(new Date("2026-10-01T10:00:00Z"));
  doc.setModificationDate(new Date("2026-10-20T10:00:00Z"));
  const bytes = await doc.save({ useObjectStreams: true });
  expect(new TextDecoder("latin1").decode(bytes)).not.toContain("Photoshop"); // only visible after inflating
  expect(extractFileMetadata(bytes, "application/pdf")).toMatchObject({
    producer: "Adobe Photoshop 25.0 (Windows)",
    creationDate: "2026-10-01T10:00:00.000Z",
    modDate: "2026-10-20T10:00:00.000Z",
  });
});
