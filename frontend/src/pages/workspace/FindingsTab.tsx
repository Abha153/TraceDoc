import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { EvidenceViewer } from "../../components/EvidenceViewer";
import { FindingCard } from "../../components/FindingCard";
import { Skeleton } from "../../components/Primitives";
import { ReviewPanel } from "../../components/ReviewPanel";
import { Confidence, EmptyState, ErrorState, Icon, StatusBadge } from "../../components/ui";
import { analyzerCoverage, humanize, observationLabel, severityRank } from "../../lib/format";
import { prefersReducedMotion } from "../../lib/motion";
import type { DocumentContext } from "./useDocumentContext";

const OBSERVATION = ["OBSERVED", "INCONSISTENT", "POTENTIAL_ANOMALY", "INCONCLUSIVE"] as const;
const REVIEW = ["UNREVIEWED", "CONFIRMED", "DISMISSED", "INCONCLUSIVE"] as const;

/** Findings for one document: filterable list on the left, the selected finding's evidence and review on the right. */
export function FindingsTab({ context, docId }: { context: DocumentContext; docId: string }) {
  const [params, setParams] = useSearchParams();
  const category = params.get("category") ?? "all";
  const observation = params.get("observation") ?? "all";
  const review = params.get("review") ?? "all";
  const selectedParam = params.get("finding");
  const detailRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => [...context.docFindings].sort((a, b) => severityRank(b.finding.severity) - severityRank(a.finding.severity) || b.finding.confidence - a.finding.confidence), [context.docFindings]);
  const categories = Array.from(new Set(all.map((item) => item.finding.category)));
  const visible = all.filter(({ finding, reviewStatus }) =>
    (category === "all" || finding.category === category) && (observation === "all" || finding.observationStatus === observation) && (review === "all" || reviewStatus === review));
  const selectedId = visible.some((item) => item.finding.findingId === selectedParam) ? selectedParam! : visible[0]?.finding.findingId ?? "";

  function setParam(key: string, value: string | null) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (!value || value === "all") next.delete(key); else next.set(key, value);
      return next;
    }, { replace: true });
  }
  function select(findingId: string) {
    setParam("finding", findingId);
    window.setTimeout(() => {
      if (typeof detailRef.current?.scrollIntoView === "function") detailRef.current.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    }, 0);
  }

  if (context.findings.isLoading) return <div aria-busy="true"><Skeleton height={80} /></div>;
  if (context.findings.isError) return <ErrorState error={context.findings.error} retry={() => void context.findings.refetch()} />;
  if (all.length === 0) {
    const coverage = context.record ? analyzerCoverage(context.record.processing) : { ran: 0, possible: 0 };
    return <EmptyState title="No findings for this document" detail={coverage.ran > 0 ? `No anomalies observed by the analyzers that ran (${coverage.ran} of ${coverage.possible} possible).` : "No analyzer ran, so this is not a clean result."} action={<Link className="button button-secondary" to={`/documents/${encodeURIComponent(docId)}/overview`}>Back to overview</Link>} />;
  }
  return (
    <div className="findings-layout">
      <section className="panel findings-list" aria-label="Findings for this document">
        <div className="finding-filters" role="group" aria-label="Filter findings">
          <label><span className="label">Category</span><select aria-label="Category" value={category} onChange={(event) => setParam("category", event.target.value)}><option value="all">All</option>{categories.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></label>
          <label><span className="label">Observation</span><select aria-label="Observation status" value={observation} onChange={(event) => setParam("observation", event.target.value)}><option value="all">All</option>{OBSERVATION.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></label>
          <label><span className="label">Review</span><select aria-label="Review status" value={review} onChange={(event) => setParam("review", event.target.value)}><option value="all">All</option>{REVIEW.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></label>
        </div>
        <p className="result-count" role="status">{visible.length} of {all.length} findings</p>
        {visible.length === 0 ? <EmptyState title="No findings match" detail="Change or clear the filters." action={<button type="button" className="button button-secondary" onClick={() => setParams({}, { replace: true })}>Reset filters</button>} /> : (
          <div className="finding-card-list">{visible.map((item) => <FindingCard key={item.finding.findingId} item={item} selected={item.finding.findingId === selectedId} onSelect={() => select(item.finding.findingId)} />)}</div>
        )}
      </section>
      <div className="findings-detail" ref={detailRef}>{selectedId ? <FindingDetailPanel findingId={selectedId} docId={docId} /> : null}</div>
    </div>
  );
}

function FindingDetailPanel({ findingId, docId }: { findingId: string; docId: string }) {
  const query = useQuery({ queryKey: ["finding", findingId], queryFn: () => api.finding(findingId) });
  const record = query.data;
  useEffect(() => { /* keep the panel keyed on the finding so review text never leaks between findings */ }, [findingId]);
  if (query.isLoading) return <div className="panel" aria-busy="true" style={{ padding: 18 }}><Skeleton width="40%" height={16} /><div style={{ height: 12 }} /><Skeleton height={140} /></div>;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  if (!record) return <EmptyState title="Finding not available" detail="This finding does not exist or belongs to an older reasoning run." />;
  const { finding } = record;
  const firstRegion = finding.evidence.flatMap((evidence) => evidence.regions).find((region) => region.docId === docId);
  const otherDocs = Array.from(new Set(finding.evidence.flatMap((evidence) => evidence.regions.map((region) => region.docId)))).filter((id) => id !== docId);
  return (
    <div className="detail-stack" key={findingId}>
      <section className="panel finding-head" aria-label="Finding detail">
        <p className="label">{finding.findingId} · {humanize(finding.category)}</p>
        <h2>{humanize(finding.type)}</h2>
        {finding.explanation?.summary && <p className="muted-text">{finding.explanation.summary}</p>}
        <div className="detail-state-row">
          <div><small>Machine observation</small><StatusBadge status={finding.observationStatus} /><span className="obs-label">{observationLabel(finding.observationStatus)}</span></div>
          <div><small>Analyst review</small><StatusBadge status={record.reviewStatus} /></div>
          <div><small>Severity</small><StatusBadge status={finding.severity} /></div>
          <div><small>Confidence</small><Confidence value={finding.confidence} /></div>
        </div>
        <div className="finding-actions">
          {firstRegion && <Link className="button button-secondary" to={`/documents/${encodeURIComponent(docId)}/evidence?finding=${encodeURIComponent(findingId)}`} state={{ region: firstRegion }}><Icon name="search" size={15} /> Show on page</Link>}
          {otherDocs.length > 0 && <span className="muted-text">Also references {otherDocs.join(", ")} (case-wide)</span>}
        </div>
      </section>
      <section className="panel" aria-label="Evidence"><div className="section-line"><p className="label">Evidence</p><span className="scope-tag">Observed vs potential</span></div><EvidenceViewer evidence={finding.evidence} docId={docId} /></section>
      <section className="panel" aria-label="Explanation">
        <p className="label">What was observed</p>
        {finding.explanation ? (
          <div className="explanation-columns">
            <div><h3>Observations</h3><ul>{finding.explanation.observations.map((item) => <li key={item}>{item}</li>)}</ul></div>
            <div><h3>Possible explanations</h3><ul>{finding.explanation.possibleExplanations.map((item) => <li key={item}>{item}</li>)}</ul></div>
            <div><h3>Recommended review</h3><ul>{finding.explanation.recommendedReview.map((item) => <li key={item}>{item}</li>)}</ul></div>
          </div>
        ) : <p className="muted-text">No structured explanation is recorded for this finding.</p>}
        {finding.needsVerification.length > 0 && <div className="verification-note"><strong>Needs verification</strong><ul>{finding.needsVerification.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      </section>
      <ReviewPanel detail={record} />
    </div>
  );
}
