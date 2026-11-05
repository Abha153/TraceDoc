import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { InvestigationEvent } from "../../../contracts/types";
import { api } from "../api/client";
import { Breadcrumbs, Button, EmptyState, ErrorState, Icon, IntegrityBadge, LoadingState, PageHeader, SortButton, StatusBadge } from "../components/ui";
import { mockMode } from "../config";
import { createTextPdf, downloadBlob } from "../utils/exportPdf";

const unsupportedFeatures = mockMode
  ? [
      "No real-time document analysis in this frontend fixture mode.",
      "Multi-page uploads are not rendered unless a canonical fixture page exists.",
      "Image manipulation, font comparison and signature checks are not performed on new uploads.",
    ]
  : [];

export function ReportsPage() {
  const [caseId, setCaseId] = useState("CASE-001");
  const [eventType, setEventType] = useState("all");
  const [eventSort, setEventSort] = useState<{ key: "type" | "targetId" | "actor" | "at"; descending: boolean } | null>(null);
  const [integrity, setIntegrity] = useState<Awaited<ReturnType<typeof api.integrity>> | null>(null);
  const [integrityError, setIntegrityError] = useState("");
  const casesQuery = useQuery({ queryKey: ["cases"], queryFn: api.listCases });
  const cases = casesQuery.data ?? [];
  const activeCaseId = cases.some((item) => item.caseId === caseId) ? caseId : cases[0]?.caseId ?? "";
  const dossierQuery = useQuery({ queryKey: ["dossier", activeCaseId], queryFn: () => api.dossier(activeCaseId), enabled: Boolean(activeCaseId) });
  const eventsQuery = useQuery({ queryKey: ["events", activeCaseId], queryFn: () => api.events(activeCaseId), enabled: Boolean(activeCaseId) });
  const dossier = dossierQuery.data;
  const events = eventsQuery.data?.events ?? [];
  const filteredEvents = useMemo(() => {
    const rows = events.filter((event) => eventType === "all" || event.type === eventType);
    if (!eventSort) return rows;
    const { key, descending } = eventSort;
    const sorted = [...rows].sort((a, b) => key === "at" ? Date.parse(a.at) - Date.parse(b.at) : String(a[key]).localeCompare(String(b[key])) || Date.parse(a.at) - Date.parse(b.at));
    return descending ? sorted.reverse() : sorted;
  }, [events, eventType, eventSort]);
  const toggleEventSort = (key: "type" | "targetId" | "actor" | "at") =>
    setEventSort((current) => current?.key === key ? { key, descending: !current.descending } : { key, descending: false });
  const sortState = (key: string) => eventSort?.key === key ? (eventSort.descending ? "descending" as const : "ascending" as const) : "none" as const;
  const limitations = useMemo(() => {
    if (!dossier) return [];
    const statuses = Object.entries(dossier.analyzerStatuses).flatMap(([docId, analyzers]) =>
      Object.entries(analyzers)
        .filter(([, status]) => status === "UNAVAILABLE" || status === "ERROR")
        .map(([name, status]) => `${docId}: ${name} is ${status.toLowerCase()}.`),
    );
    return Array.from(new Set([...statuses, ...dossier.limitations, ...unsupportedFeatures]));
  }, [dossier]);

  if (casesQuery.isLoading || dossierQuery.isLoading || eventsQuery.isLoading) return <LoadingState label="Preparing report data" />;
  const loadError = casesQuery.error ?? dossierQuery.error ?? eventsQuery.error;
  if (loadError) return <ErrorState error={loadError} retry={() => {
    void casesQuery.refetch();
    void dossierQuery.refetch();
    void eventsQuery.refetch();
  }} />;
  if (!dossier) return <EmptyState title="No report available" detail="This case has no recorded dossier data." />;
  const report = dossier;
  const { summary } = report;

  async function checkIntegrity() {
    setIntegrityError("");
    try {
      setIntegrity(await api.integrity(activeCaseId));
    } catch (error) {
      setIntegrityError(error instanceof Error ? error.message : "Integrity check failed.");
    }
  }

  function downloadJson() {
    downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }), `${activeCaseId}-dossier.json`);
  }

  function downloadPdf() {
    const lines = [
      `Case: ${summary.case.title} (${summary.case.caseId})`,
      `Priority band: ${summary.priority?.priorityBand ?? "Not available"}`,
      `Priority score: ${summary.priority?.score ?? "Not available"}`,
      `Confidence: ${summary.priority ? `${Math.round(summary.priority.confidence * 100)}%` : "Not available"}`,
      `Analyzer coverage: ${summary.priority ? `${Math.round(summary.priority.coverage * 100)}%` : "Not available"}`,
      `Recorded findings: ${report.findings.length}`,
      "",
      "Findings",
      ...report.findings.map(({ finding }) => `${finding.findingId} ${finding.type} · ${finding.severity} · ${finding.observationStatus}`),
      "",
      "Analysis limitations",
      ...limitations,
      "",
      mockMode ? "Fixture-mode report. Recorded outputs are synthetic and are not live processing." : "Generated from the live backend records. Observations are not verdicts.",
    ];
    downloadBlob(createTextPdf("TraceDocs investigation dossier", lines), `${activeCaseId}-dossier.pdf`);
  }

  return (
    <>
      <Breadcrumbs items={[{ label: "Reports" }]} />
      <PageHeader eyebrow="Case record" title="Reports" description="Export the recorded dossier, review processing coverage and inspect the event history." actions={<select className="compact-select" value={activeCaseId} onChange={(event) => { setCaseId(event.target.value); setIntegrity(null); }} aria-label="Select report case">{cases.map((item) => <option key={item.caseId} value={item.caseId}>{item.caseId}</option>)}</select>} />
      <section className="report-hero">
        <div className="report-hero-title"><span className="report-icon"><Icon name="reports" size={22} /></span><div><p className="eyebrow">{summary.case.caseId}</p><h2>{summary.case.title}</h2><span>{mockMode ? "Generated from recorded fixture outputs" : report.composedFromLiveRoutes ? "Composed from live backend records" : "Generated by the backend"}</span></div></div>
        <div className="report-hero-actions"><Button variant="secondary" onClick={downloadJson}><Icon name="download" size={16} /> JSON</Button><Button onClick={downloadPdf}><Icon name="download" size={16} /> Download PDF</Button></div>
      </section>
      <div className="report-metrics">
        <div className="report-metric"><span>Investigation priority</span>{summary.priority ? <StatusBadge status={summary.priority.priorityBand} /> : <strong>Not available</strong>}<small>Priority is an ordering aid</small></div>
        <div className="report-metric"><span>Priority score</span><strong>{summary.priority ? summary.priority.score.toFixed(3) : "—"}</strong><small>Not a probability</small></div>
        <div className="report-metric"><span>Confidence</span><strong>{summary.priority ? `${Math.round(summary.priority.confidence * 100)}%` : "—"}</strong><small>Reported separately</small></div>
        <div className="report-metric"><span>Analyzer coverage</span><strong>{summary.priority ? `${Math.round(summary.priority.coverage * 100)}%` : "—"}</strong><small>Available / applicable analyzers</small></div>
      </div>
      <div className="report-grid">
        <section className="panel integrity-panel">
          <div className="section-heading"><div><h2>Document integrity</h2><p>{mockMode ? "Fixture reference comparison · mock result" : "Re-hashes stored originals and compares with the manifest"}</p></div><Button variant="secondary" onClick={() => void checkIntegrity()}><Icon name="refresh" size={15} /> Check integrity</Button></div>
          {integrityError && <p className="form-error" role="alert">{integrityError}</p>}
          {integrity && <div className="integrity-summary"><strong>{mockMode ? "Fixture check" : "Integrity check"}: {integrity.status}</strong><span>Checked {new Date(integrity.checkedAt).toLocaleString()}</span></div>}
          <div className="integrity-list">{(integrity?.documents ?? summary.documents.map((document) => ({ docId: document.docId, status: "NOT CHECKED" as const, expectedSha256: document.sha256, actualSha256: null }))).map((entry) => (
            <div className="integrity-row" key={entry.docId}><span><Icon name="file" size={16} />{entry.docId}</span><IntegrityBadge status={entry.status} /><small>{integrity ? `Expected ${entry.expectedSha256.slice(0, 10)}…` : mockMode ? "Run the fixture reference check" : "Run the integrity check"}</small></div>
          ))}</div>
          {mockMode && <p className="mock-footnote">Integrity is mocked against fixture metadata; uploaded files are not hashed by this demo.</p>}
        </section>
        <section className="panel limitations-panel">
          <div className="section-heading"><div><h2>Analysis limitations</h2><p>Gaps and unsupported operations for this workspace.</p></div><span className="limitation-count">{limitations.length}</span></div>
          <ul className="limitation-list">{limitations.map((limitation) => <li key={limitation}><span className="limitation-dot" />{limitation}</li>)}</ul>
        </section>
      </div>
      <section className="panel event-panel">
        <div className="section-heading"><div><h2>Investigation event log</h2><p>{mockMode ? "Append-only activity from fixture records and this browser session." : "Append-only activity recorded by the backend."}</p></div><label className="event-filter"><span>Event</span><select value={eventType} onChange={(event) => setEventType(event.target.value)}><option value="all">All events</option>{["UPLOAD", "RERUN", "RECLASSIFY", "REVIEW", "COMMENT", "REOPEN", "EXPORT", "VIEW"].map((item) => <option key={item}>{item}</option>)}</select></label></div>
        {filteredEvents.length ? <div className="table-wrap"><table className="data-table event-table"><thead><tr>{([["type", "Activity"], ["targetId", "Target"], ["actor", "Actor"], ["at", "Time"]] as const).map(([key, label]) => <th key={key} aria-sort={sortState(key)}><SortButton label={label} active={eventSort?.key === key} descending={Boolean(eventSort?.descending)} onClick={() => toggleEventSort(key)} /></th>)}<th>Details</th></tr></thead><tbody>{filteredEvents.map((event) => <EventRow event={event} key={event.eventId} />)}</tbody></table></div> : <EmptyState title="No events match this filter" detail="Choose a different event type to review the log." />}
      </section>
      <div className="priority-note"><span className="priority-note-icon"><Icon name="shield" size={17} /></span><p><strong>About this result.</strong> Investigation priority is a triage aid, not a probability or verdict. Review the underlying evidence and limitations before drawing conclusions.</p></div>
    </>
  );
}

function EventRow({ event }: { event: InvestigationEvent }) {
  const payload = Object.entries(event.payload).map(([key, value]) => `${key}: ${String(value)}`).join(" · ");
  return <tr><td><span className={`event-type event-type-${event.type.toLowerCase()}`}>{event.type}</span></td><td>{event.targetId}</td><td>{event.actor}</td><td>{new Date(event.at).toLocaleString()}</td><td>{payload || "—"}</td></tr>;
}
