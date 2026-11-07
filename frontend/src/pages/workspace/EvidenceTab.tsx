import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearchParams } from "react-router-dom";
import type { DocType, Region } from "../../../../contracts/types";
import { api } from "../../api/client";
import { DocumentViewer } from "../../components/DocumentViewer";
import type { DocumentViewerHandle } from "../../components/DocumentViewer";
import { AnalyzerChecklist } from "../../components/Stepper";
import { Button, Confidence, EmptyState, StatusBadge } from "../../components/ui";
import { mockMode } from "../../config";
import { jobPollIntervalMs } from "../../config";
import { fixtureAnalysis } from "../../mockData";
import { DOC_TYPE_LABEL, humanize } from "../../lib/format";
import { isTerminal, pollDelay } from "../../lib/jobs";
import { prefersReducedMotion } from "../../lib/motion";
import { ApiError } from "../../api/client";
import type { DocumentContext } from "./useDocumentContext";

const DOC_TYPES: DocType[] = ["id_card", "application_form", "bank_statement", "other", "UNKNOWN", "AMBIGUOUS"];

function isRegion(value: unknown): value is Region {
  return typeof value === "object" && value !== null && "docId" in value && "page" in value && "bbox" in value
    && Array.isArray((value as Region).bbox) && (value as Region).bbox.length === 4;
}

export function EvidenceTab({ context, docId }: { context: DocumentContext; docId: string }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const viewerRef = useRef<DocumentViewerHandle>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<Region | undefined>(() => {
    const candidate = location.state && typeof location.state === "object" && "region" in location.state ? (location.state as { region: unknown }).region : undefined;
    return isRegion(candidate) && candidate.docId === docId ? candidate : undefined;
  });
  const detail = context.detail.data;
  const record = context.record;
  if (!detail || !record) return null;
  const analysis = mockMode ? fixtureAnalysis[docId] : undefined;
  const findingParam = params.get("finding");

  function focus(region: Region) {
    setFocused(region);
    viewerRef.current?.focusRegion(region);
    if (typeof frameRef.current?.scrollIntoView === "function") frameRef.current.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
  }
  const regionsOnPage = context.docFindings.flatMap((item) => item.finding.evidence.flatMap((evidence) => evidence.regions.filter((region) => region.docId === docId).map((region) => ({ item, region }))));

  return (
    <div className="tab-stack">
      <section className="panel evidence-panel" aria-label="Page viewer" ref={frameRef}>
        <div className="section-line"><p className="label">Page viewer</p><span className="muted-text">Toggle field, signal and finding layers in the viewer. Boxes use the canonical page render.</span></div>
        {analysis || !mockMode ? (
          <DocumentViewer ref={viewerRef} docId={docId} title={record.filename} fields={analysis?.fields ?? detail.fields} signals={analysis?.signals ?? []} findings={context.docFindings.map((item) => item.finding)} initialRegion={focused} pageCount={record.pageCount} />
        ) : <p className="muted-text">No page render was generated for this fixture-mode upload.</p>}
        {regionsOnPage.length > 0 && (
          <div className="evidence-jump-list" aria-label="Findings on this page">
            {regionsOnPage.map(({ item, region }, index) => (
              <button type="button" key={`${item.finding.findingId}-${index}`} className={`evidence-jump ${findingParam === item.finding.findingId ? "evidence-jump-current" : ""}`} onClick={() => focus(region)} aria-label={`Show on page: ${humanize(item.finding.type)}, ${region.label ?? "evidence region"}`}>
                <span className="evidence-jump-marker">{index + 1}</span>
                <span><strong>{humanize(item.finding.type)}</strong><small>{region.label ?? "Evidence region"} · page {region.page}</small></span>
              </button>
            ))}
          </div>
        )}
      </section>
      <PagesCard docId={docId} pages={detail.pages} />
      {detail.fields.length > 0 ? (
        <section className="panel" aria-label="Extracted fields">
          <div className="section-line"><p className="label">Extracted fields</p><span className="muted-text">OCR output is a claim, not ground truth. Confidence is OCR readability.</span></div>
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th scope="col">Field</th><th scope="col">Claimed value</th><th scope="col">Page</th><th scope="col">Confidence</th></tr></thead>
            <tbody>{detail.fields.map((field) => (
              <tr key={field.fieldId}>
                <td>{humanize(field.name)}</td>
                <td className="mono-value">{field.rawValue ?? "—"}</td>
                <td>{field.region.page}</td>
                <td><Confidence value={field.ocrConfidence} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      ) : <EmptyState title="No extracted fields" detail="No fields were extracted from this document, which does not mean it has none." />}
    </div>
  );
}

function PagesCard({ docId, pages }: { docId: string; pages: Array<{ page: number; docType: DocType; docTypeConfidence: number; docTypeOverriddenBy?: string }> }) {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<Record<number, DocType>>({});
  const [rerunId, setRerunId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: ({ page, docType }: { page: number; docType: DocType }) => api.reclassify(docId, page, { docType }),
    onSuccess: (job) => { setRerunId(job.jobId); setError(""); queryClient.setQueryData(["job", job.jobId], job); },
    onError: (failure) => setError(failure instanceof ApiError && failure.status === 409 ? "This page is being re-analysed already. Wait for the re-run to finish." : failure instanceof Error ? failure.message : "The reclassification was not saved."),
  });
  const rerun = useQuery({
    queryKey: ["job", rerunId],
    queryFn: () => api.getJob(rerunId!),
    enabled: Boolean(rerunId),
    refetchInterval: (query) => isTerminal(query.state.data?.status) ? false : pollDelay(jobPollIntervalMs, query.state.dataUpdateCount),
  });
  const done = isTerminal(rerun.data?.status);
  const refreshed = useRef(false);
  if (done && !refreshed.current) {
    refreshed.current = true;
    void Promise.all(["document", "case", "case-summaries", "findings"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  }
  return (
    <section className="panel" aria-label="Pages and document type">
      <div className="section-line"><p className="label">Pages and document type</p><span className="muted-text">A correction is logged and triggers a re-run.</span></div>
      {pages.length === 0 ? <p className="muted-text">No page records for this document.</p> : (
        <ul className="page-strip">
          {pages.map((page) => {
            const selected = choice[page.page] ?? page.docType;
            return (
              <li key={page.page} className="page-card">
                <div><strong>Page {page.page}</strong><span className="mono-value"> {DOC_TYPE_LABEL[page.docType] ?? page.docType} · {Math.round(page.docTypeConfidence * 100)}%</span>{page.docTypeOverriddenBy && <StatusBadge status="OBSERVED" />}{page.docTypeOverriddenBy && <small className="muted-text"> corrected by {page.docTypeOverriddenBy}</small>}</div>
                <div className="page-card-actions">
                  <select aria-label={`Document type for page ${page.page}`} value={selected} onChange={(event) => setChoice((current) => ({ ...current, [page.page]: event.target.value as DocType }))}>{DOC_TYPES.map((type) => <option key={type} value={type}>{DOC_TYPE_LABEL[type] ?? type}</option>)}</select>
                  <Button variant="secondary" disabled={mutation.isPending || selected === page.docType} onClick={() => { refreshed.current = false; mutation.mutate({ page: page.page, docType: selected }); }}>Reclassify</Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {rerun.data && (
        <div className="rerun-card" role="status" aria-label="Re-run job">
          <div className="section-line"><strong>Re-run {rerun.data.jobId}</strong><StatusBadge status={rerun.data.status} /></div>
          <AnalyzerChecklist analyzers={rerun.data.analyzers} />
        </div>
      )}
    </section>
  );
}
