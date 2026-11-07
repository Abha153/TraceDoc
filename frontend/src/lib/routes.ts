export const DOC_TABS = ["overview", "investigation", "findings", "evidence", "entities", "report"] as const;
export type DocTab = (typeof DOC_TABS)[number];

/** The shell content wrapper remounts when this key changes. Document tabs share one key so the workspace stays mounted. */
export function transitionKey(pathname: string): string {
  return /^\/documents\/[^/]+/.test(pathname) ? "documents-workspace" : pathname;
}

export function tabIndex(pathname: string): number | null {
  const match = /^\/documents\/[^/]+\/([^/]+)/.exec(pathname);
  const index = match ? DOC_TABS.indexOf(match[1] as DocTab) : -1;
  return index >= 0 ? index : null;
}

export const DOC_TAB_LABELS: Record<DocTab, string> = {
  overview: "Overview",
  investigation: "Investigation",
  findings: "Findings",
  evidence: "Evidence",
  entities: "Entities & Graph",
  report: "Report",
};

/** "Next step" always advances one logical step: Overview, Investigation, Findings, Evidence, Report, then a new scan. */
const NEXT_STEP: Partial<Record<DocTab, DocTab>> = { overview: "investigation", investigation: "findings", findings: "evidence", evidence: "report", entities: "report" };

export function nextStep(docId: string, current: DocTab | undefined): { label: string; to: string; title: string } {
  if (current === "report") return { label: "Scan another document", to: "/scanner", title: "Go to the document scanner" };
  const next = current ? NEXT_STEP[current] ?? "overview" : "overview";
  return { label: "Next step", to: `/documents/${encodeURIComponent(docId)}/${next}`, title: `Go to ${DOC_TAB_LABELS[next]}` };
}
