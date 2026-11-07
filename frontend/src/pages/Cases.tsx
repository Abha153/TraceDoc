import { useRecordLastViewed } from "../lib/lastViewed";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { CaseSummary, RelatedCasesResponse } from "../../../contracts/api";
import { api } from "../api/client";
import { mockMode as MOCK_MODE } from "../config";
import { Breadcrumbs, Button, EmptyState, ErrorState, Icon, LoadingState, PageHeader, StatusBadge } from "../components/ui";

export type CaseSortKey = "default" | "priority" | "title" | "documents" | "newest";
const PRIORITY_RANK = { low: 1, moderate: 2, high: 3, critical: 4 } as const;

export function sortCases(items: CaseSummary[], key: CaseSortKey, descending: boolean): CaseSummary[] {
  if (key === "default") return items;
  const value = (c: CaseSummary): number | string => {
    if (key === "priority") return c.priority ? PRIORITY_RANK[c.priority.priorityBand] : 0; // no priority yet sorts as lowest
    if (key === "title") return c.case.title.toLowerCase();
    if (key === "documents") return c.documents.length;
    return Date.parse(c.case.createdAt);
  };
  const out = [...items].sort((a, b) => {
    const x = value(a), y = value(b);
    const cmp = typeof x === "string" ? x.localeCompare(String(y)) : Number(x) - Number(y);
    return cmp || a.case.caseId.localeCompare(b.case.caseId);
  });
  return descending ? out.reverse() : out;
}

