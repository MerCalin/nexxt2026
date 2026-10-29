/**
 * Shape of the requests sent to AWS. Both bugs here were found on the first real run:
 * Textract answered "Request has invalid parameters" and Bedrock "`temperature` is deprecated".
 * The SDK clients are replaced by recorders; nothing is sent.
 */
import { describe, expect, test } from "bun:test";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { TextractClient } from "@aws-sdk/client-textract";
import { BedrockAiAdapter } from "../src/bedrock";
import { asciiQuery, TextractOcrAdapter } from "../src/textract";

const recorder = <T>(reply: unknown) => {
  const sent: { input: Record<string, any> }[] = [];
  return { sent, client: { send: async (cmd: { input: Record<string, any> }) => (sent.push(cmd), reply) } as unknown as T };
};

describe("Textract request", () => {
  test("query text is plain ASCII", () => {
    expect(asciiQuery("What is the gross monthly base salary (salariul de bază brut)?")).toBe("What is the gross monthly base salary (salariul de baza brut)?");
    expect(asciiQuery("Data începerii activității, valoarea de piață, ȘȚ")).toBe("Data inceperii activitatii, valoarea de piata, ST");
  });

  test("image request: ASCII queries, no Pages parameter", async () => {
    const r = recorder<TextractClient>({ Blocks: [] });
    const ocr = new TextractOcrAdapter({ region: "us-west-2", bucket: "b" }, r.client);
    await ocr.analyze({ docId: "d", storageKey: "k", contentType: "image/png", queries: [{ alias: "x", text: "Care este data emiterii (data eliberării)?" }] });
    const q = r.sent[0]!.input.QueriesConfig.Queries[0];
    expect(q).toEqual({ Text: "Care este data emiterii (data eliberarii)?", Alias: "x" });
  });
});

describe("Bedrock request", () => {
  test("temperature is not sent unless enabled", async () => {
    const reply = { output: { message: { content: [{ text: "ok" }] } }, stopReason: "end_turn", usage: {} };
    const r = recorder<BedrockRuntimeClient>(reply);
    const ai = new BedrockAiAdapter({ region: "us-west-2", modelId: "m", allowNonEu: true }, r.client);
    await ai.converse({ system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxTokens: 10, temperature: 0 });
    expect(r.sent[0]!.input.inferenceConfig).toEqual({ maxTokens: 10 });

    const r2 = recorder<BedrockRuntimeClient>(reply);
    await new BedrockAiAdapter({ region: "us-west-2", modelId: "m", allowNonEu: true, sendTemperature: true }, r2.client).converse({ system: "s", messages: [], maxTokens: 10, temperature: 0 });
    expect(r2.sent[0]!.input.inferenceConfig).toEqual({ maxTokens: 10, temperature: 0 });
  });
});
