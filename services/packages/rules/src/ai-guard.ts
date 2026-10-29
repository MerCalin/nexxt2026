import type { AiSentence, ExternalCheck, Fact, Finding } from "@dc/contracts";
import { canonicalJson } from "./canonical";
import { foldForMatch } from "./text";

/**
 * Deterministic guards applied to every AI-generated sentence (EU AI Act: evidence-grounded output).
 * A sentence is accepted only if:
 *  - it cites ≥ 1 known fact or external check id the audience may see,
 *  - every number in it appears in the cited evidence,
 *  - every proper name in it appears in the cited evidence,
 *  - it contains no speculation (unless the caller explicitly allows hypotheses).
 */

export type Evidence = {
  facts: readonly Fact[];
  checks: readonly ExternalCheck[];
  findings: readonly Finding[];
};

export type GuardOptions = { allowHypothesis?: boolean; customerFacing?: boolean };

// Romanian is inflected (posibil/posibilă/posibile, probabil/probabilă): match stems
const SPECULATION = /\b(PROBABIL\w*|POSIBIL\w*|PARE|PAR|PROBABLY|LIKELY|MIGHT|PERHAPS|MAYBE|SUSPECT\w*|BANUI\w*|PRESUPU\w*|APPEARS|SEEMS|POATE FI|AR PUTEA)\b/;

/** Words that must never reach a customer (Law 129/2019 art. 38 — prohibition of tipping-off). */
const TIPPING_OFF = /\b(SANCTIUN\w*|PEP|EXPUS\w* PUBLIC\w*|CAZIER\w*|PENAL\w*|FRAUD\w*|FALS\w*|CONTRAFACU\w*|SPALAR\w*|TERORIS\w*|ONPCSB|SUSPECT\w*|SUSPICIU\w*|AML|LISTA NEAGRA|INVESTIGA\w*|POLITI\w*|PARCHET\w*|ALTERA\w*|EDITA\w*|PHOTOSHOP|RISC\w*|CONFORMITATE|COMPLIANCE|OFAC|EMBARGO)\b/;

/** Capitalised words that are not personal/company names and need no evidence. */
const NAME_ALLOWLIST = new Set(
  (
    "CNP CUI CIF IBAN RON EUR LEI BNR ANAF CRC ANCPI ANEVAR MRZ KYC DTI LTV CF CI UE EU ONU OFAC ROU SRL SA " +
    "ROMANIA BUCURESTI LEGEA LEGII REGULAMENTUL BIROUL CREDIT CENTRALA RISCULUI CONFORMITATE CARTEA CARTE IDENTITATE " +
    "PASAPORT PASAPORTUL EXTRASUL EXTRAS CONTRACTUL CONTRACT FLUTURASUL FACTURA CERTIFICATUL RAPORTUL DECLARATIA " +
    "VA VĂ DUMNEAVOASTRA BUNA ZIUA STIMATE STIMATA MULTUMIM ECHIPA BANCA BANCII IN ÎN PENTRU DIN LA SI ȘI DE CU " +
    "THE AND OF FOR NOT NAME ADDRESS INCOME EMPLOYER STATEMENT CARD ID OFFICER CUSTOMER"
  ).split(" "),
);

export type GuardResult = { accepted: AiSentence[]; rejected: { text: string; reason: string }[] };

function evidenceText(id: string, ev: Evidence): string | undefined {
  const fact = ev.facts.find((f) => f.id === id);
  const check = ev.checks.find((c) => c.id === id);
  if (!fact && !check) return undefined;
  const parts = [fact ? `${fact.value} ${fact.normalized}` : "", check ? `${check.source} ${check.status} ${check.reason ?? ""} ${canonicalJson(check.payload)}` : ""];
  // deterministic finding text that cites this evidence may be paraphrased (e.g. computed DTI, limits)
  for (const f of ev.findings) if (f.citations.includes(id)) parts.push(f.message, ...f.values);
  return parts.join(" ");
}

