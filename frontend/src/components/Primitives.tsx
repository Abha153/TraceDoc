import { Link } from "react-router-dom";
import type { Tone } from "./Ring";
import { Icon } from "./ui";

export function Chip({ tone, children, dot = true, className = "", ...rest }: { tone?: Tone | "blue"; children: React.ReactNode; dot?: boolean } & React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={`chip ${tone ? `chip-${tone}` : ""} ${className}`} {...rest}>{dot && <i className="chip-dot" aria-hidden="true" />}{children}</span>;
}

export function StatCard({ label, value, hint, tone, to, icon }: { label: string; value: React.ReactNode; hint?: string; tone?: "red" | "amber" | "green"; to?: string; icon?: string }) {
  const body = (
    <>
      <div className="stat-card-top"><span className="big-number">{value}</span>{icon && <span className="stat-card-icon" aria-hidden="true"><Icon name={icon} size={18} /></span>}</div>
      <p className="label">{label}</p>
      {hint && <small>{hint}</small>}
    </>
  );
  const className = `stat-card ${tone ? `stat-card-${tone}` : ""}`;
  return to ? <Link to={to} className={className}>{body}</Link> : <div className={className}>{body}</div>;
}

export function Skeleton({ width = "100%", height = 14, className = "" }: { width?: number | string; height?: number | string; className?: string }) {
  return <span className={`skeleton ${className}`} style={{ width, height }} aria-hidden="true" />;
}

/** Layout-matching placeholder: `rows` lines inside a panel, announced once as busy. */
export function SkeletonPanel({ rows = 4, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="panel skeleton-stack" style={{ padding: 18 }} role="status" aria-busy="true" aria-label={label}>
      <Skeleton width="30%" height={12} />
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} width={`${92 - index * 9}%`} />)}
    </div>
  );
}
