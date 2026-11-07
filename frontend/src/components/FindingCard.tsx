import type { FindingWithReview } from "../../../contracts/api";
import { Chip } from "./Primitives";
import { StatusBadge } from "./ui";
import { humanize, observationLabel, pct } from "../lib/format";

/** One finding in a list. Machine status and analyst status are separate chips, so review never rewrites the observation. */
export function FindingCard({ item, selected, onSelect }: { item: FindingWithReview; selected: boolean; onSelect: () => void }) {
  const { finding } = item;
  return (
    <button type="button" className={`finding-card ${selected ? "finding-card-selected" : ""}`} aria-pressed={selected} onClick={onSelect}>
      <span className="finding-card-top">
        <strong>{humanize(finding.type)}</strong>
        <span className="mono-value">{finding.findingId}</span>
      </span>
      <span className="finding-card-meta">
        <StatusBadge status={finding.observationStatus} />
        <Chip tone="grey" dot={false}>{humanize(finding.category)}</Chip>
        <Chip tone={finding.severity === "high" ? "red" : finding.severity === "medium" ? "amber" : "grey"}>{humanize(finding.severity)} severity</Chip>
        <Chip tone="grey" dot={false}>{pct(finding.confidence)} confidence</Chip>
      </span>
      <span className="finding-card-foot"><span>{observationLabel(finding.observationStatus)}</span><span>Review: {humanize(item.reviewStatus)}</span></span>
    </button>
  );
}
