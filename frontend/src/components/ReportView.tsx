import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FindingWithReview } from "../../../contracts/api";
import { api } from "../api/client";
import { Chip, SkeletonPanel } from "./Primitives";
import { Gauge, bandTone } from "./Ring";
import { Timeline } from "./Timeline";
import { Button, EmptyState, ErrorState, Icon, StatusBadge } from "./ui";
import { mockMode } from "../config";
import { ANALYZER_IDS, bandLabel, humanize, observationLabel, pct, severityRank } from "../lib/format";
import { createTextPdf, downloadBlob } from "../utils/exportPdf";

function FindingRows({ items }: { items: FindingWithReview[] }) {
  if (items.length === 0) return <p className="muted-text">None recorded.</p>;
  return <ul className="status-list">{items.map(({ finding, reviewStatus }) => <li key={finding.findingId}><span><strong>{humanize(finding.type)}</strong> <span className="mono-value">{finding.findingId}</span></span><span className="muted-text">{humanize(finding.severity)} · {pct(finding.confidence)} · {humanize(reviewStatus)}</span></li>)}</ul>;
}

/** Case report: executive summary through to the event timeline. Used in the document workspace and at /cases/:caseId/report. */
export function ReportView({ caseId }: { caseId: string }) {
  const [copied, setCopied] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);
  const dossier = useQuery({ queryKey: ["dossier", caseId], queryFn: () => api.dossier(caseId) });
  const events = useQuery({ queryKey: ["events", caseId], queryFn: () => api.events(caseId) });
  const integrity = useQuery({ queryKey: ["integrity", caseId], queryFn: () => api.integrity(caseId), retry: false });

  const limitations = useMemo(() => {
    if (!dossier.data) return [];
    const failures = Object.entries(dossier.data.analyzerStatuses).flatMap(([docId, analyzers]) => Object.entries(analyzers)
      .filter(([, status]) => status === "UNAVAILABLE" || status === "ERROR")
      .map(([name, status]) => `${docId}: ${name} is ${status.toLowerCase()}, so it contributed nothing to this report.`));
    return Array.from(new Set([...failures, ...dossier.data.limitations, ...(mockMode ? ["Fixture mode: outputs are recorded and synthetic, not live processing."] : [])]));
  }, [dossier.data]);

  if (dossier.isLoading || events.isLoading) return <SkeletonPanel rows={8} label="Preparing report" />;
  if (dossier.isError) return <ErrorState error={dossier.error} retry={() => void dossier.refetch()} />;
  if (!dossier.data) return <EmptyState title="No report available" detail="This case has no recorded dossier data." />;
  const report = dossier.data;
  const { summary } = report;
  const priority = summary.priority;
  const observed = report.findings.filter(({ finding }) => finding.observationStatus === "OBSERVED" || finding.observationStatus === "INCONSISTENT");
  const potential = report.findings.filter(({ finding }) => finding.observationStatus === "POTENTIAL_ANOMALY");
  const inconclusive = report.findings.filter(({ finding }) => finding.observationStatus === "INCONCLUSIVE");
  const topSeverity = [...report.findings].sort((a, b) => severityRank(b.finding.severity) - severityRank(a.finding.severity))[0]?.finding.severity;
  const reviewCounts = (["UNREVIEWED", "CONFIRMED", "DISMISSED", "INCONCLUSIVE"] as const).map((status) => [status, report.findings.filter((item) => item.reviewStatus === status).length] as const);
  const failedIntegrity = integrity.data?.documents.filter((item) => item.status === "FAIL") ?? [];
  const timeline = [...(events.data?.events ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  async function share() {
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); }
  }
  async function exportPdf() {
    setExporting(true);
    setExportError("");
    try {
      const served = mockMode ? null : await api.dossierPdf(caseId);
      if (served) { downloadBlob(served, `${caseId}-dossier.pdf`); return; }
      const lines = [
        `Case: ${summary.case.title} (${caseId})`,
        `Priority: ${priority ? bandLabel[priority.priorityBand] : "not available"} · confidence ${priority ? pct(priority.confidence) : "n/a"} · coverage ${priority ? pct(priority.coverage) : "n/a"}`,
        `Observed: ${observed.length} · Potential anomalies (need verification): ${potential.length} · Inconclusive: ${inconclusive.length}`, "",
        "Findings", ...report.findings.map(({ finding, reviewStatus }) => `${finding.findingId} ${humanize(finding.type)} · ${observationLabel(finding.observationStatus)} · ${finding.severity} · review ${reviewStatus}`), "",
        "Limitations", ...limitations, "",
        "Priority is an ordering aid for human review. Findings are observations, not conclusions.",
      ];
      downloadBlob(createTextPdf("TraceDocs investigation dossier", lines), `${caseId}-dossier.pdf`);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "The export failed.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="tab-stack report-view">
      <section className="panel report-head" aria-label="Executive summary">
        <div className="section-line"><div><p className="label">Executive summary</p><h2>{summary.case.title}</h2><span className="mono-value">{caseId} · generated {new Date(report.generatedAt).toLocaleString()}</span></div>
          <div className="report-actions">
            <Button variant="secondary" onClick={() => void share()}><Icon name="copy" size={15} /> {copied ? "Link copied" : "Share"}</Button>
            <Button variant="secondary" onClick={() => window.print()}>Print</Button>
            <Button onClick={() => void exportPdf()} disabled={exporting}><Icon name="download" size={15} /> {exporting ? "Exporting…" : "EXPORT PDF"}</Button>
          </div>
        </div>
        {exportError && <p className="form-error" role="alert">{exportError}</p>}
        {report.composedFromLiveRoutes && <p className="muted-text">The dossier route was not available, so this report was composed from the read routes that exist.</p>}
        <div className="report-summary-grid">
          <Gauge score={priority?.score ?? null} band={priority?.priorityBand} size="md" caption="Case-wide priority" />
          <dl className="readings" aria-label="Three separate readings">
            <div><dt className="label">Confidence</dt><dd className="big-number">{priority ? pct(priority.confidence) : "—"}</dd></div>
            <div><dt className="label">Severity of top finding</dt><dd className="big-number reading-text">{topSeverity ? humanize(topSeverity) : "None observed"}</dd></div>
            <div><dt className="label">Coverage</dt><dd className="big-number">{priority ? pct(priority.coverage) : "—"}</dd></div>
          </dl>
        </div>
        <p className="summary-text">{report.findings.length} recorded {report.findings.length === 1 ? "finding" : "findings"} across {summary.documents.length} {summary.documents.length === 1 ? "document" : "documents"}: {observed.length} observed, {potential.length} potential {potential.length === 1 ? "anomaly" : "anomalies"} needing verification, {inconclusive.length} inconclusive. Priority orders the review queue. It is not a conclusion about any document.</p>
        {priority && <Chip tone={bandTone(priority.priorityBand)}>{bandLabel[priority.priorityBand]} priority</Chip>}
      </section>

      <section className="panel" aria-label="Technical analysis">
        <p className="label">Technical analysis</p>
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th scope="col">Document</th>{ANALYZER_IDS.map((id) => <th key={id} scope="col" className="mono">{id}</th>)}</tr></thead>
          <tbody>{Object.entries(report.analyzerStatuses).map(([docId, statuses]) => (
            <tr key={docId}><th scope="row" className="mono-value">{docId}</th>{ANALYZER_IDS.map((id) => <td key={id}>{statuses[id] ? <StatusBadge status={statuses[id]} /> : "—"}</td>)}</tr>
          ))}</tbody>
        </table></div>
      </section>

      <section className="panel" aria-label="Observed versus potential">
        <p className="label">Observed versus potential</p>
        <div className="split-columns">
          <div><h3>Observed</h3><FindingRows items={observed} /></div>
          <div><h3>Potential anomaly (needs verification)</h3><FindingRows items={potential} /></div>
          <div><h3>Inconclusive</h3><FindingRows items={inconclusive} /></div>
        </div>
      </section>

      <section className="panel" aria-label="Limitations and analyzer failures">
        <div className="section-line"><p className="label">Limitations and analyzer failures</p><span className="scope-tag">{limitations.length}</span></div>
        {limitations.length === 0 ? <p className="muted-text">No limitations were recorded. This does not mean none exist.</p> : <ul className="limitation-list">{limitations.map((item) => <li key={item}>{item}</li>)}</ul>}
      </section>

      <section className="panel" aria-label="Review outcomes and history">
        <p className="label">Review outcomes and history</p>
        <div className="chip-row">{reviewCounts.map(([status, count]) => <Chip key={status} tone="grey">{humanize(status)}: {count}</Chip>)}</div>
        <Timeline events={report.reviewHistory} empty="No review activity recorded yet." />
      </section>

      <section className="panel" aria-label="Integrity">
        <div className="section-line"><p className="label">Integrity</p><Button variant="secondary" onClick={() => void integrity.refetch()} disabled={integrity.isFetching}>{integrity.isFetching ? "Checking…" : "Run integrity check"}</Button></div>
        {failedIntegrity.length > 0 && <div className="integrity-fail integrity-fail-large" role="alert"><strong>Integrity check FAILED</strong><p>{failedIntegrity.length} of {integrity.data?.documents.length} stored files no longer match the hash recorded at upload: {failedIntegrity.map((item) => item.docId).join(", ")}. Do not rely on analysis of those files until this is resolved.</p></div>}
        {integrity.isError ? <p className="muted-text">The integrity check is unavailable on this backend, so file hashes have not been re-verified.</p> : integrity.data ? (
          <ul className="status-list">{integrity.data.documents.map((item) => <li key={item.docId}><span className="mono-value">{item.docId}</span><Chip tone={item.status === "PASS" ? "green" : "red"}>{item.status}</Chip></li>)}</ul>
        ) : <p className="muted-text">Checking stored files…</p>}
        {mockMode && <p className="muted-text">Fixture mode: this result is recorded, not computed from a stored file.</p>}
      </section>

      <section className="panel" aria-label="Event timeline">
        <p className="label">Event timeline</p>
        <Timeline events={timeline} empty="No events recorded." />
      </section>
    </div>
  );
}
