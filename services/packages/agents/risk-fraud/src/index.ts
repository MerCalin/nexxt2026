import type { Fact, Finding } from "@dc/contracts";
import type { Agent, AgentContext, CaseStorePort } from "@dc/ports";
import { docTypeFact, factsOf, IDENTITY_DOCS, makeFact, makeFinding, parseDate } from "@dc/rules";

/** True when the other case's latest run read the same identity-document CNP as this case. */
async function sameCustomer(cases: CaseStorePort, caseId: string, cnp: string | undefined): Promise<boolean> {
  if (!cnp) return false;
  const other = await cases.getCase(caseId);
  const runId = other?.runs.at(-1);
  const run = runId ? await cases.getRun(runId) : undefined;
  const otherCnp = run?.results.flatMap((r) => r.facts).find((f) => f.field === "cnp" && IDENTITY_DOCS.includes(f.docType))?.normalized;
  return otherCnp === cnp;
}

/** Image/PDF editors that should never appear in the producer chain of an issued document. */
const EDITORS = /(photoshop|gimp|canva|illustrator|affinity|pixelmator|paint\.net|ilovepdf|smallpdf|sejda|pdfescape|pdf-xchange editor|foxit phantom|nitro pro|pdffiller|dochub)/i;
/** Office suites: normal for contracts, suspicious for bank- or state-generated documents. */
const OFFICE = /(microsoft.*word|libreoffice|openoffice|pages|google docs)/i;
const SYSTEM_GENERATED = new Set(["bank_statement", "id_card", "passport", "land_register_extract", "domicile_certificate"]);