export function CasesPage({ mockMode }: { mockMode: boolean }) {
  const [query, setQuery] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [formError, setFormError] = useState("");
  const [sortKey, setSortKey] = useState<CaseSortKey>("default");
  const [descending, setDescending] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const casesQuery = useQuery({ queryKey: ["cases"], queryFn: api.listCases });
  const summariesQuery = useQuery({
    queryKey: ["case-summaries"],
    queryFn: api.listCaseSummaries,
    enabled: casesQuery.isSuccess,
  });
  const createMutation = useMutation({
    mutationFn: () => api.createCase({ title: newTitle.trim() }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["cases"] });
      await queryClient.invalidateQueries({ queryKey: ["case-summaries"] });
      setShowCreate(false);
      setNewTitle("");
      setFormError("");
      navigate(`/cases/${created.caseId}`);
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : "Could not create case."),
  });
  const filteredCases = useMemo(() => sortCases((summariesQuery.data ?? []).filter((summary) =>
    `${summary.case.title} ${summary.case.caseId}`.toLowerCase().includes(query.toLowerCase()),
  ), sortKey, descending), [query, summariesQuery.data, sortKey, descending]);

  if (casesQuery.isLoading || summariesQuery.isLoading) return <LoadingState label="Loading case records" />;
  if (casesQuery.isError) return <ErrorState error={casesQuery.error} retry={() => void casesQuery.refetch()} />;
  if (summariesQuery.isError) return <ErrorState error={summariesQuery.error} retry={() => void summariesQuery.refetch()} />;

  return (
    <>
      <Breadcrumbs items={[{ label: "Cases" }]} />
      <PageHeader
        eyebrow="Investigation workspace"
        title="Cases"
        description={mockMode ? "Review recorded evidence and follow the processing trail for each case." : "Review case records and follow the processing trail returned by the configured backend."}
        actions={<Button onClick={() => setShowCreate(true)}><Icon name="plus" size={17} /> New case</Button>}
      />
      <div className="case-overview-strip">
        <div><span className="overview-icon"><Icon name="cases" /></span><span><strong>{summariesQuery.data?.length ?? 0}</strong><small>Cases in workspace</small></span></div>
        <div><span className="overview-icon overview-icon-amber"><Icon name="file" /></span><span><strong>{summariesQuery.data?.reduce((total, item) => total + item.documents.length, 0) ?? 0}</strong><small>Documents recorded</small></span></div>
        <div><span className="overview-icon overview-icon-blue"><Icon name="clock" /></span><span><strong>{mockMode ? "Fixture" : "Backend"}</strong><small>Data mode</small></span></div>
      </div>
      <details className="getting-started" open>
        <summary>Getting started: how to review a case</summary>
        <ol>
          <li><strong>Pick a case</strong> below{mockMode && summariesQuery.data?.[0] ? <> or <Link to={`/cases/${summariesQuery.data[0].case.caseId}`}>open the demo case</Link></> : null}. Its page shows each document and which checks ran on it.</li>
          <li><strong>Read the findings.</strong> Each one says what was observed, why it may have a harmless explanation, and what to verify. They are observations, not conclusions.</li>
          <li><strong>Look at the evidence.</strong> Every finding can open the document at the exact region it refers to.</li>
          <li><strong>Record your decision.</strong> Confirm, dismiss (with a reason) or mark inconclusive. Your review never replaces the machine observation.</li>
        </ol>
        <p className="getting-started-note">{mockMode
          ? "This demo shows recorded results. Uploaded files are accepted but are not analysed, so they produce no new findings."
          : "Until the analysis service is connected, only the recorded sample documents are analysed. Any other file is reported as not analysed, which is never the same as clean."}</p>
      </details>
      <div className="section-toolbar">
        <div className="search-field">
          <Icon name="search" size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search cases" aria-label="Search cases" />
          {query && <button aria-label="Clear search" onClick={() => setQuery("")}><Icon name="close" size={15} /></button>}
        </div>
        <div className="sort-control">
          <label htmlFor="case-sort">Sort by</label>
          <select id="case-sort" value={sortKey} onChange={(event) => setSortKey(event.target.value as CaseSortKey)}>
            <option value="default">Recorded order</option>
            <option value="priority">Investigation priority</option>
            <option value="title">Title</option>
            <option value="documents">Document count</option>
            <option value="newest">Created date</option>
          </select>
          <button type="button" className="icon-button" disabled={sortKey === "default"} onClick={() => setDescending((value) => !value)}
            aria-label={descending ? "Sorted descending. Switch to ascending" : "Sorted ascending. Switch to descending"}>{descending ? "↓" : "↑"}</button>
        </div>
        <span className="result-count" role="status">{filteredCases.length} {filteredCases.length === 1 ? "case" : "cases"}</span>
      </div>
      {filteredCases.length === 0 ? (
        <EmptyState title="No cases match" detail={query ? "Try another case name or ID." : mockMode ? "Create a case to start a local fixture session." : "No cases are available from the configured backend."} />
      ) : (
        <div className="case-grid">
          {filteredCases.map((summary) => <CaseCard key={summary.case.caseId} summary={summary} />)}
        </div>
      )}
      {showCreate && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowCreate(false);
        }}>
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-case-title">
            <div className="modal-heading"><div><p className="eyebrow">New workspace item</p><h2 id="create-case-title">Create a case</h2></div><button className="icon-button" aria-label="Close dialog" onClick={() => setShowCreate(false)}><Icon name="close" /></button></div>
            <p className="muted-copy">{mockMode ? "This creates an empty case in the local fixture mock. It does not create a backend record." : "This creates an empty case using the configured backend."}</p>
            <form onSubmit={(event) => {
              event.preventDefault();
              if (!newTitle.trim()) {
                setFormError("Add a case title.");
                return;
              }
              createMutation.mutate();
            }}>
              <label className="field-label" htmlFor="case-title">Case title</label>
              <input id="case-title" className="text-input" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} maxLength={200} required autoFocus />
              {formError && <p className="form-error" role="alert">{formError}</p>}
              <div className="modal-actions"><Button type="button" variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Button><Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? "Creating…" : "Create case"}</Button></div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}

function CaseCard({ summary }: { summary: CaseSummary }) {
  const { case: item, documents, priority } = summary;
  const latest = new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return (
    <Link to={`/cases/${item.caseId}`} className="case-card">
      <div className="case-card-top">
        <span className="case-mark"><Icon name="file" size={20} /></span>
        <span className="case-id">{item.caseId}</span>
        <Icon name="chevron" size={17} />
      </div>
      <h2>{item.title}</h2>
      <div className="case-card-meta"><span><Icon name="file" size={15} />{documents.length} documents</span><span><Icon name="clock" size={15} />{latest}</span></div>
      <div className="case-card-bottom">
        <div><small>Investigation priority</small>{priority ? <StatusBadge status={priority.priorityBand} /> : <span className="muted-copy">Not yet available</span>}</div>
        <span className="case-open">Open case <Icon name="arrow" size={15} /></span>
      </div>
    </Link>
  );
}

