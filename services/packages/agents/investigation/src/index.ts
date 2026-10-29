import { asSentences, renderEvidence, runToolLoop, SENTENCES_SCHEMA } from "@dc/ai-kit";
import type { AiSentence, AiText } from "@dc/contracts";
import type { Agent, AgentContext, AiPort } from "@dc/ports";
import { evidenceForAudience, guardSentences } from "@dc/rules";

export const INVESTIGATION_PROMPT_VERSION = "investigation/2026-10-28.1";
export const MAX_MODEL_TURNS = 6;

/** Findings worth explaining: mismatches between documents or against the KYC file. */
const INVESTIGABLE = /^(XREF_|KYC_NAME_CHANGED|KYC_REFRESH_REQUIRED|DOCVER_MRZ_VISUAL_MISMATCH|COLL_OWNER_MISMATCH|CREDIT_UNDECLARED_DEBT)/;

const SYSTEM = `Ești agentul de investigație al unui serviciu bancar de verificare a documentelor (România).
Sarcina ta: pentru fiecare neconcordanță primită, propune explicații POSIBILE și verificabile (de ex. nume de dinainte de căsătorie, adresă veche, angajator redenumit, eroare OCR de diacritice).
Reguli obligatorii:
- Nu iei decizii și nu recomanzi aprobarea sau respingerea. Un ofițer uman decide.
- Fiecare propoziție citează cel puțin un id de fapt (facts[].id) sau verificare externă (externalChecks[].id) care o susține.
- Folosește doar nume, cifre și date care apar exact în dovezile citate. Nu inventa nimic.
- Dacă dovezile nu susțin nicio explicație, spune că explicația nu poate fi stabilită din documente, citând faptele comparate.
- Ai doar instrumente de citire. Maximum ${MAX_MODEL_TURNS} pași.
- Scrie în limba română, concis. Încheie apelând submit_hypotheses.`;

/**
 * Investigation agent — the only agent with AI tool use. Read-only tools, step cap of 6 model turns.
 * Output: hypotheses labelled "Posibilă explicație", each validated against the cited evidence.
 */
export function createInvestigationAgent(deps: { ai: AiPort }): Agent {
  return {
    name: "investigation",
    async run(ctx: AgentContext) {
      const ev = evidenceForAudience({ facts: ctx.facts, checks: ctx.checks, findings: ctx.findings }, "officer");
      const targets = ev.findings.filter((f) => INVESTIGABLE.test(f.code) && f.severity !== "info");
      if (!targets.length) return { status: "skipped", data: { reason: "no mismatches to investigate" } };

      const tools = [
        {
          name: "get_fact",
          description: "Returnează un fapt extras (valoare, document, pagină, încredere OCR) după id.",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          handler: (i: Record<string, unknown>) => JSON.stringify(ev.facts.find((f) => f.id === i.id) ?? { error: "not found" }),
        },
        {
          name: "get_document_text",
          description: "Returnează textul OCR al unei pagini dintr-un document (docId, page).",
          inputSchema: { type: "object", properties: { docId: { type: "string" }, page: { type: "number" } }, required: ["docId"] },
          handler: (i: Record<string, unknown>) => {
            const ocr = ctx.ocr[String(i.docId)];
            const page = ocr?.pages.find((p) => p.page === Number(i.page ?? 1));
            return page ? page.lines.map((l) => l.text).join("\n").slice(0, 6000) : "not found";
          },
        },
        {
          name: "list_findings",
          description: "Listează toate constatările deterministe (cod, mesaj, citări).",
          inputSchema: { type: "object", properties: {} },
          handler: () => JSON.stringify(ev.findings.map((f) => ({ id: f.id, code: f.code, message: f.message, citations: f.citations }))),
        },
        {
          name: "get_prior_kyc_record",
          description: "Returnează dosarul KYC existent al clientului, dacă există.",
          inputSchema: { type: "object", properties: {} },
          handler: () => {
            const c = ev.checks.find((x) => x.kind === "kyc-store");
            return c ? JSON.stringify({ checkId: c.id, simulated: c.simulated, record: c.payload }) : "no KYC record consulted";
          },
        },
        {
          name: "get_external_check",
          description: "Returnează rezultatul unei verificări externe după id.",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          handler: (i: Record<string, unknown>) => JSON.stringify(ev.checks.find((c) => c.id === i.id) ?? { error: "not found" }),
        },
      ];

      const user = `Neconcordanțe de explicat:\n${JSON.stringify(targets.map((t) => ({ id: t.id, code: t.code, message: t.message, citations: t.citations })), null, 1)}\n\nDovezi disponibile:\n${renderEvidence(ev)}`;
      let loop: Awaited<ReturnType<typeof runToolLoop<unknown>>>;
      try {
        loop = await runToolLoop({
          ai: deps.ai,
          system: SYSTEM,
          user,
          tools,
          submitTool: { name: "submit_hypotheses", description: "Trimite explicațiile posibile, fiecare cu citări.", inputSchema: SENTENCES_SCHEMA as unknown as Record<string, unknown> },
          maxTurns: MAX_MODEL_TURNS,
          maxTokens: 4000,
          signal: ctx.signal,
        });
      } catch (e) {
        const reason = `AI call failed: ${e instanceof Error ? e.message : e}`;
        return { status: "error", error: reason, data: fallback(deps.ai.modelId, [{ text: "(call)", reason }]) };
      }

      const raw = asSentences(loop.output);
      const { accepted, rejected } = guardSentences(raw, ev, { allowHypothesis: true });
      const labelled: AiSentence[] = accepted.map((s) => ({ ...s, text: s.text.startsWith("Posibilă explicație") ? s.text : `Posibilă explicație: ${s.text}` }));
      const text: AiText = {
        sentences: labelled,
        modelId: deps.ai.modelId,
        promptVersion: INVESTIGATION_PROMPT_VERSION,
        fallback: labelled.length === 0,
        ...(labelled.length === 0 ? { fallbackReason: rejected.length ? ("validation_failed" as const) : ("no_output" as const) } : {}),
        rejected: [...rejected, ...(loop.error ? [{ text: "(loop)", reason: loop.error }] : [])],
      };
      return { status: "ok", data: { ...text, turns: loop.turns, toolCalls: loop.toolCalls } };
    },
  };
}

const fallback = (modelId: string, rejected: AiText["rejected"]): AiText => ({ sentences: [], modelId, promptVersion: INVESTIGATION_PROMPT_VERSION, fallback: true, fallbackReason: "ai_call_failed", rejected });
