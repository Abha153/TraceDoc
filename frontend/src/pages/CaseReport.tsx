import { useParams } from "react-router-dom";
import { Breadcrumbs, PageHeader } from "../components/ui";
import { ReportView } from "../components/ReportView";
import { useRecordLastViewed } from "../lib/lastViewed";

/** /cases/:caseId/report: the same report as the document workspace's Report tab, for a case rather than a document. */
export function CaseReportPage() {
  const { caseId = "" } = useParams();
  useRecordLastViewed(caseId ? { path: `/cases/${caseId}/report`, label: `${caseId} report`, caseId } : null);
  return (
    <>
      <Breadcrumbs items={[{ label: "Cases", to: "/cases" }, { label: caseId, to: `/cases/${caseId}` }, { label: "Report" }]} />
      <PageHeader eyebrow="Case record" title="Case report" description="Observations and potential anomalies for human review, with limits and integrity stated." />
      <ReportView caseId={caseId} />
    </>
  );
}