/** Risk & Fraud agent: document-level fraud signals, deterministic. */
export function createRiskFraudAgent(deps: { cases: CaseStorePort }): Agent {
  return {
    name: "risk-fraud",
    async run(ctx: AgentContext) {
      const findings: Finding[] = [];
      const facts: Fact[] = [];
      const add = (f: Omit<Parameters<typeof makeFinding>[0], "agent">) => findings.push(makeFinding({ agent: "risk-fraud", ...f }));
      const ownCnp = factsOf(ctx.facts, "cnp", IDENTITY_DOCS)[0]?.normalized;

      for (const doc of ctx.case.documents) {
        const typeFact = docTypeFact(ctx.facts, doc.id);
        if (!typeFact) continue;
        const m = doc.metadata ?? {};
        const meta = (field: string, value: string | undefined) => {
          if (!value) return undefined;
          const f = makeFact({ docId: doc.id, docType: typeFact.docType, field, value, normalized: value, page: 1, ocrConfidence: 100, extractor: "file-metadata" });
          facts.push(f);
          return f;
        };
        const producer = meta("fileProducer", [m.producer, m.creator, m.software].filter(Boolean).join(" / ") || undefined);

        if (producer && EDITORS.test(producer.value))
          add({ code: "FRAUD_EDITOR_SOFTWARE", severity: "high", message: `„${doc.fileName}” a fost procesat cu un program de editare (${producer.value}).`, citations: [producer.id], values: [producer.value] });
        else if (producer && SYSTEM_GENERATED.has(typeFact.docType) && OFFICE.test(producer.value))
          add({ code: "FRAUD_OFFICE_PRODUCER", severity: "medium", message: `„${doc.fileName}” ar trebui generat de sistemul emitentului, dar a fost produs cu ${producer.value}.`, citations: [producer.id], values: [producer.value] });

        if (m.creationDate && m.modDate) {
          const c = meta("fileCreationDate", m.creationDate)!;
          const md = meta("fileModDate", m.modDate)!;
          const diffH = Math.abs(new Date(m.modDate).getTime() - new Date(m.creationDate).getTime()) / 3_600_000;
          if (diffH > 1)
            add({ code: "FRAUD_MODIFIED_AFTER_CREATION", severity: SYSTEM_GENERATED.has(typeFact.docType) ? "medium" : "low", message: `„${doc.fileName}” a fost modificat la ${Math.round(diffH)} ore după creare.`, citations: [c.id, md.id], values: [m.creationDate, m.modDate] });
        }
        if ((m.incrementalUpdates ?? 0) > 0 && SYSTEM_GENERATED.has(typeFact.docType)) {
          const f = meta("pdfIncrementalUpdates", String(m.incrementalUpdates))!;
          add({ code: "FRAUD_INCREMENTAL_UPDATE", severity: "medium", message: `„${doc.fileName}” conține ${m.incrementalUpdates} revizii ulterioare salvate peste documentul original.`, citations: [f.id], values: [String(m.incrementalUpdates)] });
        }

        // Same file or same visual template submitted in other customers' cases. A customer re-using their
        // own documents (e.g. a loan after onboarding) is normal: compare the CNP read in the other case.
        for (const [kind, hash] of [["sha256", doc.sha256], ["phash", m.perceptualHash]] as const) {
          if (!hash) continue;
          const all = (await deps.cases.findByPerceptualHash(`${kind}:${hash}`)).filter((o) => o.caseId !== ctx.case.id);
          const others: typeof all = [];
          for (const o of all) if (!(await sameCustomer(deps.cases, o.caseId, ownCnp))) others.push(o);
          if (others.length) {
            const f = meta(`${kind}Reuse`, `${others.length} other case(s)`)!;
            add({
              code: kind === "sha256" ? "FRAUD_FILE_REUSED" : "FRAUD_TEMPLATE_REUSED",
              severity: "high",
              message: `„${doc.fileName}” ${kind === "sha256" ? "este identic cu" : "are același șablon vizual ca"} un document din alte ${others.length} dosare.`,
              citations: [f.id, typeFact.id],
              values: others.map((o) => o.caseId),
            });
          }
        }

        // OCR confidence outliers on amount lines (pasted digits typically read worse than the rest of the page)
        const ocr = ctx.ocr[doc.id];
        if (ocr && ["bank_statement", "payslip", "employment_contract"].includes(typeFact.docType)) {
          const all = ocr.pages.flatMap((p) => p.lines.map((l) => ({ ...l, page: p.page })));
          const median = [...all].map((l) => l.confidence).sort((a, b) => a - b)[Math.floor(all.length / 2)] ?? 100;
          const outliers = all.filter((l) => /\d[\d.,]{3,}/.test(l.text) && l.confidence < median - 25);
          if (outliers.length) {
            const fs = outliers.slice(0, 5).map((l, i) =>
              makeFact({ docId: doc.id, docType: typeFact.docType, field: "lowConfidenceAmountLine", value: l.text, normalized: l.text, page: l.page, bbox: l.bbox, ocrConfidence: l.confidence, extractor: "ocr-outlier", seq: i + 1 }),
            );
            facts.push(...fs);
            add({ code: "FRAUD_OCR_OUTLIER", severity: "low", message: `${outliers.length} rânduri cu sume din „${doc.fileName}” au o calitate a imaginii mult sub restul paginii (mediană ${median.toFixed(0)}%).`, citations: fs.map((f) => f.id), values: [String(outliers.length)] });
          }
        }
      }

      // Contradictory dates: salary credits outside the statement period
      for (const start of factsOf(ctx.facts, "periodStart")) {
        const end = ctx.facts.find((f) => f.docId === start.docId && f.field === "periodEnd");
        const s = parseDate(start.normalized);
        const e = end && parseDate(end.normalized);
        if (!s || !e) continue;
        for (const d of ctx.facts.filter((f) => f.docId === start.docId && f.field === "salaryCreditDate")) {
          const iso = parseDate(d.normalized);
          if (iso && (iso < s || iso > e))
            add({ code: "FRAUD_DATE_OUTSIDE_PERIOD", severity: "medium", message: `Tranzacția din ${iso} este în afara perioadei extrasului (${s} – ${e}).`, citations: [start.id, end!.id, d.id], values: [iso, s, e] });
        }
      }

      return { status: "ok", findings, facts };
    },
  };
}
