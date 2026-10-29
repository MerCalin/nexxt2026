import { useState } from "react";
import { CheckCircle, ClipboardCheck, File06, RefreshCw01, ShieldTick, UploadCloud02 } from "@untitledui/icons";
import { DropZone, FileTrigger } from "react-aria-components";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { TextArea } from "@/components/base/textarea/textarea";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { Alert, Card } from "@/components/app/ui";
import { api } from "@/lib/api";
import { CONSENT_LABEL, NOTICE_VERSION } from "@/lib/labels";
import type { AuditEntry, Case, Requirement } from "@/lib/types";
import { cx } from "@/utils/cx";

const ACCEPT = ["application/pdf", "image/png", "image/jpeg", "image/tiff"];

export function UploadPanel({ c, requirements, onChange }: { c: Case; requirements: Requirement[]; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function upload(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    setError(undefined);
    try {
      for (const f of files) await api.upload(`/cases/${c.id}/documents`, f);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Documente" description={`${c.documents.length} încărcate`}>
      {c.documents.length > 0 && (
        <ul className="mb-4 flex flex-col gap-2">
          {c.documents.map((d) => (
            <li key={d.id} className="flex items-center gap-3 rounded-lg p-2 ring-1 ring-secondary">
              <FeaturedIcon icon={File06} color="gray" theme="modern" size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-secondary">{d.fileName}</span>
              <span className="shrink-0 text-xs text-tertiary">{(d.sizeBytes / 1024).toFixed(0)} KB</span>
            </li>
          ))}
        </ul>
      )}
      {!c.decision && (
        <DropZone
          isDisabled={busy}
          getDropOperation={(types) => (ACCEPT.some((t) => types.has(t)) ? "copy" : "cancel")}
          onDrop={async (e) => {
            const files = await Promise.all(e.items.filter((i) => i.kind === "file").map((i) => (i as { getFile: () => Promise<File> }).getFile()));
            await upload(files);
          }}
          className={({ isDropTarget }) =>
            cx("flex flex-col items-center gap-3 rounded-xl px-6 py-5 text-center ring-1 transition", isDropTarget ? "bg-brand-primary_alt ring-2 ring-brand" : "bg-primary ring-secondary", busy && "opacity-60")
          }
        >
          <FeaturedIcon icon={UploadCloud02} color="gray" theme="modern" size="md" />
          <div className="text-sm text-tertiary">
            <FileTrigger acceptedFileTypes={ACCEPT} allowsMultiple onSelect={(list) => upload(list ? Array.from(list) : [])}>
              <Button color="link-color" size="md" isDisabled={busy}>
                {busy ? "Se încarcă…" : "Alegeți fișiere"}
              </Button>
            </FileTrigger>{" "}
            sau trageți-le aici
            <p className="mt-1 text-xs">PDF, PNG, JPEG sau TIFF, maximum 10 MB</p>
          </div>
        </DropZone>
      )}
      {error && (
        <div className="mt-3">
          <Alert kind="error" title="Încărcarea a eșuat">{error}</Alert>
        </div>
      )}
      <details className="mt-4 text-xs text-tertiary">
        <summary className="cursor-pointer font-medium text-secondary">Documente necesare</summary>
        <ul className="mt-2 flex flex-col gap-1">
          {requirements.map((r) => (
            <li key={r.id} className="flex gap-2">
              <CheckCircle className={cx("size-4 shrink-0", r.optional ? "text-fg-quaternary" : "text-fg-brand-primary")} />
              {r.label}
              {r.optional && " (opțional)"}
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

export function ConsentPanel({ c, onChange }: { c: Case; onChange: () => void }) {
  const purposes = c.workflow === "onboarding" ? ["criminal_record_lookup", "anaf_tax_debt_lookup"] : ["credit_bureau_lookup", "criminal_record_lookup", "anaf_tax_debt_lookup"];
  const [error, setError] = useState<string>();
  const active = (p: string) => c.consents.find((x) => x.purpose === p && !x.withdrawnAt);

  async function record(purpose: string) {
    setError(undefined);
    try {
      await api.post(`/cases/${c.id}/consents`, { purpose, noticeVersion: NOTICE_VERSION, givenAt: new Date().toISOString(), channel: "branch_tablet" });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Card title="Acordul clientului" description={`Nota de informare ${NOTICE_VERSION} (GDPR art. 13). Fără acord, verificarea este blocată.`}>
      <ul className="flex flex-col gap-3">
        {purposes.map((p) => {
          const a = active(p);
          return (
            <li key={p} className="flex items-center justify-between gap-3">
              <span className="text-sm text-secondary">{CONSENT_LABEL[p]}</span>
              {a ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Badge type="pill-color" color="success" size="sm">
                    {new Date(a.givenAt).toLocaleDateString("ro-RO")}
                  </Badge>
                  {!c.decision && (
                    <Button color="link-gray" size="sm" onPress={() => api.del(`/cases/${c.id}/consents/${a.id}`).then(onChange)}>
                      Retrage
                    </Button>
                  )}
                </div>
              ) : (
                !c.decision && (
                  <Button color="secondary" size="sm" iconLeading={ShieldTick} onPress={() => record(p)}>
                    Înregistrează
                  </Button>
                )
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <div className="mt-3">
          <Alert kind="error" title="Acordul nu a putut fi înregistrat">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

type Outcome = "approved" | "rejected" | "info_requested";
const OUTCOMES: { id: Outcome; label: string }[] = [
  { id: "approved", label: "Aprob" },
  { id: "info_requested", label: "Solicit informații" },
  { id: "rejected", label: "Resping" },
];
const OUTCOME_DONE: Record<Outcome, { label: string; color: "success" | "error" | "warning" }> = {
  approved: { label: "Aprobat", color: "success" },
  rejected: { label: "Respins", color: "error" },
  info_requested: { label: "Informații solicitate", color: "warning" },
};

export function DecisionPanel({ c, canDecide, onChange }: { c: Case; canDecide: boolean; onChange: () => void }) {
  const [outcome, setOutcome] = useState<Outcome>("info_requested");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (c.decision) {
    const d = OUTCOME_DONE[c.decision.outcome];
    return (
      <Card title="Decizie înregistrată" actions={<Badge type="pill-color" color={d.color}>{d.label}</Badge>}>
        <p className="text-sm text-secondary">{c.decision.reason}</p>
        <p className="mt-3 text-xs text-tertiary">
          {c.decision.officerId} ({c.decision.officerRole}) · {new Date(c.decision.decidedAt).toLocaleString("ro-RO")}
        </p>
      </Card>
    );
  }

  async function submit() {
    setError(undefined);
    setBusy(true);
    try {
      await api.post(`/cases/${c.id}/decision`, { outcome, reason });
      onChange();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg === "compliance_review_required" ? "Dosarul are constatări confidențiale deschise: aprobarea poate fi dată doar de departamentul Conformitate." : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Decizia ofițerului" description="Recomandarea sistemului nu este o decizie. Analizați dovezile citate și motivați decizia.">
      <div className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="Decizie" className="grid grid-cols-3 overflow-hidden rounded-lg ring-1 ring-primary">
          {OUTCOMES.map((o, i) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={outcome === o.id}
              onClick={() => setOutcome(o.id)}
              className={cx("px-3 py-2 text-sm font-semibold transition", i > 0 && "border-l border-primary", outcome === o.id ? "bg-active text-primary" : "bg-primary text-secondary hover:bg-primary_hover")}
            >
              {o.label}
            </button>
          ))}
        </div>
        <TextArea label="Motivarea deciziei" hint="Minimum 10 caractere; se păstrează în dosar." placeholder="ex. Numele de pe factură diferă; am verificat originalul…" rows={4} value={reason} onChange={setReason} isRequired />
        {error && <Alert kind="error" title="Decizia nu a fost înregistrată">{error}</Alert>}
        <Button iconLeading={ClipboardCheck} isDisabled={!canDecide || reason.trim().length < 10} isLoading={busy} onPress={submit} className="w-full">
          Înregistrează decizia
        </Button>
        {!canDecide && <p className="text-xs text-tertiary">Decizia este disponibilă după finalizarea verificării.</p>}
      </div>
    </Card>
  );
}

export function AuditPanel({ caseId }: { caseId: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>();
  const [verify, setVerify] = useState<{ valid: boolean; entries: number; brokenAtSeq?: number; reason?: string }>();
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const [e, v] = await Promise.all([api.get<AuditEntry[]>(`/cases/${caseId}/audit`), api.get<typeof verify>(`/cases/${caseId}/audit/verify`)]);
      setEntries(e.sort((a, b) => a.seq - b.seq));
      setVerify(v);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Jurnal de audit"
      description="Lanț de hash-uri, doar adăugare"
      actions={
        <Button color="secondary" size="sm" iconLeading={RefreshCw01} isLoading={busy} onPress={load}>
          {entries ? "Reîncarcă" : "Afișează"}
        </Button>
      }
    >
      {!verify && <p className="text-sm text-tertiary">Apăsați „Afișează” pentru a verifica integritatea jurnalului.</p>}
      {verify && (
        <Alert kind={verify.valid ? "success" : "error"} title={verify.valid ? `Lanț valid · ${verify.entries} înregistrări` : `Lanț rupt la #${verify.brokenAtSeq}`}>
          {!verify.valid && verify.reason}
        </Alert>
      )}
      {entries && (
        <ol className="mt-4 flex max-h-96 flex-col gap-1 overflow-y-auto">
          {entries.map((e) => (
            <li key={e.seq} className="grid grid-cols-[2.5rem_4.5rem_1fr] items-baseline gap-2 rounded-md px-2 py-1 text-xs hover:bg-primary_hover" title={e.hash}>
              <span className="font-mono text-quaternary">#{e.seq}</span>
              <span className="text-tertiary">{new Date(e.at).toLocaleTimeString("ro-RO")}</span>
              <span className="min-w-0 truncate">
                <span className="font-medium text-brand-secondary">{e.actor}</span> <span className={cx("text-secondary", e.action.endsWith("failed") && "font-semibold text-error-primary")}>{e.action}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
