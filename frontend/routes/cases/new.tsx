import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { FC } from "react";
import { useState } from "react";
import { Building07, CheckCircle, CreditCard02, Users01 } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { Alert, Card, PageHeader } from "@/components/app/ui";
import { api, useQuery } from "@/lib/api";
import { WORKFLOW_LABEL } from "@/lib/labels";
import type { Case, Requirement, Workflow } from "@/lib/types";
import { cx } from "@/utils/cx";

export const Route = createFileRoute("/cases/new")({ component: NewCase });

const WORKFLOWS: { id: Workflow; icon: FC<{ className?: string }>; hint: string }[] = [
  { id: "onboarding", icon: Users01, hint: "Identitate și reședință, screening AML" },
  { id: "loan", icon: CreditCard02, hint: "Plus venit, istoric de credit, grad de îndatorare" },
  { id: "mortgage", icon: Building07, hint: "Plus carte funciară și raport de evaluare" },
];

function NewCase() {
  const navigate = useNavigate();
  const [workflow, setWorkflow] = useState<Workflow>("onboarding");
  const [customerRef, setCustomerRef] = useState("");
  const [sourceOfFunds, setSourceOfFunds] = useState("");
  const [loan, setLoan] = useState({ amount: "", currency: "RON", termMonths: "", annualRatePct: "", purchasePrice: "" });
  const [firstHome, setFirstHome] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { data: reqs } = useQuery<Requirement[]>(`/requirements/${workflow}`);
  const set = (k: keyof typeof loan) => (v: string) => setLoan({ ...loan, [k]: v });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const subject = {
        customerRef,
        declaredSourceOfFunds: sourceOfFunds || undefined,
        ...(workflow !== "onboarding"
          ? {
              isFirstHome: workflow === "mortgage" ? firstHome : undefined,
              loan: {
                amount: Number(loan.amount),
                currency: loan.currency,
                termMonths: Number(loan.termMonths),
                annualRatePct: Number(loan.annualRatePct),
                ...(workflow === "mortgage" && loan.purchasePrice ? { purchasePrice: Number(loan.purchasePrice) } : {}),
              },
            }
          : {}),
      };
      const c = await api.post<Case>("/cases", { workflow, subject });
      navigate({ to: "/cases/$caseId", params: { caseId: c.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Dosar nou" description="Alegeți fluxul, apoi încărcați documentele clientului în pagina dosarului." />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <form onSubmit={submit}>
          <Card title="Detalii dosar">
            <div className="flex flex-col gap-6">
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-secondary">Flux</legend>
                <div className="grid gap-3 md:grid-cols-3">
                  {WORKFLOWS.map((w) => {
                    const selected = workflow === w.id;
                    return (
                      <button
                        type="button"
                        key={w.id}
                        onClick={() => setWorkflow(w.id)}
                        aria-pressed={selected}
                        className={cx(
                          "relative flex flex-col items-start gap-3 rounded-xl p-4 text-left ring-1 transition",
                          selected ? "bg-brand-primary_alt ring-2 ring-brand" : "bg-primary ring-secondary hover:bg-primary_hover",
                        )}
                      >
                        <FeaturedIcon icon={w.icon} color={selected ? "brand" : "gray"} theme="modern" size="md" />
                        <span>
                          <span className="block text-sm font-semibold text-primary">{WORKFLOW_LABEL[w.id]}</span>
                          <span className="mt-0.5 block text-sm text-tertiary">{w.hint}</span>
                        </span>
                        {selected && <CheckCircle className="absolute top-3 right-3 size-5 text-fg-brand-primary" />}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <div className="grid gap-5 md:grid-cols-2">
                <Input label="Referință client" hint="Identificatorul din sistemul băncii" placeholder="CUST-000123" value={customerRef} onChange={setCustomerRef} isRequired />
                <Input label="Sursa declarată a fondurilor" hint="Opțional, ex. salariu, pensie, economii" value={sourceOfFunds} onChange={setSourceOfFunds} />
              </div>

              {workflow !== "onboarding" && (
                <div className="flex flex-col gap-4 rounded-xl bg-secondary p-4">
                  <span className="text-sm font-semibold text-primary">Credit solicitat</span>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Input label="Sumă" type="number" value={loan.amount} onChange={set("amount")} isRequired />
                    <Select
                      label="Monedă"
                      selectedKey={loan.currency}
                      onSelectionChange={(k) => set("currency")(String(k))}
                      items={[
                        { id: "RON", label: "RON" },
                        { id: "EUR", label: "EUR" },
                      ]}
                    >
                      {(item) => <Select.Item id={item.id} label={item.label} />}
                    </Select>
                    <Input label="Durată (luni)" type="number" value={loan.termMonths} onChange={set("termMonths")} isRequired />
                    <Input label="Dobândă anuală (%)" type="number" value={loan.annualRatePct} onChange={set("annualRatePct")} isRequired />
                    {workflow === "mortgage" && (
                      <>
                        <Input label="Preț de achiziție" hint="Opțional; lipsă = refinanțare" type="number" value={loan.purchasePrice} onChange={set("purchasePrice")} />
                        <div className="flex items-end pb-2">
                          <Checkbox label="Prima locuință" hint="Limita DTI crește cu 5 puncte" isSelected={firstHome} onChange={setFirstHome} />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {error && <Alert kind="error" title="Dosarul nu a putut fi creat">{error}</Alert>}
              <div className="flex justify-end gap-3">
                <Button color="secondary" onPress={() => navigate({ to: "/" })}>
                  Renunță
                </Button>
                <Button type="submit" isLoading={busy}>
                  Creează dosarul
                </Button>
              </div>
            </div>
          </Card>
        </form>

        <Card title="Documente necesare" description={WORKFLOW_LABEL[workflow]}>
          <ul className="flex flex-col gap-3">
            {reqs?.map((r) => (
              <li key={r.id} className="flex gap-3 text-sm">
                <CheckCircle className={cx("mt-0.5 size-5 shrink-0", r.optional ? "text-fg-quaternary" : "text-fg-brand-primary")} />
                <span className={r.optional ? "text-tertiary" : "text-secondary"}>
                  {r.label}
                  {r.optional && " (opțional)"}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-5 border-t border-secondary pt-4 text-xs text-tertiary">
            Facturile de telefonie, internet sau gaze nu sunt acceptate ca dovadă a reședinței. Cazierul judiciar și datoriile ANAF se verifică direct la autorități, cu acordul clientului.
          </p>
        </Card>
      </div>
    </>
  );
}
