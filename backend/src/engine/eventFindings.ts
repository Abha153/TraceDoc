/**
 * B7b helper: turns a RegionEvent into a Finding. Pure.
 *
 *  - category: visual or pdf_structure, from the event's detectors (config).
 *  - type: REGION_EVENT when several signals overlap; a single-signal event keeps the signal's own type (e.g. TEXT_LAYER_MISMATCH).
 *  - observationStatus is always POTENTIAL_ANOMALY: a forensic cue is never a conclusion.
 *  - severity from the event confidence (thresholds in config), confidence is the event confidence, kept separate.
 *  - evidence: the member signals' regions, the assertions whose region lies mostly inside the event, and the measurements.
 */
import type { DocumentAssertion, Evidence, Finding, ForensicSignal, Region, RegionEvent, Severity } from "../../../contracts/types";
import engineConfig from "../../config/engine.json";
import { DEFAULT_EVENT_CONFIG, type EventGrouperConfig, categoryOfDetectors } from "./eventGrouper";

export interface EventFindingConfig { mediumMinConfidence: number; highMinConfidence: number; assertionCoverageMin: number }
export const DEFAULT_EVENT_FINDING_CONFIG: EventFindingConfig = engineConfig.eventFinding;

export const REGION_EVENT_TYPE = "REGION_EVENT";

const NEEDS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  ELA_ANOMALY: ["Inspect the flagged region on the original scan", "Compression-level cues also occur on recompressed images; do not read in isolation"],
  NOISE_INCONSISTENCY: ["Inspect the flagged region on the original scan", "Noise differences also occur with local sharpening or scaling; do not read in isolation"],
  COPY_MOVE: ["Compare the matching regions on the original scan", "Repeated patterns such as stamps or table lines can match legitimately"],
  TEXT_LAYER_MISMATCH: ["Compare the rendered text with the text layer value in a PDF viewer", "OCR layers added to scans can also cause this signal"],
  FONT_OUTLIER: ["Inspect the flagged text in the original PDF", "Mixed fonts can come from form filling or template changes"],
  PDF_METADATA: ["Review the document metadata in a PDF viewer", "Metadata is often rewritten by export and conversion tools"],
  PDF_REVISIONS: ["Review the saved revisions of the PDF", "Incremental saves are normal for signed or form-filled PDFs"],
  SIGNATURE_DUPLICATE: ["Compare the signature regions across documents", "Genuine signatures vary, and a stored scan reused by a template can also match"],
  SIGNATURE_PLACEMENT: ["Inspect the signature placement on the original document", "Scan alignment can shift signature boxes"],
};
const NEEDS_MULTI: readonly string[] = ["Inspect the flagged region on the original document", "Overlapping cues can share one cause, such as image recompression; do not read them in isolation"];
const NEEDS_DEFAULT: readonly string[] = ["Inspect the flagged region on the original document"];

export function severityOf(confidence: number, cfg: EventFindingConfig = DEFAULT_EVENT_FINDING_CONFIG): Severity {
  return confidence < cfg.mediumMinConfidence ? "low" : confidence < cfg.highMinConfidence ? "medium" : "high";
}

const humanize = (type: string): string => {
  const s = type.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const joinList = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Share of box `a` that lies inside box `b` (0..1). */
function coveredShare(a: Region["bbox"], b: Region["bbox"]): number {
  const iw = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const ih = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return iw > 0 && ih > 0 && a[2] * a[3] > 0 ? (iw * ih) / (a[2] * a[3]) : 0;
}

export interface EventFindingOptions {
  findingNumber: number;
  evidenceNumber: number;
  eventConfig?: EventGrouperConfig;
  findingConfig?: EventFindingConfig;
}

export function eventToFinding(event: RegionEvent, members: readonly ForensicSignal[], docAssertions: readonly DocumentAssertion[], options: EventFindingOptions): Finding {
  const ecfg = options.eventConfig ?? DEFAULT_EVENT_CONFIG;
  const fcfg = options.findingConfig ?? DEFAULT_EVENT_FINDING_CONFIG;
  const multi = members.length > 1;
  const first = members[0];
  const labelled = members.flatMap((m) => m.regions).find((r) => r.label)?.label;
  // A document-level signal has no region; its evidence gets a whole-page region so it is shown, and attributed to its document.
  const memberRegions: Region[] = members.flatMap((m) =>
    m.regions.length ? m.regions.map((r) => ({ ...r, bbox: [...r.bbox] as Region["bbox"] })) : [{ docId: event.docId, page: 1, bbox: [0, 0, 1, 1] as Region["bbox"], label: "document" }]);
  const where = `${event.docId}${event.page > 0 ? ` page ${event.page}` : ""}${labelled ? ` (${labelled})` : ""}`;
  const assertionIds = docAssertions
    .filter((a) => a.docId === event.docId && event.regions.some((r) => r.page === a.region.page && coveredShare(a.region.bbox, r.bbox) >= fcfg.assertionCoverageMin))
    .map((a) => a.assertionId);
  const measurements: Record<string, number | string> = {};
  if (multi) for (const m of members) for (const [k, v] of Object.entries(m.measurements)) measurements[`${m.signalId}.${k}`] = v;
  else if (first) Object.assign(measurements, first.measurements);
  Object.assign(measurements, { eventId: event.eventId, signalIds: event.signalIds.join(","), detectors: event.detectors.join(",") });

  const evidence: Omit<Evidence, "evidenceId"> = {
    kind: multi ? "forensic_signal" : (ecfg.detectors[first?.detector ?? ""]?.evidenceKind ?? "forensic_signal"),
    description: multi
      ? `Overlapping signals from ${joinList(event.detectors)} flag the same region on ${where}`
      : `${humanize(first?.type ?? "signal")} reported by ${first?.detector ?? "an analyzer"} on ${where}`,
    regions: memberRegions,
    ...(assertionIds.length ? { assertionIds } : {}),
    measurements,
    provenance: multi || !first ? event.provenance : first.provenance, // one observation: the analyzer's own provenance
  };
  return {
    findingId: `F-${String(options.findingNumber).padStart(4, "0")}`, caseId: event.caseId, category: categoryOfDetectors(event.detectors, ecfg),
    type: multi ? REGION_EVENT_TYPE : (first?.type ?? REGION_EVENT_TYPE), observationStatus: "POTENTIAL_ANOMALY", severity: severityOf(event.confidence, fcfg),
    confidence: event.confidence, evidence: [{ evidenceId: `E-${String(options.evidenceNumber).padStart(4, "0")}`, ...evidence }],
    needsVerification: [...(multi ? NEEDS_MULTI : (NEEDS_BY_TYPE[first?.type ?? ""] ?? NEEDS_DEFAULT))],
  };
}
