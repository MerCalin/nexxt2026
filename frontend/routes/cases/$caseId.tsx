import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Clock, FileSearch02, RefreshCw01, SearchLg } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Tab, TabList, TabPanel, Tabs } from "@/components/application/tabs/tabs";
import { AgentStatusBadge, Alert, Card, LaneBadge, PageHeader } from "@/components/app/ui";
import { AuditPanel, ConsentPanel, DecisionPanel, UploadPanel } from "@/components/CasePanels";
import { AiTextBlock, type EvidenceIndex, FindingsList } from "@/components/Evidence";
import { EvidenceViewer } from "@/components/EvidenceViewer";
import { api, useQuery } from "@/lib/api";
import { AGENT_LABEL, DOC_TYPE_LABEL, WORKFLOW_LABEL } from "@/lib/labels";
import type { CaseView, ExternalCheck, Fact, Severity } from "@/lib/types";

export const Route = createFileRoute("/cases/$caseId")({ component: CasePage });

const SEVERITY_ORDER: Severity[] = ["high", "medium", "low", "info"];

function CasePage() {
  const { caseId } = Route.useParams();
  // refresh automatically while the latest run is in progress — also when the page was opened or
  // reloaded mid-run, not only when the run was started from this page
  const [polling, setPolling] = useState(false);
  const { data, error, reload } = useQuery<CaseView>(`/cases/${caseId}`, { pollMs: polling ? 3000 : undefined });
  const [open, setOpen] = useState<string>();
  const [runError, setRunError] = useState<string>();
  const [starting, setStarting] = useState(false);

  const run = data?.run;
  const active = run?.status === "queued" || run?.status === "running";
  useEffect(() => setPolling(active), [active]);

  const index: EvidenceIndex = useMemo(() => {
    const facts = new Map<string, Fact>();
    const checks = new Map<string, ExternalCheck>();
    for (const r of run?.results ?? []) {
      for (const f of r.facts) facts.set(f.id, f);
      for (const c of r.checks) checks.set(c.id, c);
    }
    return { facts, checks };
  }, [run]);

  if (error) return <Alert kind="error" title="Dosarul nu a putut fi încărcat">{error.message}</Alert>;
  if (!data) return <p className="text-sm text-tertiary">Se încarcă…</p>;
  const c = data.case;

  async function startRun() {
    setRunError(undefined);
    setStarting(true);
    try {
      await api.post(`/cases/${c.id}/runs`);
      setPolling(true);
      await reload();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  const findings = (run?.results ?? []).flatMap((r) => r.findings).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length])) as Record<Severity, number>;
  const blockedChecks = (run?.results ?? []).flatMap((r) => r.checks).filter((x) => x.status === "blocked" || x.status === "unavailable");
  const classification = run?.results.find((r) => r.agent === "classification")?.data as { docs?: Record<string, { docType: string }> } | undefined;
  const affordability = run?.results.find((r) => r.agent === "affordability")?.data as { formula?: string; dti?: number; limit?: number; limitConfirmedByCompliance?: boolean } | undefined;

  return (
    <>
      <Link to="/" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-tertiary hover:text-secondary">
        <ArrowLeft className="size-4" /> Dosare
      </Link>
      <PageHeader
        title={c.subject.customerRef}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <Badge type="color" color="brand" size="md">
              {WORKFLOW_LABEL[c.workflow]}
            </Badge>
            {run?.recommendation && <LaneBadge lane={run.recommendation.lane} />}
            {run && (
              <span className="inline-flex items-center gap-1 text-sm text-tertiary">
                <Clock className="size-4" />
                {run.status === "completed" && run.finishedAt ? `Verificat ${new Date(run.finishedAt).toLocaleString("ro-RO")}` : run.status}
              </span>
            )}
          </div>
        }
        actions={
          !c.decision && (
            <Button size="md" iconLeading={run ? RefreshCw01 : SearchLg} isLoading={active || starting} isDisabled={!c.documents.length} onPress={startRun}>
              {active ? "Verificare în curs…" : run ? "Reverifică" : "Pornește verificarea"}
            </Button>
          )
        }
      />

      <div className="mb-6 flex flex-col gap-3">
        {runError && <Alert kind="error" title="Verificarea nu a pornit">{runError}</Alert>}
        {run?.status === "failed" && <Alert kind="error" title="Verificarea a eșuat">{run.error}</Alert>}
        {!!run?.ocrFailures?.length && (
          <Alert kind="error" title="Documente care nu au putut fi citite (OCR) — agenții nu au avut text pentru ele">
            <ul className="list-disc pl-5">
              {run.ocrFailures.map((f) => (
                <li key={f.docId}>
                  {f.fileName}: <span className="font-mono text-xs">{f.error}</span>
                </li>
              ))}
            </ul>
          </Alert>
        )}
        {blockedChecks.length > 0 && (
          <Alert kind="warning" title="Verificări blocate">
            <ul className="list-disc pl-5">
              {blockedChecks.map((b) => (
                <li key={b.id}>
                  {b.source} — {b.reason}
                </li>
              ))}
            </ul>
          </Alert>
        )}
        {!run && c.documents.length > 0 && (
          <Alert kind="info" title="Gata de verificare">
            Înregistrați acordurile clientului în panoul din dreapta, apoi apăsați „Pornește verificarea”.
          </Alert>
        )}
      </div>

      {run && run.status === "completed" && (
        <dl className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "Constatări ridicate", value: counts.high, tone: counts.high ? "text-error-primary" : "text-primary" },
            { label: "Constatări medii", value: counts.medium, tone: counts.medium ? "text-warning-primary" : "text-primary" },
            { label: "Documente", value: c.documents.length, tone: "text-primary" },
            affordability?.dti !== undefined
              ? { label: `Grad de îndatorare (limită ${((affordability.limit ?? 0) * 100).toFixed(0)}%)`, value: `${(affordability.dti * 100).toFixed(1)}%`, tone: affordability.dti > (affordability.limit ?? 1) ? "text-error-primary" : "text-primary" }
              : { label: "Constatări scăzute", value: counts.low, tone: "text-primary" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl bg-primary px-5 py-4 shadow-xs ring-1 ring-secondary">
              <dt className="text-sm font-medium text-tertiary">{s.label}</dt>
              <dd className={`mt-1 text-display-xs font-semibold ${s.tone}`}>{s.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
        <div className="min-w-0">
          {run ? (
            <Tabs>
              <TabList type="underline" size="md" className="mb-5">
                <Tab id="summary" label="Rezumat" />
                <Tab id="findings" label="Constatări" badge={findings.length} />
                <Tab id="agents" label="Agenți și documente" />
                <Tab id="customer" label="Mesaj client" />
              </TabList>

              <TabPanel id="summary" className="flex flex-col gap-5">
                <AiTextBlock title="Rezumat pentru ofițer" text={run.officerSummary} index={index} onOpen={setOpen} />
                <AiTextBlock title="Rezumat Conformitate (confidențial)" text={run.complianceSummary} index={index} onOpen={setOpen} />
                <AiTextBlock title="Explicații posibile" text={run.investigation} index={index} onOpen={setOpen} note="Ipoteze de verificat, nu concluzii. Confirmați cu documente înainte de a le folosi." />
                {!run.officerSummary && active && <p className="text-sm text-tertiary">Agenții lucrează…</p>}
              </TabPanel>

              <TabPanel id="findings">
                <Card title="Constatări" description="Detectate de reguli fixe; fiecare citează dovezile.">
                  {affordability?.formula && (
                    <div className="mb-4 rounded-lg bg-secondary px-3 py-2 font-mono text-xs text-secondary">
                      DTI: {affordability.formula}
                      {affordability.limitConfirmedByCompliance === false && <span className="ml-2 font-sans text-warning-primary">(prag neconfirmat încă de Conformitate)</span>}
                    </div>
                  )}
                  <FindingsList findings={findings} index={index} onOpen={setOpen} />
                </Card>
              </TabPanel>

              <TabPanel id="agents" className="flex flex-col gap-5">
                <Card title="Agenți" description="Starea fiecărui agent în ultima verificare.">
                  <div className="flex flex-wrap gap-2">
                    {run.results.map((r) => (
                      <AgentStatusBadge key={r.agent} name={AGENT_LABEL[r.agent] ?? r.agent} status={r.status} title={r.error} />
                    ))}
                  </div>
                </Card>
                {classification?.docs && (
                  <Card title="Clasificarea documentelor">
                    <ul className="-my-2 divide-y divide-secondary">
                      {c.documents.map((d) => {
                        const t = classification.docs?.[d.id]?.docType ?? "unknown";
                        return (
                          <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                            <span className="flex min-w-0 items-center gap-2 text-sm text-secondary">
                              <FileSearch02 className="size-4 shrink-0 text-fg-quaternary" />
                              <span className="truncate">{d.fileName}</span>
                            </span>
                            <Badge type="color" size="sm" color={t === "unknown" || t === "utility_bill_rejected" ? "error" : "gray"}>
                              {DOC_TYPE_LABEL[t] ?? t}
                            </Badge>
                          </li>
                        );
                      })}
                    </ul>
                  </Card>
                )}
              </TabPanel>

              <TabPanel id="customer">
                {run.customerMessage ? (
                  <AiTextBlock
                    title="Mesaj către client (ciornă)"
                    text={run.customerMessage}
                    index={index}
                    onOpen={setOpen}
                    note="Mesajul este neutru: nu menționează verificări interne. Se trimite doar după revizuire, prin canalul obișnuit."
                  />
                ) : (
                  <Alert kind="info" title="Nu este necesar un mesaj către client">
                    Nicio constatare nu necesită documente sau clarificări suplimentare de la client.
                  </Alert>
                )}
              </TabPanel>
            </Tabs>
          ) : (
            <Card title="Nicio verificare încă">
              <p className="text-sm text-tertiary">Încărcați documentele clientului și înregistrați acordurile, apoi porniți verificarea.</p>
            </Card>
          )}
        </div>

        <aside className="flex flex-col gap-5">
          <DecisionPanel c={c} canDecide={run?.status === "completed"} onChange={reload} />
          <UploadPanel c={c} requirements={data.requirements} onChange={reload} />
          <ConsentPanel c={c} onChange={reload} />
          <AuditPanel caseId={c.id} />
        </aside>
      </div>

      {open && <EvidenceViewer caseId={c.id} documents={c.documents} fact={index.facts.get(open)} check={index.checks.get(open)} onClose={() => setOpen(undefined)} />}
    </>
  );
}
