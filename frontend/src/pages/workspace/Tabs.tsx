import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { FindingWithReview } from "../../../../contracts/api";
import { api } from "../../api/client";
import { Chip, Skeleton } from "../../components/Primitives";
import { Gauge, bandTone } from "../../components/Ring";
import { Icon, StatusBadge } from "../../components/ui";
import { mockMode } from "../../config";
import { ANALYZER_IDS, analyzerCoverage, bandLabel, humanize, observationLabel, pct, relativeTime, severityRank } from "../../lib/format";
import type { DocumentContext } from "./useDocumentContext";

function rankFindings(findings: FindingWithReview[]): FindingWithReview[] {
  return [...findings].sort((a, b) => severityRank(b.finding.severity) - severityRank(a.finding.severity) || b.finding.confidence - a.finding.confidence);
}

function WhyFlagged({ findings, emptyText }: { findings: FindingWithReview[]; emptyText: string }) {
  if (findings.length === 0) return <p className="muted-text">{emptyText}</p>;
  return (
    <ol className="why-list why-list-large">
      {findings.map((item, index) => (
        <li key={item.finding.findingId}>
          <span className="why-index">{String(index + 1).padStart(2, "0")}</span>
          <span className="why-body">
            <Link to={`/findings/${encodeURIComponent(item.finding.findingId)}`}><strong>{humanize(item.finding.type)}</strong></Link>
            <small>{observationLabel(item.finding.observationStatus)} · {humanize(item.finding.severity)} severity · {pct(item.finding.confidence)} confidence</small>
          </span>
          <Chip tone={item.reviewStatus === "UNREVIEWED" ? "amber" : "grey"}>{humanize(item.reviewStatus)}</Chip>
        </li>
      ))}
    </ol>
  );
}

function CoverageCard({ processing }: { processing: Record<string, import("../../../../contracts/types").AnalyzerStatus> }) {
  const coverage = analyzerCoverage(processing);
  const ids = [...ANALYZER_IDS.filter((id) => id in processing), ...Object.keys(processing).filter((id) => !(ANALYZER_IDS as readonly string[]).includes(id))];
  return (
    <section className="panel summary-card" aria-label="Analyzer coverage">
      <p className="label">Analyzer coverage</p>
      <p className="big-number">{coverage.ran} <span className="big-number-unit">of {coverage.possible} possible ran</span></p>
      <ul className="status-list">
        {ids.map((id) => <li key={id}><span className="mono">{id}</span><StatusBadge status={processing[id]} /></li>)}
      </ul>
      {coverage.ran < coverage.possible && <p className="muted-text">Some analyzers did not run, so a quiet result here is not a clean result.</p>}
    </section>
  );
}

/* ---------------------------------- Overview ---------------------------------- */

