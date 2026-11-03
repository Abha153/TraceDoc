import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "react-router-dom";
import type { Region } from "../../../contracts/types";
import { api } from "../api/client";
import { DocumentViewer } from "../components/DocumentViewer";
import { Breadcrumbs, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "../components/ui";
import { mockMode } from "../config";
import { fixtureAnalysis } from "../mockData";

export function DocumentPage() {
  const { docId = "" } = useParams();
  const location = useLocation();
  const documentQuery = useQuery({ queryKey: ["document", docId], queryFn: () => api.getDocument(docId) });
  const document = documentQuery.data;
  const analysis = mockMode ? fixtureAnalysis[docId] : undefined;
  const candidateRegion = location.state && typeof location.state === "object" && "region" in location.state
    ? location.state.region
    : undefined;
  const initialRegion = isRegion(candidateRegion) && candidateRegion.docId === docId ? candidateRegion : undefined;
  if (documentQuery.isLoading) return <LoadingState label="Loading document" />;
  if (documentQuery.isError) return <ErrorState error={documentQuery.error} retry={() => void documentQuery.refetch()} />;
  if (!document) return <EmptyState title="Document unavailable" detail="No document detail is recorded for this ID." />;
  return (
    <>
      <Breadcrumbs items={[{ label: "Cases", to: "/cases" }, { label: document.document.caseId, to: `/cases/${document.document.caseId}` }, { label: document.document.filename }]} />
      <PageHeader eyebrow={`${document.document.docId} · ${document.document.mimeType}`} title={document.document.filename} description={`${document.document.pageCount} page · Pipeline ${document.document.pipelineVersion}`} actions={<Link className="button button-secondary" to={`/cases/${document.document.caseId}`}>Back to case</Link>} />
      <div className="document-processing-strip">{Object.entries(document.document.processing).map(([name, status]) => <div key={name}><span>{name}</span><StatusBadge status={status} /></div>)}</div>
      {analysis || !mockMode ? (
        <DocumentViewer docId={docId} title={document.document.filename} fields={analysis?.fields ?? document.fields} signals={analysis?.signals ?? []} initialRegion={initialRegion} pageCount={document.document.pageCount} />
      ) : (
        <div className="panel document-unavailable-note"><strong>Canonical page preview is unavailable</strong><p>This document was added during a fixture-mode upload. No page image or extracted fields were generated.</p></div>
      )}
      {document.fields.length > 0 && <section className="panel document-fields"><div className="section-heading"><div><h2>Extracted fields</h2><p>Recorded fixture output; confidence reports OCR readability, not truth.</p></div></div><div className="field-table-wrap"><table className="data-table"><thead><tr><th>Field</th><th>Observed value</th><th>OCR confidence</th><th>Extraction confidence</th><th>Source</th></tr></thead><tbody>{document.fields.map((field) => <tr key={field.fieldId}><td>{field.name.replaceAll("_", " ")}</td><td>{field.normalizedValue ?? field.rawValue}</td><td>{Math.round(field.ocrConfidence * 100)}%</td><td>{Math.round(field.extractionConfidence * 100)}%</td><td>{field.source}</td></tr>)}</tbody></table></div></section>}
    </>
  );
}

function isRegion(value: unknown): value is Region {
  if (typeof value !== "object" || value === null || !("docId" in value) || !("page" in value) || !("bbox" in value)) return false;
  return typeof value.docId === "string" &&
    typeof value.page === "number" &&
    Array.isArray(value.bbox) &&
    value.bbox.length === 4 &&
    value.bbox.every((coordinate) => typeof coordinate === "number");
}
