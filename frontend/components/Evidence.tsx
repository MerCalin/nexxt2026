import { File06, Stars02 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { ConfidentialBadge, SeverityBadge, SimulatedBadge } from "@/components/app/ui";
import { AGENT_LABEL } from "@/lib/labels";
import type { AiText, ExternalCheck, Fact, Finding } from "@/lib/types";
import { cx } from "@/utils/cx";

export type EvidenceIndex = { facts: Map<string, Fact>; checks: Map<string, ExternalCheck> };

/** A clickable reference to the fact or external check a sentence relies on. */
export function CitationChip({ id, index, onOpen }: { id: string; index: EvidenceIndex; onOpen: (id: string) => void }) {
  const fact = index.facts.get(id);
  const check = index.checks.get(id);
  const label = fact ? `${fact.field}: ${fact.value.length > 28 ? `${fact.value.slice(0, 28)}…` : fact.value}` : check ? `${check.source}` : id;
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      disabled={!fact && !check}
      title={id}
      className={cx(
        "mt-1.5 mr-1.5 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 transition ring-inset disabled:opacity-50",
        check?.simulated
          ? "bg-utility-purple-50 text-utility-purple-700 ring-utility-purple-200 hover:bg-utility-purple-100"
          : "bg-primary text-secondary ring-primary hover:bg-primary_hover",
      )}
    >
      <File06 className="size-3 shrink-0 text-fg-quaternary" />
      <span className="truncate">{label}</span>
      {check?.simulated && <span className="font-semibold">· SIMULAT</span>}
    </button>
  );
}

export function FindingsList({ findings, index, onOpen }: { findings: Finding[]; index: EvidenceIndex; onOpen: (id: string) => void }) {
  if (!findings.length) return <p className="text-sm text-tertiary">Nicio constatare.</p>;
  return (
    <ul className="-my-3 divide-y divide-secondary">
      {findings.map((f) => (
        <li key={f.id} className="flex gap-3 py-3">
          <div className="w-20 shrink-0 pt-0.5">
            <SeverityBadge severity={f.severity} />
          </div>
          <div className="min-w-0 text-sm">
            {(f.simulated || f.visibility === "compliance") && (
              <div className="mb-1 flex flex-wrap gap-1.5">
                {f.simulated && <SimulatedBadge />}
                {f.visibility === "compliance" && <ConfidentialBadge />}
              </div>
            )}
            <p className="text-primary">{f.message}</p>
            <p className="mt-0.5 text-xs text-quaternary">
              {f.code} · {AGENT_LABEL[f.agent] ?? f.agent}
            </p>
            <div>
              {f.citations.map((c) => (
                <CitationChip key={c} id={c} index={index} onOpen={onOpen} />
              ))}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

const FALLBACK_LABEL: Record<NonNullable<AiText["fallbackReason"]>, string> = {
  ai_call_failed: "Serviciul AI nu a răspuns",
  validation_failed: "Text AI respins de validator",
  no_output: "AI nu a produs text",
};

export function AiTextBlock({ title, text, index, onOpen, note }: { title: string; text?: AiText; index: EvidenceIndex; onOpen: (id: string) => void; note?: string }) {
  if (!text) return null;
  return (
    <section className="rounded-xl bg-primary shadow-xs ring-1 ring-secondary">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-secondary px-5 py-4">
        <div className="flex items-center gap-2">
          <Stars02 className="size-5 text-fg-brand-primary" />
          <h3 className="text-md font-semibold text-primary">{title}</h3>
        </div>
        {text.fallback ? (
          <Badge type="color" size="sm" color={text.fallbackReason === "ai_call_failed" ? "error" : "warning"}>
            Șablon determinist — {FALLBACK_LABEL[text.fallbackReason ?? "validation_failed"]}
          </Badge>
        ) : (
          <Badge type="color" size="sm" color="brand">
            Generat AI · {text.modelId}
          </Badge>
        )}
      </header>
      <div className="px-5 py-4">
        {note && <p className="mb-3 text-xs text-tertiary">{note}</p>}
        <ul className="flex flex-col gap-3 text-sm">
          {text.sentences.map((s, i) => (
            <li key={`${i}-${s.text.slice(0, 20)}`} className="text-primary">
              {s.text}
              <div>
                {s.citations.map((c) => (
                  <CitationChip key={c} id={c} index={index} onOpen={onOpen} />
                ))}
              </div>
            </li>
          ))}
          {!text.sentences.length && <li className="text-tertiary">Nicio propoziție validată.</li>}
        </ul>
        {text.rejected.length > 0 && (
          <details className="mt-4 text-xs text-tertiary">
            <summary className="cursor-pointer font-medium text-secondary">
              {text.fallbackReason === "ai_call_failed" ? "Detalii eroare AI" : `${text.rejected.length} propoziții AI respinse de validator`}
            </summary>
            <ul className="mt-2 list-disc pl-5">
              {text.rejected.map((r, i) => (
                <li key={`${i}-${r.reason}`}>
                  „{r.text}” — {r.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="mt-4 text-xs text-quaternary">{text.promptVersion}</p>
      </div>
    </section>
  );
}
