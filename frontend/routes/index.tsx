import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Table, TableCard } from "@/components/application/table/table";
import { Alert, PageHeader } from "@/components/app/ui";
import { useQuery } from "@/lib/api";
import { WORKFLOW_LABEL } from "@/lib/labels";
import type { CaseListItem } from "@/lib/types";

export const Route = createFileRoute("/")({ component: CaseList });

const DECISION: Record<string, { label: string; color: "success" | "error" | "warning" }> = {
  approved: { label: "Aprobat", color: "success" },
  rejected: { label: "Respins", color: "error" },
  info_requested: { label: "Informații solicitate", color: "warning" },
};

function CaseList() {
  const navigate = useNavigate();
  const { data, error, loading } = useQuery<CaseListItem[]>("/cases?limit=100");

  return (
    <>
      <PageHeader
        title="Dosare"
        description="Dosarele de deschidere de cont și de creditare verificate de agenți."
        actions={
          <Button iconLeading={Plus} onPress={() => navigate({ to: "/cases/new" })}>
            Dosar nou
          </Button>
        }
      />
      {error && <Alert kind="error" title="Dosarele nu au putut fi încărcate">{error.message}</Alert>}
      {loading && !data && <p className="text-sm text-tertiary">Se încarcă…</p>}
      {data && (
        <TableCard.Root>
          <TableCard.Header title="Toate dosarele" badge={`${data.length}`} description="Clic pe un dosar pentru verificare și decizie." />
          <Table aria-label="Dosare" onRowAction={(key) => navigate({ to: "/cases/$caseId", params: { caseId: String(key) } })}>
            <Table.Header>
              <Table.Head id="client" label="Client" isRowHeader />
              <Table.Head id="flux" label="Flux" />
              <Table.Head id="docs" label="Documente" />
              <Table.Head id="runs" label="Verificări" />
              <Table.Head id="decision" label="Decizie" />
              <Table.Head id="created" label="Creat" />
            </Table.Header>
            <Table.Body items={data} renderEmptyState={() => <p className="py-10 text-center text-sm text-tertiary">Niciun dosar încă.</p>}>
              {(c) => (
                <Table.Row id={c.id} className="cursor-pointer">
                  <Table.Cell>
                    <span className="font-medium text-primary">{c.customerRef}</span>
                  </Table.Cell>
                  <Table.Cell>{WORKFLOW_LABEL[c.workflow]}</Table.Cell>
                  <Table.Cell>{c.documents}</Table.Cell>
                  <Table.Cell>{c.runs}</Table.Cell>
                  <Table.Cell>
                    {c.decision ? (
                      <Badge type="pill-color" size="sm" color={DECISION[c.decision]?.color ?? "gray"}>
                        {DECISION[c.decision]?.label ?? c.decision}
                      </Badge>
                    ) : (
                      <span className="text-quaternary">—</span>
                    )}
                  </Table.Cell>
                  <Table.Cell>{new Date(c.createdAt).toLocaleString("ro-RO")}</Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table>
        </TableCard.Root>
      )}
    </>
  );
}
