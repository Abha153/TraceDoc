import { useRef } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { Dock, buildDockTabs } from "../../components/Dock";
import { DocumentHeader } from "../../components/DocumentHeader";
import { SkeletonPanel } from "../../components/Primitives";
import { EmptyState, ErrorState } from "../../components/ui";
import { mockMode } from "../../config";
import { fixturePageUrls } from "../../mockData";
import { useRecordLastViewed } from "../../lib/lastViewed";
import { DOC_TABS } from "../../lib/routes";
import type { DocTab } from "../../lib/routes";
import { DocumentPage } from "../Document";
import { EntitiesTab, FindingsTab, InvestigationTab, OverviewTab, ReportTab } from "./Tabs";
import { useDocumentContext } from "./useDocumentContext";

/** `/documents/:docId` with no tab: a "show in document" link carrying a region goes to Evidence, everything else to Overview. */
export function DocumentIndexRedirect() {
  const { docId = "" } = useParams();
  const location = useLocation();
  const hasRegion = Boolean(location.state && typeof location.state === "object" && "region" in location.state);
  return <Navigate to={`/documents/${encodeURIComponent(docId)}/${hasRegion ? "evidence" : "overview"}`} state={location.state} replace />;
}

function isTab(value: string | undefined): value is DocTab {
  return DOC_TABS.includes(value as DocTab);
}

/** Header, content and dock live in one layout. Only the content area re-keys (and animates) when the tab changes. */
export function DocumentWorkspace() {
  const { docId = "", tab } = useParams();
  const context = useDocumentContext(docId);
  const direction = useRef({ tab: tab ?? "", index: DOC_TABS.indexOf(tab as DocTab), value: "none" as "none" | "forward" | "back" });
  const index = DOC_TABS.indexOf(tab as DocTab);
  if (direction.current.tab !== tab) {
    direction.current = { tab: tab ?? "", index, value: index > direction.current.index ? "forward" : "back" };
  }

  const { record } = context;
  useRecordLastViewed(record && isTab(tab) ? { path: `/documents/${docId}/${tab}`, label: record.filename, caseId: record.caseId, docId } : null);

  if (!isTab(tab)) return <Navigate to={`/documents/${encodeURIComponent(docId)}/overview`} replace />;
  if (context.detail.isLoading) {
    return <div aria-busy="true"><SkeletonPanel rows={2} label="Loading document" /><div style={{ height: 14 }} /><SkeletonPanel rows={6} label="Loading document tab" /></div>;
  }
  if (context.detail.isError) return <ErrorState error={context.detail.error} retry={() => void context.detail.refetch()} />;
  if (!record) return <EmptyState title="Document unavailable" detail="No document detail is recorded for this ID." action={<Link className="button button-secondary" to="/">Back to analysed documents</Link>} />;

  const failed = context.status === "FAILED";
  const failedReason = "Analysis failed for this document";
  const noRender = mockMode && !fixturePageUrls[docId];
  const tabDisabled: Partial<Record<DocTab, string>> = failed
    ? { investigation: failedReason, findings: failedReason, evidence: failedReason, entities: failedReason, report: failedReason }
    : {
        ...(noRender ? { evidence: "Not available in fixture mode: no recorded page render for this document" } : {}),
        ...(context.entities.data && context.entities.data.entities.length === 0 ? { entities: "No entities were resolved for this case" } : {}),
      };
  const types = Array.from(new Set(context.detail.data?.pages.map((page) => page.docType) ?? []));

  return (
    <div className="workspace">
      <DocumentHeader record={record} status={context.status} priority={context.priority} types={types} />
      <div className="route-view workspace-content" key={tab} data-direction={direction.current.value}>
        {tab === "overview" && <OverviewTab context={context} docId={docId} />}
        {tab === "investigation" && <InvestigationTab context={context} docId={docId} />}
        {tab === "findings" && <FindingsTab context={context} />}
        {tab === "evidence" && <DocumentPage embedded />}
        {tab === "entities" && <EntitiesTab context={context} />}
        {tab === "report" && <ReportTab context={context} />}
      </div>
      <Dock
        docId={docId}
        activeKey={tab}
        tabs={buildDockTabs(docId, { findingCount: context.docFindings.length, tabDisabled })}
      />
    </div>
  );
}
