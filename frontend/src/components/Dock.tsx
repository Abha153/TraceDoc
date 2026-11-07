import { Link } from "react-router-dom";
import { Icon } from "./ui";
import { DOC_TABS, DOC_TAB_LABELS, nextStep } from "../lib/routes";
import type { DocTab } from "../lib/routes";

export interface DockTab { key: DocTab; label: string; to: string; count?: number; disabledReason?: string }

export function buildDockTabs(docId: string, options: { findingCount?: number; disabledReason?: string; tabDisabled?: Partial<Record<DocTab, string>> } = {}): DockTab[] {
  return DOC_TABS.map((key) => ({
    key,
    label: DOC_TAB_LABELS[key],
    to: `/documents/${encodeURIComponent(docId)}/${key}`,
    count: key === "findings" ? options.findingCount : undefined,
    disabledReason: options.disabledReason ?? options.tabDisabled?.[key],
  }));
}

/** Floating bottom dock. It stays mounted while tab content changes; a tab that cannot work says why instead of disappearing. */
export function Dock({ tabs, activeKey, docId, disabled = false }: { tabs: DockTab[]; activeKey?: DocTab; docId: string; disabled?: boolean }) {
  const next = nextStep(docId, activeKey);
  return (
    <>
      <div className="dock-spacer" aria-hidden="true" />
      <nav className="dock" aria-label="Document sections">
        <ul className="dock-tabs">
          {tabs.map((tab, index) => (
            <li key={tab.key}>
              {tab.disabledReason ? (
                <span className="dock-tab dock-tab-disabled" role="link" aria-disabled="true" tabIndex={0} title={tab.disabledReason}>
                  {tab.label}<span className="sr-only"> (unavailable: {tab.disabledReason})</span>
                </span>
              ) : (
                <Link className={`dock-tab ${tab.key === activeKey ? "dock-tab-active" : ""}`} to={tab.to} aria-current={tab.key === activeKey ? "page" : undefined} title={`${tab.label} (${index + 1})`}>
                  {tab.label}
                  {tab.count !== undefined && <span className="dock-count" aria-label={`${tab.count} findings`}>{tab.count}</span>}
                </Link>
              )}
            </li>
          ))}
        </ul>
        {disabled ? (
          <span className="button button-primary dock-next dock-tab-disabled" role="link" aria-disabled="true" tabIndex={0}>Next step</span>
        ) : (
          <Link className="button button-primary dock-next" to={next.to} title={next.title}>{next.label} <Icon name="arrow" size={15} /></Link>
        )}
      </nav>
    </>
  );
}