const numbersIn = (s: string) =>
  [...s.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]).filter((n) => n.replace(/\D/g, "").length >= 2);

const digitsOnly = (s: string) => s.replace(/[^\d]/g, "");

function numberSupported(n: string, evidence: string): boolean {
  const ev = evidence.replace(/\s/g, "");
  if (ev.includes(n.replace(/\s/g, ""))) return true;
  // 4.700,00 vs 4700 vs 4700.00
  const core = digitsOnly(n).replace(/0+$/, "");
  return core.length >= 2 && digitsOnly(ev).includes(core);
}

export function guardSentences(sentences: AiSentence[], ev: Evidence, opts: GuardOptions = {}): GuardResult {
  const accepted: AiSentence[] = [];
  const rejected: GuardResult["rejected"] = [];
  for (const s of sentences) {
    const reason = check(s, ev, opts);
    if (reason) rejected.push({ text: s.text, reason });
    else accepted.push(s);
  }
  return { accepted, rejected };
}

function check(s: AiSentence, ev: Evidence, opts: GuardOptions): string | undefined {
  if (!s.text?.trim()) return "empty";
  if (!s.citations?.length) return "no citations";
  const texts = s.citations.map((c) => evidenceText(c, ev));
  const unknown = s.citations.filter((_, i) => texts[i] === undefined);
  if (unknown.length) return `unknown citation(s): ${unknown.join(", ")}`;
  const evidence = texts.join(" ");
  const folded = foldForMatch(s.text);

  if (!opts.allowHypothesis && SPECULATION.test(folded)) return "speculative wording";
  if (opts.customerFacing && TIPPING_OFF.test(folded)) return "tipping-off lexicon";

  for (const n of numbersIn(s.text)) if (!numberSupported(n, evidence)) return `number not in cited evidence: ${n}`;

  const foldedEvidence = ` ${foldForMatch(evidence)} `;
  const words = s.text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const raw = words[i]!.replace(/^[„"“(«]+|[”"),.;:!?»]+$/g, "");
    if (raw.length < 3 || !/^\p{Lu}/u.test(raw)) continue;
    const isSentenceStart = i === 0 || /[.!?:]$/.test(words[i - 1] ?? "");
    const isAllCaps = raw === raw.toUpperCase() && /\p{L}{3,}/u.test(raw);
    if (isSentenceStart && !isAllCaps) continue;
    const token = foldForMatch(raw);
    if (!token || NAME_ALLOWLIST.has(token) || /^\d/.test(token)) continue;
    if (!foldedEvidence.includes(` ${token} `) && !foldedEvidence.includes(token)) return `name not in cited evidence: ${raw}`;
  }
  return undefined;
}

/** Facts/checks/findings a given audience may see. Compliance sees everything. */
export function evidenceForAudience(ev: Evidence, audience: "officer" | "compliance" | "customer"): Evidence {
  const ok = (v: string) => (audience === "compliance" ? true : audience === "officer" ? v !== "compliance" : v === "all");
  const findings = ev.findings.filter((f) => ok(f.visibility) && (audience !== "customer" || !CUSTOMER_EXCLUDED_AGENTS.has(f.agent)));
  const checks = ev.checks.filter((c) => ok(c.visibility) && (audience !== "customer" || !c.kind.startsWith("sanctions") && c.kind !== "cazier"));
  const hiddenIds = new Set(ev.findings.filter((f) => !findings.includes(f)).flatMap((f) => f.citations));
  // a fact cited only by hidden findings is withheld from the customer channel
  const facts = audience === "customer" ? ev.facts.filter((f) => !hiddenIds.has(f.id) || findings.some((x) => x.citations.includes(f.id))) : ev.facts;
  return { facts, checks, findings };
}

const CUSTOMER_EXCLUDED_AGENTS = new Set(["risk-fraud", "sanctions-pep", "aml-risk", "bank-verification", "credit-history", "investigation"]);
