import { useEffect, useRef, useState } from "react";
import { File06, Globe02 } from "@untitledui/icons";
import { CloseButton } from "@/components/base/buttons/close-button";
import { Dialog, Modal, ModalOverlay } from "@/components/application/slideout-menus/slideout-menu";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { Alert, SimulatedBadge } from "@/components/app/ui";
import { api } from "@/lib/api";
import { DOC_TYPE_LABEL } from "@/lib/labels";
import type { CaseDocument, ExternalCheck, Fact } from "@/lib/types";

/**
 * Slide-out showing the cited evidence: for a document fact, the page with the fact's bounding box
 * highlighted; for an external check, its source, status and payload.
 */
export function EvidenceViewer({ caseId, documents, fact, check, onClose }: { caseId: string; documents: CaseDocument[]; fact?: Fact; check?: ExternalCheck; onClose: () => void }) {
  return (
    <ModalOverlay isOpen isDismissable onOpenChange={(open) => !open && onClose()}>
      <Modal className="max-w-3xl">
        <Dialog aria-label="Dovadă citată" className="gap-0">
          <header className="sticky top-0 z-10 flex w-full items-start gap-4 border-b border-secondary bg-primary px-6 py-5">
            <FeaturedIcon icon={fact ? File06 : Globe02} color="brand" theme="modern" size="md" />
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold text-primary">Dovadă citată</h2>
              <p className="text-sm text-tertiary">{fact ? `${DOC_TYPE_LABEL[fact.docType] ?? fact.docType} · ${fact.field}` : check?.source}</p>
            </div>
            <CloseButton size="md" onPress={onClose} />
          </header>
          <div className="w-full px-6 py-5">
            {fact && <FactView caseId={caseId} doc={documents.find((d) => d.id === fact.docId)} fact={fact} />}
            {check && <CheckView check={check} />}
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <>
    <dt className="text-tertiary">{label}</dt>
    <dd className="min-w-0 text-primary">{children}</dd>
  </>
);

function FactView({ caseId, doc, fact }: { caseId: string; doc?: CaseDocument; fact: Fact }) {
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
        <Row label="Document">
          {DOC_TYPE_LABEL[fact.docType] ?? fact.docType} {doc && <span className="text-tertiary">— {doc.fileName}</span>}
        </Row>
        <Row label="Câmp">
          <span className="font-mono">{fact.field}</span>
        </Row>
        <Row label="Valoare citită">
          <span className="font-semibold">{fact.value}</span>
        </Row>
        <Row label="Pagina">{fact.page}</Row>
        <Row label="Încredere OCR">{fact.ocrConfidence ? `${fact.ocrConfidence.toFixed(0)}%` : "—"}</Row>
        <Row label="Metodă">
          <span className="font-mono text-xs">{fact.extractor}</span>
        </Row>
      </dl>
      {doc ? <PageWithBox caseId={caseId} doc={doc} page={fact.page} bbox={fact.bbox} /> : <Alert kind="info" title="Fapt la nivel de dosar">Nu provine dintr-un document încărcat.</Alert>}
    </div>
  );
}

function PageWithBox({ caseId, doc, page, bbox }: { caseId: string; doc: CaseDocument; page: number; bbox?: Fact["bbox"] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [imgUrl, setImgUrl] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let revoke: string | undefined;
    let cancelled = false;
    (async () => {
      try {
        const blob = await api.blob(`/cases/${caseId}/documents/${doc.id}/file`);
        if (doc.contentType !== "application/pdf") {
          revoke = URL.createObjectURL(blob);
          if (!cancelled) setImgUrl(revoke);
          return;
        }
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        const p = await pdf.getPage(Math.min(page, pdf.numPages));
        const viewport = p.getViewport({ scale: 1.5 });
        const c = canvas.current;
        if (!c || cancelled) return;
        c.width = viewport.width;
        c.height = viewport.height;
        await p.render({ canvas: c, viewport }).promise;
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      }
    })();
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [caseId, doc.id, doc.contentType, page]);

  if (error) return <Alert kind="error" title="Documentul nu a putut fi afișat">{error}</Alert>;
  return (
    <div className="relative w-full overflow-hidden rounded-lg ring-1 ring-secondary">
      {doc.contentType === "application/pdf" ? <canvas ref={canvas} className="block h-auto w-full" /> : imgUrl && <img src={imgUrl} alt={doc.fileName} className="block h-auto w-full" />}
      {bbox && (
        <div
          className="pointer-events-none absolute rounded-sm bg-utility-red-500/20 ring-2 ring-utility-red-500"
          style={{ left: `${bbox.left * 100}%`, top: `${bbox.top * 100}%`, width: `${bbox.width * 100}%`, height: `${bbox.height * 100}%` }}
        />
      )}
    </div>
  );
}

function CheckView({ check }: { check: ExternalCheck }) {
  return (
    <div className="flex flex-col gap-5 text-sm">
      {check.simulated && (
        <Alert kind="warning" title="Sursă simulată">
          Sursa nu este conectată la autoritatea reală; datele sunt de demonstrație. <SimulatedBadge />
        </Alert>
      )}
      <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2">
        <Row label="Sursă">{check.source}</Row>
        <Row label="Rezultat">
          <span className="font-semibold">{check.status}</span>
        </Row>
        {check.reason && <Row label="Motiv">{check.reason}</Row>}
        <Row label="Interogat la">{new Date(check.retrievedAt).toLocaleString("ro-RO")}</Row>
        {check.consentId && (
          <Row label="Acord">
            <span className="font-mono text-xs">{check.consentId}</span>
          </Row>
        )}
      </dl>
      <pre className="max-h-96 overflow-auto rounded-lg bg-secondary p-4 text-xs text-secondary">{JSON.stringify(check.payload, null, 2)}</pre>
    </div>
  );
}
