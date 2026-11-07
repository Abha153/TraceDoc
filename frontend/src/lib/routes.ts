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
