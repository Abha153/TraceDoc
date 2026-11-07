import { Link } from "react-router-dom";
import type {
  AnalyzerStatus,
  Finding,
  JobStatus,
  ObservationStatus,
  PriorityBand,
  ReviewStatus,
  Severity,
} from "../../../contracts/types";
import type { Entity } from "../../../contracts/types";

type BadgeStatus = ObservationStatus | ReviewStatus | AnalyzerStatus | PriorityBand | Severity | JobStatus | Entity["resolution"];

const badgeClass: Record<BadgeStatus, string> = {
  OBSERVED: "badge-blue",
  INCONSISTENT: "badge-amber",
  POTENTIAL_ANOMALY: "badge-violet",
  INCONCLUSIVE: "badge-gray",
  UNREVIEWED: "badge-gray",
  CONFIRMED: "badge-emerald",
  DISMISSED: "badge-slate",
  AVAILABLE: "badge-emerald",
  UNAVAILABLE: "badge-slate",
  ERROR: "badge-red",
  NOT_APPLICABLE: "badge-slate",
  low: "badge-slate",
  moderate: "badge-blue",
  high: "badge-amber",
  critical: "badge-red",
  info: "badge-blue",
  medium: "badge-violet",
  QUEUED: "badge-gray",
  RUNNING: "badge-blue",
  PARTIAL: "badge-amber",
  DONE: "badge-emerald",
  FAILED: "badge-red",
  RESOLVED: "badge-emerald",
  SUGGESTED: "badge-amber",
  UNRESOLVED: "badge-red",
};

export function StatusBadge({ status, className = "" }: { status: BadgeStatus; className?: string }) {
  return (
    <span className={`badge ${badgeClass[status]} ${className}`} data-status={status}>
      <span className="badge-dot" aria-hidden="true" />
      {status.replaceAll("_", " ")}
    </span>
  );
}

export function IntegrityBadge({ status }: { status: "PASS" | "FAIL" | "NOT CHECKED" }) {
  const pass = status === "PASS";
  return <span className={`badge ${pass ? "badge-emerald" : status === "FAIL" ? "badge-red" : "badge-slate"}`} data-status={status}><span className="badge-dot" aria-hidden="true" />{status}</span>;
}

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    cases: "M3 7.5 12 3l9 4.5-9 4.5-9-4.5ZM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5",
    upload: "M12 16V4m0 0L7 9m5-5 5 5M4 16v4h16v-4",
    findings: "M12 3 2.8 20h18.4L12 3Zm0 6v5m0 3h.01",
    entities: "M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 8a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM11 10l3 3",
    reports: "M5 3h10l4 4v14H5V3Zm10 0v5h5M8 12h8m-8 4h8",
    search: "m20 20-4.5-4.5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z",
    plus: "M12 5v14m-7-7h14",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    chevron: "m9 18 6-6-6-6",
    close: "m6 6 12 12M18 6 6 18",
    menu: "M4 6h16M4 12h16M4 18h16",
    clock: "M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    shield: "M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Zm-3-11 2 2 4-4",
    eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
    download: "M12 3v12m0 0 5-5m-5 5-5-5M4 19v2h16v-2",
    refresh: "M20 7v5h-5M4 17v-5h5m-4-3a8 8 0 0 1 13-3l2 1m-16 8-2 1a8 8 0 0 0 13 3",
    file: "M6 3h8l5 5v13H6V3Zm8 0v5h5M9 13h7m-7 4h7",
    user: "M20 21a8 8 0 0 0-16 0m8-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    zoomIn: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm5-2 5 5m-10-12v6m-3-3h6",
    zoomOut: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm5-2 5 5m-13-8h6",
    swap: "M7 7h13m0 0-4-4m4 4-4 4M17 17H4m0 0 4 4m-4-4 4-4",
    check: "m5 12 4 4L19 6",
    logout: "M10 17l5-5-5-5m5 5H3m9-9h8v18h-8",
    filter: "M4 5h16M7 12h10m-7 7h4",
    overview: "M3 3h8v8H3V3Zm10 0h8v5h-8V3ZM3 13h8v8H3v-8Zm10-3h8v11h-8V10Z",
    scanner: "M4 8V5a1 1 0 0 1 1-1h3m8 0h3a1 1 0 0 1 1 1v3m0 8v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16",
    investigation: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm5-2 5 5M11 8v3l2 1",
    documents: "M7 3h8l4 4v14H7V3Zm8 0v4h4M4 7v14h11",
    bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Zm4 4a2 2 0 0 0 4 0",
    help: "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    pin: "M12 22s7-6.1 7-13a7 7 0 1 0-14 0c0 6.9 7 13 7 13Zm0-10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  };
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name] ?? paths.file} />
    </svg>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" | "danger" }) {
  return (
    <button className={`button button-${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon name="file" size={23} /></span>
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : "The request could not be completed.";
  return (
    <div className="error-state" role="alert">
      <strong>We couldn’t load this view</strong>
      <p>{message}</p>
      {retry && <Button variant="secondary" onClick={retry}>Try again</Button>}
    </div>
  );
}

export function LoadingState({ label = "Loading evidence" }: { label?: string }) {
  return <div className="loading-state" role="status"><span className="spinner" />{label}…</div>;
}

export function Confidence({ value }: { value: number }) {
  return <span className="confidence-value">{Math.round(value * 100)}% <span>confidence</span></span>;
}

export function ObservationLabel({ finding }: { finding: Finding }) {
  return (
    <span className="observation-label">
      {finding.observationStatus === "POTENTIAL_ANOMALY" ? "Potential anomaly" : "Recorded observation"}
    </span>
  );
}

export function Breadcrumbs({ items }: { items: Array<{ label: string; to?: string }> }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`}>
          {index > 0 && <span className="breadcrumb-separator">/</span>}
          {item.to ? <Link to={item.to}>{item.label}</Link> : <span aria-current="page">{item.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/** Column or list sort control. The parent owns `aria-sort` on the <th> (or announces the order itself). */
export function SortButton({ label, active, descending, onClick }: { label: string; active: boolean; descending: boolean; onClick: () => void }) {
  return <button type="button" className="sort-button" onClick={onClick}>{label}<span aria-hidden="true">{active ? descending ? " ↓" : " ↑" : " ↕"}</span></button>;
}
