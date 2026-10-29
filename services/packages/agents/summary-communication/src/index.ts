import { asSentences, renderEvidence, runToolLoop, SENTENCES_SCHEMA } from "@dc/ai-kit";
import type { AiSentence, AiText, Finding, Lane, Recommendation } from "@dc/contracts";
import type { Agent, AgentContext, AiPort } from "@dc/ports";
import { type Evidence, evidenceForAudience, guardSentences, severityRank } from "@dc/rules";

export const SUMMARY_PROMPT_VERSION = "summary/2026-10-28.1";

const LANE_RO: Record<Lane, string> = {
  ready_for_officer: "pregătit pentru decizia ofițerului",
  needs_info: "necesită informații suplimentare de la client",
  human_review: "necesită analiză umană",
};

const OFFICER_SYSTEM = `Scrii rezumatul pentru ofițerul bancar care va lua decizia asupra dosarului (România).
Reguli obligatorii:
- Nu recomanzi aprobarea sau respingerea; descrii doar constatările. Decizia aparține ofițerului.
- Fiecare propoziție citează cel puțin un id din facts[] sau externalChecks[] (nu id-uri de constatări).
- Folosește numai nume, sume și date care apar în dovezile citate; fără speculații ("probabil", "pare").
- Marchează explicit sursele SIMULAT (simulated=true).
- Maximum 8 propoziții, în limba română, ordonate după severitate. Apelează submit_summary.`;

const CUSTOMER_SYSTEM = `Scrii mesajul către client prin care banca solicită documente sau clarificări (în limba română, politicos, neutru).
Reguli obligatorii:
- Ceri doar documentele/clarificările enumerate. Nu explici motive interne, nu menționezi verificări, riscuri, liste, autorități sau suspiciuni.
- Fiecare propoziție citează cel puțin un id din facts[] care o susține.
- Fără nume de persoane în afara clientului; fără speculații. Maximum 6 propoziții. Apelează submit_message.`;

/** Neutral, deterministic customer requests per finding code (used to brief the model and as fallback). */
const CUSTOMER_REQUEST: Record<string, string> = {
  CLASS_MISSING_REQUIRED: "vă rugăm să transmiteți documentul lipsă",
  CLASS_REJECTED_POA: "vă rugăm să transmiteți o dovadă a adresei acceptată: certificat de domiciliu, factură de apă sau energie electrică, contract notarial sau extras de cont cu adresa",
  CLASS_UNKNOWN: "vă rugăm să retransmiteți documentul într-o calitate mai bună",
  CLASS_STATEMENT_NO_ADDRESS: "vă rugăm să transmiteți o dovadă a adresei de domiciliu",
  DOCVER_EXPIRED: "vă rugăm să transmiteți un act de identitate în termen de valabilitate",
  DOCVER_EXPIRING_SOON: "vă rugăm să transmiteți actul de identitate reînnoit, dacă este disponibil",
  DOCVER_STALE: "vă rugăm să transmiteți o versiune recentă a documentului",
  DOCVER_DATE_UNREADABLE: "vă rugăm să retransmiteți documentul, astfel încât data să fie lizibilă",
  DOCVER_EXPIRY_UNREADABLE: "vă rugăm să retransmiteți actul de identitate, astfel încât data expirării să fie lizibilă",
  DOCVER_CNP_MISSING: "vă rugăm să retransmiteți actul de identitate, astfel încât CNP-ul să fie lizibil",
  DOCVER_CONTRACT_ENDED: "vă rugăm să transmiteți contractul de muncă în vigoare sau actul adițional de prelungire",
  DOCVER_NO_ANEVAR: "vă rugăm să transmiteți raportul de evaluare semnat de un evaluator autorizat ANEVAR",
  XREF_ADDRESS_MISMATCH: "vă rugăm să ne confirmați adresa actuală de domiciliu și să transmiteți un document care o atestă",
  XREF_NO_SALARY_CREDITS: "vă rugăm să transmiteți extrasul de cont în care este încasat salariul",
  KYC_REFRESH_REQUIRED: "vă rugăm să actualizați datele de identificare la bancă",
};

function officerFallback(findings: Finding[], rec: Recommendation | undefined, ev: Evidence): AiSentence[] {
  const out: AiSentence[] = [];
  const firstCite = ev.facts[0]?.id ?? ev.checks[0]?.id;
  if (rec && firstCite) out.push({ text: `Dosar ${LANE_RO[rec.lane]} (reguli: ${rec.rules.join(", ")}).`, citations: [findings[0]?.citations[0] ?? firstCite] });
  for (const f of [...findings].sort((a, b) => severityRank[b.severity] - severityRank[a.severity]).slice(0, 12))
    out.push({ text: `${f.simulated ? "[SIMULAT] " : ""}${f.message}`, citations: f.citations });
  return out;
}

/** Missing-document requests name the document (finding.values[0] is the requirement id). */
const MISSING_DOC_REQUEST: Record<string, string> = {
  identity: "vă rugăm să transmiteți actul de identitate (carte de identitate sau pașaport)",
  residence: "vă rugăm să transmiteți o dovadă a adresei: certificat de domiciliu, factură de apă sau energie electrică, contract notarial sau extras de cont cu adresa",
  employment: "vă rugăm să transmiteți contractul individual de muncă",
  statement: "vă rugăm să transmiteți extrasul de cont în care este încasat salariul",
  land_register: "vă rugăm să transmiteți extrasul de carte funciară pentru informare",
  valuation: "vă rugăm să transmiteți raportul de evaluare a imobilului",
};