export function OverviewTab({ context, docId }: { context: DocumentContext; docId: string }) {
  const { record, priority, docFindings, status } = context;
  if (!record) return null;
  const failed = status === "FAILED";
  const ranked = rankFindings(docFindings);
  const coverage = analyzerCoverage(record.processing);
  const failedJob = (context.summary.data?.jobs ?? []).filter((job) => job.docId === docId && job.status === "FAILED").sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const pages = context.detail.data?.pages ?? [];
  const caseLink = `/cases/${encodeURIComponent(record.caseId)}`;
  return (
    <div className="tab-stack">
      {failed && <div className="validation-alert" role="alert"><strong>Analysis failed for this document</strong><p>{failedJob?.error ?? "The analyzers reported an error."} No findings can be shown, and the absence of findings is not a clean result.</p></div>}
      <div className="overview-grid">
        <section className="panel overview-priority" aria-label="Document priority">
          <p className="label">Document priority</p>
          <Gauge score={failed ? null : priority?.score ?? null} band={priority?.priorityBand} size="lg" caption={failed ? "No result: analysis failed." : priority ? "A priority for human review, not a probability." : "Reasoning has not produced a priority for this document yet."} />
          <dl className="readings readings-stack" aria-label="Three separate readings">
            <div><dt className="label">Confidence</dt><dd className="big-number">{priority ? pct(priority.confidence) : "—"}</dd></div>
            <div><dt className="label">Severity of top finding</dt><dd className="big-number reading-text">{ranked[0] ? humanize(ranked[0].finding.severity) : "None observed"}</dd></div>
            <div><dt className="label">Coverage</dt><dd className="big-number">{coverage.ran} / {coverage.possible}</dd></div>
          </dl>
        </section>
        <section className="panel" aria-label="Why flagged">
          <div className="section-line"><p className="label">Why flagged</p><span className="scope-tag">This document</span></div>
          <WhyFlagged findings={ranked.slice(0, 5)} emptyText={failed ? "No findings: analysis failed." : coverage.ran > 0 ? "No anomalies observed by the analyzers that ran." : "No analyzer ran, so this is not a clean result."} />
        </section>
      </div>
      <div className="summary-grid">
        <CoverageCard processing={record.processing} />
        <section className="panel summary-card" aria-label="Document details">
          <p className="label">Document</p>
          <dl className="facts">
            <div><dt>Pages</dt><dd>{record.pageCount}</dd></div>
            <div><dt>Page types</dt><dd>{pages.length ? pages.map((page) => `${page.page}: ${humanize(page.docType)}`).join(", ") : "—"}</dd></div>
            <div><dt>File type</dt><dd className="mono-value">{record.mimeType}</dd></div>
            <div><dt>Received</dt><dd>{relativeTime(record.receivedAt)}</dd></div>
            <div><dt>Pipeline</dt><dd className="mono-value">{record.pipelineVersion}</dd></div>
          </dl>
        </section>
        <section className="panel summary-card" aria-label="Case-wide">
          <div className="section-line"><p className="label">Case</p><span className="scope-tag">Case-wide</span></div>
          <p><Link to={caseLink}><strong>{context.summary.data?.case.title ?? record.caseId}</strong></Link></p>
          <div className="preview-row">
            {context.summary.data?.priority ? <Chip tone={bandTone(context.summary.data.priority.priorityBand)}>{bandLabel[context.summary.data.priority.priorityBand]} priority</Chip> : <Chip tone="grey">Priority pending</Chip>}
            <span className="muted-text">{context.summary.data?.documents.length ?? "…"} documents · {context.caseFindings.length} findings</span>
          </div>
          <p className="muted-text">The case priority combines every document. Cross-document findings and entities stay case-wide.</p>
        </section>
      </div>
      <p className="label">Continue investigation</p>
      <div className="continue-grid">
        {([
          ["investigation", "Investigation", "Why the case is flagged, entities and integrity"],
          ["findings", `Findings (${docFindings.length})`, "Observations and analyst review"],
          ["evidence", "Evidence", "Page image with regions and fields"],
          ["report", "Report", "Dossier, history and export"],
        ] as const).map(([tab, title, hint]) => (
          <Link key={tab} className="continue-card" to={`/documents/${encodeURIComponent(docId)}/${tab}`}>
            <strong>{title}</strong><small>{hint}</small><Icon name="arrow" size={15} />
          </Link>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------- Investigation -------------------------------- */

export function InvestigationTab({ context, docId }: { context: DocumentContext; docId: string }) {
  const { record, summary, caseId } = context;
  const assertions = useQuery({ queryKey: ["assertions", caseId], queryFn: () => api.assertions(caseId), enabled: Boolean(caseId) });
  const integrity = useQuery({ queryKey: ["integrity", caseId], queryFn: () => api.integrity(caseId), enabled: Boolean(caseId), retry: false });
  const related = useQuery({ queryKey: ["related", caseId], queryFn: () => api.related(caseId), enabled: Boolean(caseId), retry: false });
  if (!record) return null;
  const casePriority = summary.data?.priority ?? null;
  const contributing = casePriority
    ? context.caseFindings.filter((item) => casePriority.contributingFindingIds.includes(item.finding.findingId))
    : [];
  const why = rankFindings(contributing.length ? contributing : context.caseFindings).slice(0, 6);
  const entities = context.entities.data?.entities ?? [];
  const docIntegrity = integrity.data?.documents.find((item) => item.docId === docId);
  const docCount = summary.data?.documents.length ?? 0;
  const ranTotal = (summary.data?.documents ?? []).reduce((sum, doc) => sum + analyzerCoverage(doc.processing).ran, 0);
  const possibleTotal = (summary.data?.documents ?? []).reduce((sum, doc) => sum + analyzerCoverage(doc.processing).possible, 0);
  return (
    <div className="tab-stack">
      <div className="case-bar">
        <div><p className="label">Case-wide investigation</p><h2>{summary.data?.case.title ?? record.caseId}</h2><span className="mono-value">{record.caseId}</span></div>
        {casePriority ? <Chip tone={bandTone(casePriority.priorityBand)}>{bandLabel[casePriority.priorityBand]} priority</Chip> : <Chip tone="grey">Priority pending</Chip>}
      </div>
      <div className="overview-grid">
        <section className="panel overview-priority" aria-label="Case priority">
          <div className="section-line"><p className="label">Case priority</p><span className="scope-tag">Case-wide</span></div>
          <Gauge score={casePriority?.score ?? null} band={casePriority?.priorityBand} size="lg" caption="Combines every document in the case. A priority, not a probability." />
        </section>
        <section className="panel" aria-label="Investigation summary">
          <p className="label">Investigation summary</p>
          <p className="summary-text">
            {context.caseFindings.length} {context.caseFindings.length === 1 ? "observation" : "observations"} across {docCount} {docCount === 1 ? "document" : "documents"}.
            {" "}{ranTotal} of {possibleTotal} possible analyzer runs completed
            {casePriority ? `, with ${pct(casePriority.confidence)} confidence in the strongest evidence` : ""}.
            {" "}Each item is an observation or potential anomaly for a person to verify.
          </p>
          <p className="label why-label">Why flagged</p>
          <WhyFlagged findings={why} emptyText="No findings have been recorded for this case." />
        </section>
      </div>
      <div className="summary-grid">
        <CoverageCard processing={record.processing} />
        <section className="panel summary-card" aria-label="Entities and assertions">
          <div className="section-line"><p className="label">Entities and assertions</p><span className="scope-tag">Case-wide</span></div>
          {context.entities.isLoading || assertions.isLoading ? <Skeleton width="60%" height={26} /> : (
            <>
              <p className="big-number">{entities.length} <span className="big-number-unit">entities · {assertions.data?.assertions.length ?? "—"} assertions</span></p>
              <ul className="status-list">
                {(["RESOLVED", "SUGGESTED", "UNRESOLVED"] as const).map((resolution) => <li key={resolution}><span>{humanize(resolution)}</span><span className="mono-value">{entities.filter((entity) => entity.resolution === resolution).length}</span></li>)}
              </ul>
              <p className="muted-text">OCR output is a claim, not ground truth. A suggested link never merges entities.</p>
              <Link className="button button-secondary" to={`/documents/${encodeURIComponent(docId)}/entities`}>Entities &amp; Graph</Link>
            </>
          )}
        </section>
        <section className="panel summary-card" aria-label="Integrity and related cases">
          <div className="section-line"><p className="label">Integrity and related cases</p><span className="scope-tag">Case-wide</span></div>
          {integrity.isLoading ? <Skeleton width="50%" height={22} /> : integrity.isError ? <p className="muted-text">Integrity check unavailable on this backend. File hashes have not been re-verified.</p> : docIntegrity ? (
            docIntegrity.status === "FAIL" ? (
              <div className="integrity-fail" role="alert"><strong>Integrity check FAILED</strong><p>The stored file does not match the hash recorded at upload for this document.</p></div>
            ) : (
              <p><Chip tone="green">Integrity PASS</Chip> <span className="muted-text">stored file matches the recorded SHA-256</span></p>
            )
          ) : <p className="muted-text">This document is not in the integrity report.</p>}
          {mockMode && <p className="muted-text">Fixture mode: this integrity result is recorded, not computed from a stored file.</p>}
          <p className="label">Related cases</p>
          {related.isLoading ? <Skeleton width="70%" /> : related.isError ? <p className="muted-text">Related cases are unavailable on this backend.</p> : related.data && related.data.related.length > 0 ? (
            <ul className="status-list">{related.data.related.map((item) => <li key={item.caseId}><Link to={`/cases/${encodeURIComponent(item.caseId)}`}>{item.caseId} · {item.title}</Link><span className="mono-value">{item.shared.length} shared</span></li>)}</ul>
          ) : <p className="muted-text">None found. {related.data?.basis}</p>}
        </section>
      </div>
    </div>
  );
}
