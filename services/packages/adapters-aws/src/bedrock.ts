import {
  BedrockRuntimeClient,
  type ContentBlock,
  ConverseCommand,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { AiContent, AiPort, AiRequest, AiResponse } from "@dc/ports";

export type BedrockConfig = {
  region: string; // eu-central-1
  /** EU cross-region inference profile id, e.g. "eu.anthropic.claude-sonnet-4-5-20250929-v1:0". */
  modelId: string;
  /** Set only by the service's explicit non-EU demo override (see apps/document-check/src/config.ts). */
  allowNonEu?: boolean;
  /** Send the request's temperature. Only for older models: Claude 5.x models reject it. Default false. */
  sendTemperature?: boolean;
};

const toBlock = (c: AiContent): ContentBlock => {
  switch (c.type) {
    case "text":
      return { text: c.text };
    case "tool_use":
      return { toolUse: { toolUseId: c.id, name: c.name, input: c.input as never } };
    case "tool_result":
      return {
        toolResult: { toolUseId: c.toolUseId, content: [{ text: c.content }], status: c.isError ? "error" : "success" },
      };
  }
};

const fromBlock = (b: ContentBlock): AiContent | undefined => {
  if (b.text !== undefined) return { type: "text", text: b.text };
  if (b.toolUse) {
    return {
      type: "tool_use",
      id: b.toolUse.toolUseId ?? "",
      name: b.toolUse.name ?? "",
      input: (b.toolUse.input ?? {}) as Record<string, unknown>,
    };
  }
  return undefined;
};

/** AiPort implemented on the Bedrock Converse API. The model never sees raw documents — only cited facts. */
export class BedrockAiAdapter implements AiPort {
  readonly modelId: string;
  private client: BedrockRuntimeClient;
  private sendTemperature: boolean;

  constructor(cfg: BedrockConfig, client?: BedrockRuntimeClient) {
    if (!cfg.region.startsWith("eu-") && !cfg.allowNonEu) throw new Error(`Bedrock region must be in the EU (got ${cfg.region})`);
    this.modelId = cfg.modelId;
    this.sendTemperature = cfg.sendTemperature ?? false;
    this.client = client ?? new BedrockRuntimeClient({ region: cfg.region });
  }

  async converse(req: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
    const messages: Message[] = req.messages.map((m) => ({ role: m.role, content: m.content.map(toBlock) }));
    const tools: Tool[] | undefined = req.tools?.map((t) => ({
      toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema as never } },
    }));
    const out = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: req.system }],
        messages,
        // newer Claude models reject `temperature` ("deprecated for this model"); send it only when configured
        inferenceConfig: { maxTokens: req.maxTokens, ...(this.sendTemperature && req.temperature !== undefined ? { temperature: req.temperature } : {}) },
        ...(tools?.length ? { toolConfig: { tools } } : {}),
      }),
      { abortSignal: signal },
    );
    const content = (out.output?.message?.content ?? []).map(fromBlock).filter((c): c is AiContent => !!c);
    const stop = out.stopReason;
    return {
      content,
      stopReason: stop === "end_turn" || stop === "tool_use" || stop === "max_tokens" ? stop : "other",
      usage: { inputTokens: out.usage?.inputTokens ?? 0, outputTokens: out.usage?.outputTokens ?? 0 },
    };
  }
}
