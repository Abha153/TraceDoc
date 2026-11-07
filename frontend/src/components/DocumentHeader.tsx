import { useState } from "react";
import { Link } from "react-router-dom";
import type { PriorityResult } from "../../../contracts/types";
import type { DocumentRecord, JobStatus } from "../../../contracts/types";
import { Gauge } from "./Ring";
import { Chip } from "./Primitives";
import { Icon, StatusBadge } from "./ui";
import { DOC_TYPE_LABEL, bandLabel } from "../lib/format";

/** Slim header that stays put while the tab content underneath changes. */
export function DocumentHeader({ record, status, priority, types }: { record: DocumentRecord; status: JobStatus | null; priority: PriorityResult | null; types: string[] }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(record.sha256);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return (
    <header className="doc-header">
      <div className="doc-header-main">
        <nav className="breadcrumbs doc-crumbs" aria-label="Breadcrumb">
          <Link to={`/cases/${encodeURIComponent(record.caseId)}`}>{record.caseId}</Link>
          <span className="breadcrumb-separator">&gt;</span>
          <span aria-current="page">{record.docId}</span>
        </nav>
        <h1 className="doc-title">{record.filename}</h1>
        <div className="doc-meta">
          {status && <StatusBadge status={status} />}
          <Chip tone="grey" dot={false}>{record.pageCount} {record.pageCount === 1 ? "page" : "pages"}</Chip>
          {types.length > 0 && <Chip tone="grey" dot={false}>{types.map((type) => DOC_TYPE_LABEL[type] ?? type).join(", ")}</Chip>}
          <span className="mono-value doc-hash" title={record.sha256}>SHA-256 {record.sha256.slice(0, 16)}…{record.sha256.slice(-6)}</span>
          <button type="button" className="chip" onClick={() => void copy()} aria-label={`Copy SHA-256 of ${record.filename}`}>
            <Icon name={copied ? "check" : "copy"} size={12} />{copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <div className="doc-header-gauge" title={priority ? `Document priority: ${bandLabel[priority.priorityBand]}` : "No priority yet"}>
        <Gauge score={priority?.score ?? null} band={priority?.priorityBand} size="sm" />
        <span className="label">Document priority</span>
      </div>
    </header>
  );
}
