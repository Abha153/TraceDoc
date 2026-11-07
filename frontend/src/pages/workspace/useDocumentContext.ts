import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { findingsForDocument } from "../../lib/format";
import { documentStatus } from "../Home";

/** Everything the document workspace needs. Case-wide data is fetched once and shared by every tab. */
export function useDocumentContext(docId: string) {
  const detail = useQuery({ queryKey: ["document", docId], queryFn: () => api.getDocument(docId), enabled: Boolean(docId) });
  const caseId = detail.data?.document.caseId ?? "";
  const summary = useQuery({ queryKey: ["case", caseId], queryFn: () => api.getCase(caseId), enabled: Boolean(caseId) });
  const findings = useQuery({ queryKey: ["findings", "case", caseId], queryFn: () => api.findings(caseId), enabled: Boolean(caseId) });
  const entities = useQuery({ queryKey: ["entities", caseId], queryFn: () => api.entities(caseId), enabled: Boolean(caseId) });
  const record = detail.data?.document;
  const docFindings = findingsForDocument(findings.data?.findings ?? [], docId);
  return {
    detail, summary, findings, entities, caseId, record,
    docFindings,
    caseFindings: findings.data?.findings ?? [],
    priority: summary.data?.perDocumentPriority[docId] ?? null,
    status: record && summary.data ? documentStatus(record, summary.data.jobs) : record ? documentStatus(record, []) : null,
  };
}

export type DocumentContext = ReturnType<typeof useDocumentContext>;