export function CaseDetailPage() {
  const { caseId = "" } = useParams();
  const summaryQuery = useQuery({ queryKey: ["case", caseId], queryFn: () => api.getCase(caseId) });
  const relatedQuery = useQuery({ queryKey: ["related", caseId], queryFn: () => api.related(caseId), enabled: summaryQuery.isSuccess });
  useRecordLastViewed(summaryQuery.data ? { path: `/cases/${summaryQuery.data.case.caseId}`, label: summaryQuery.data.case.title, caseId: summaryQuery.data.case.caseId } : null);
  if (summaryQuery.isLoading) return <LoadingState label="Loading case" />;
  if (summaryQuery.isError) return <ErrorState error={summaryQuery.error} retry={() => void summaryQuery.refetch()} />;
  const summary = summaryQuery.data;
  if (!summary) return <EmptyState title="Case not found" detail={MOCK_MODE ? "This case is not present in the fixture workspace." : "No such case on the backend."} />;

  return (
    <>
      <Breadcrumbs items={[{ label: "Cases", to: "/cases" }, { label: summary.case.caseId }]} />
      <PageHeader
        eyebrow={summary.case.caseId}
        title={summary.case.title}
        description="Documents, processing status, and available evidence for this case."
        actions={<Link className="button button-secondary" to={`/findings?caseId=${encodeURIComponent(summary.case.caseId)}`}>Review findings</Link>}
      />
      <div className="case-detail-summary">
        <Metric label="Documents" value={String(summary.documents.length)} />
        <Metric label="Priority" value={summary.priority?.priorityBand ?? "Pending"} />
        <Metric label="Confidence" value={summary.priority ? `${Math.round(summary.priority.confidence * 100)}%` : "—"} />
        <Metric label="Analyzer coverage" value={summary.priority ? `${Math.round(summary.priority.coverage * 100)}%` : "—"} />
      </div>
      <div className="section-heading"><div><h2>Documents</h2><p>Analyzer availability is shown explicitly per document.</p></div><Link className="text-link" to="/upload">Add documents <Icon name="arrow" size={15} /></Link></div>
      {summary.documents.length ? (
        <div className="document-list">
          {summary.documents.map((document) => {
            const job = summary.jobs.find((entry) => entry.docId === document.docId);
            return (
              <article className="document-row" key={document.docId}>
                <Link to={`/documents/${document.docId}`} className="document-row-main">
                  <span className="document-type-icon"><Icon name="file" /></span>
                  <span><strong>{document.filename}</strong><small>{document.docId} · {document.mimeType} · {document.pageCount} page</small></span>
                </Link>
                <div className="document-row-state">{job && <StatusBadge status={job.status} />}</div>
                <div className="analyzer-list">
                  {Object.entries(document.processing).map(([name, status]) => (
                    <span className="analyzer-chip" key={name}><span>{name}</span><StatusBadge status={status} /></span>
                  ))}
                </div>
                <Link className="icon-button" to={`/documents/${document.docId}`} aria-label={`Open ${document.filename}`}><Icon name="chevron" /></Link>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState title="No documents yet" detail="Upload a supported file to add it to this local demo case." action={<Link className="button button-primary" to="/upload">Upload document</Link>} />
      )}
      <RelatedCases query={relatedQuery} />
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>;
}

function RelatedCases({ query }: { query: ReturnType<typeof useQuery<RelatedCasesResponse>> }) {
  return (
    <section className="panel related-cases" aria-labelledby="related-cases-heading">
      <div className="section-heading"><div><h2 id="related-cases-heading">Related cases</h2><p>Leads to verify, not findings. They do not change the priority.</p></div></div>
      {query.isLoading && <p className="muted-copy">Checking other cases…</p>}
      {query.isError && <p className="muted-copy" role="status">Related cases could not be checked: {query.error instanceof Error ? query.error.message : "unknown error"}.</p>}
      {query.data && query.data.related.length === 0 && <p className="muted-copy">No other case shares an ID number, account number or identical file with this case.</p>}
      {query.data?.related.map((related) => (
        <article className="related-case" key={related.caseId}>
          <p><Link to={`/cases/${related.caseId}`}><strong>{related.caseId}</strong></Link> · {related.title}</p>
          <ul>{related.shared.map((item) => (
            <li key={`${item.kind}-${item.semanticType ?? ""}-${item.value}`}>
              {item.kind === "file_hash" ? "Identical file" : `Same ${item.semanticType === "id_number" ? "ID number" : "account number"}`}
              {" "}<code>{item.kind === "file_hash" ? `${item.value.slice(0, 12)}…` : item.value}</code>
              {" "}· here: {item.thisCase.map((ref) => ref.docId).join(", ")} · there: {item.otherCase.map((ref) => ref.docId).join(", ")}
            </li>
          ))}</ul>
        </article>
      ))}
      {query.data && <p className="muted-copy">{query.data.basis}</p>}
    </section>
  );
}