const requestText = (f: Finding) => (f.code === "CLASS_MISSING_REQUIRED" && MISSING_DOC_REQUEST[f.values[0] ?? ""]) || CUSTOMER_REQUEST[f.code];

function customerFallback(findings: Finding[]): AiSentence[] {
  const reqs = findings.filter((f) => CUSTOMER_REQUEST[f.code]);
  if (!reqs.length) return [];
  const seen = new Set<string>();
  const lines: AiSentence[] = [{ text: "Bună ziua, pentru a continua analiza cererii dumneavoastră avem nevoie de următoarele:", citations: [reqs[0]!.citations[0]!] }];
  for (const f of reqs) {
    const t = requestText(f)!;
    if (seen.has(t)) continue;
    seen.add(t);
    lines.push({ text: `– ${t}.`, citations: f.citations });
  }
  lines.push({ text: "Vă mulțumim.", citations: [reqs[0]!.citations[0]!] });
  return lines;
}

/**
 * Summary & Communication agent. Writes the officer summary (and a separate compliance summary)
 * plus the customer request-for-information in Romanian. Every sentence must cite evidence and
 * pass the guard; the customer message also passes the tipping-off guard. Otherwise deterministic
 * templates are used.
 */
export function createSummaryCommunicationAgent(deps: { ai: AiPort }): Agent {
  async function write(ctx: AgentContext, ev: Evidence, system: string, submit: string, brief: string, customerFacing: boolean, fb: AiSentence[]): Promise<AiText> {
    let raw: AiSentence[] = [];
    let error: string | undefined;
    let callFailed = false;
    try {
      const loop = await runToolLoop({
        ai: deps.ai,
        system,
        user: `${brief}\n\nDovezi:\n${renderEvidence(ev)}`,
        tools: [],
        submitTool: { name: submit, description: "Trimite textul final ca propoziții cu citări.", inputSchema: SENTENCES_SCHEMA as unknown as Record<string, unknown> },
        maxTurns: 2,
        // many findings with citations in Romanian need room; a truncated reply has no usable tool call
        maxTokens: 6000,
        signal: ctx.signal,
      });
      raw = asSentences(loop.output);
      error = loop.error;
    } catch (e) {
      callFailed = true;
      error = `AI call failed: ${e instanceof Error ? e.message : e}`;
    }
    const { accepted, rejected } = guardSentences(raw, ev, { customerFacing });
    const allRejected = [...rejected, ...(error ? [{ text: "(call)", reason: error }] : [])];
    // all-or-nothing: a partially rejected text could omit material facts, so use the template instead
    if (!raw.length || rejected.length || accepted.length === 0) {
      const fallbackReason = callFailed ? "ai_call_failed" : rejected.length ? "validation_failed" : "no_output";
      return { sentences: fb, modelId: deps.ai.modelId, promptVersion: SUMMARY_PROMPT_VERSION, fallback: true, fallbackReason, rejected: allRejected };
    }
    return { sentences: accepted, modelId: deps.ai.modelId, promptVersion: SUMMARY_PROMPT_VERSION, fallback: false, rejected: allRejected };
  }

  return {
    name: "summary-communication",
    async run(ctx: AgentContext) {
      const all = { facts: ctx.facts, checks: ctx.checks, findings: ctx.findings };
      const rec = ctx.results.triage?.data as Recommendation | undefined;
      const officerEv = evidenceForAudience(all, "officer");
      const complianceOnly = ctx.findings.filter((f) => f.visibility === "compliance");

      const officerBrief = `Stare dosar (reguli fixe de triere): ${rec ? LANE_RO[rec.lane] : "necunoscută"}. Constatări: ${officerEv.findings.length}.`;
      const officerSummary = await write(ctx, officerEv, OFFICER_SYSTEM, "submit_summary", officerBrief, false, officerFallback(officerEv.findings as Finding[], rec, officerEv));

      const complianceSummary = complianceOnly.length
        ? await write(ctx, all, OFFICER_SYSTEM, "submit_summary", `Rezumat pentru departamentul Conformitate. Constatări confidențiale: ${complianceOnly.length}.`, false, officerFallback(complianceOnly, rec, all))
        : undefined;

      const customerEv = evidenceForAudience(all, "customer");
      const requests = customerEv.findings.filter((f) => CUSTOMER_REQUEST[f.code] && f.severity !== "info");
      const customerMessage =
        rec?.lane === "needs_info" || requests.length
          ? await write(
              ctx,
              customerEv,
              CUSTOMER_SYSTEM,
              "submit_message",
              `Solicitări de transmis clientului (neutru):\n${requests.map((f) => `- ${requestText(f as Finding)} (citări: ${f.citations.join(", ")})`).join("\n")}`,
              true,
              customerFallback(requests as Finding[]),
            )
          : undefined;

      return { status: "ok", data: { officerSummary, complianceSummary, customerMessage } };
    },
  };
}
