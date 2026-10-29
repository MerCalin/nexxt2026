import type { AiSentence } from "@dc/contracts";
import type { AiMessage, AiPort, AiTool } from "@dc/ports";

export type ToolHandler = (input: Record<string, unknown>) => string | Promise<string>;

export type ToolLoopResult<T> = { output?: T; turns: number; toolCalls: { name: string; input: unknown }[]; error?: string };

/**
 * Bounded tool-use loop over the AiPort. Only read-only tools are registered by callers.
 * The loop ends when the model calls the `submitTool` (its input is the result) or when
 * `maxTurns` model calls have been made.
 */
export async function runToolLoop<T>(opts: {
  ai: AiPort;
  system: string;
  user: string;
  tools: (AiTool & { handler: ToolHandler })[];
  submitTool: AiTool;
  maxTurns: number;
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<ToolLoopResult<T>> {
  const messages: AiMessage[] = [{ role: "user", content: [{ type: "text", text: opts.user }] }];
  const toolCalls: ToolLoopResult<T>["toolCalls"] = [];
  const handlers = new Map(opts.tools.map((t) => [t.name, t.handler]));
  const tools: AiTool[] = [...opts.tools.map(({ handler: _h, ...t }) => t), opts.submitTool];

  let lastStop: string | undefined;
  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    const res = await opts.ai.converse({ system: opts.system, messages, tools, maxTokens: opts.maxTokens ?? 2000, temperature: 0 }, opts.signal);
    lastStop = res.stopReason;
    messages.push({ role: "assistant", content: res.content });
    if (res.stopReason === "max_tokens") {
      // a truncated answer cannot contain a complete tool call; asking again would truncate the same way
      return { turns: turn, toolCalls, error: `model output truncated at ${opts.maxTokens ?? 2000} tokens (max_tokens)` };
    }
    const uses = res.content.filter((c) => c.type === "tool_use");
    const submit = uses.find((u) => u.name === opts.submitTool.name);
    if (submit) return { output: submit.input as T, turns: turn, toolCalls };
    if (!uses.length) {
      // tolerate a JSON answer in plain text
      const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      if (json)
        try {
          return { output: JSON.parse(json) as T, turns: turn, toolCalls };
        } catch {}
      messages.push({ role: "user", content: [{ type: "text", text: `Apelează instrumentul ${opts.submitTool.name} cu rezultatul final.` }] });
      continue;
    }
    const results = await Promise.all(
      uses.map(async (u) => {
        toolCalls.push({ name: u.name, input: u.input });
        const h = handlers.get(u.name);
        try {
          const content = h ? await h(u.input) : `Unknown tool ${u.name}`;
          return { type: "tool_result" as const, toolUseId: u.id, content, isError: !h };
        } catch (e) {
          return { type: "tool_result" as const, toolUseId: u.id, content: String(e), isError: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }
  return { turns: opts.maxTurns, toolCalls, error: `step cap of ${opts.maxTurns} model turns reached without ${opts.submitTool.name} (last stop reason: ${lastStop})` };
}

export const SENTENCES_SCHEMA = {
  type: "object",
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          citations: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["text", "citations"],
      },
    },
  },
  required: ["sentences"],
} as const;

export function asSentences(x: unknown): AiSentence[] {
  const arr = (x as { sentences?: unknown })?.sentences;
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((s): s is { text: string; citations: unknown[] } => typeof s?.text === "string" && Array.isArray(s?.citations))
    .map((s) => ({ text: s.text.trim(), citations: s.citations.map(String) }));
}

/** Compact evidence rendering for prompts: ids + values only, no document images. */
export function renderEvidence(ev: {
  facts: readonly { id: string; docType: string; field: string; value: string }[];
  checks: readonly { id: string; kind: string; source: string; status: string; reason?: string; simulated: boolean }[];
  findings: readonly { id: string; code: string; severity: string; message: string; citations: string[]; simulated?: boolean }[];
}) {
  return JSON.stringify(
    {
      facts: ev.facts.map((f) => ({ id: f.id, doc: f.docType, field: f.field, value: f.value })),
      externalChecks: ev.checks.map((c) => ({ id: c.id, kind: c.kind, source: c.source, status: c.status, reason: c.reason, simulated: c.simulated })),
      findings: ev.findings.map((f) => ({ id: f.id, code: f.code, severity: f.severity, message: f.message, citations: f.citations, simulated: f.simulated })),
    },
    null,
    1,
  );
}
