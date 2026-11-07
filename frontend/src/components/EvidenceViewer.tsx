import { useEffect, useState } from "react";
import type { Evidence, Region } from "../../../contracts/types";
import { mockMode, pageRenderUrl } from "../config";
import { fixturePageUrls } from "../mockData";
import { StatusBadge } from "./ui";
import { humanize } from "../lib/format";

function pageUrl(docId: string, page: number): string | undefined {
  return mockMode ? fixturePageUrls[docId] : pageRenderUrl(docId, page);
}

/** Crops the canonical page render to a region (normalised x, y, w, h) so the evidence is visible without leaving the finding. */
export function RegionCrop({ region }: { region: Region }) {
  const url = pageUrl(region.docId, region.page);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!url) return;
    const image = new Image();
    image.onload = () => setSize({ w: image.naturalWidth, h: image.naturalHeight });
    image.src = url;
  }, [url]);
  if (!url) return <p className="muted-text">No page render is available for {region.docId}.</p>;
  const [x, y, w, h] = region.bbox;
  const safeW = Math.max(0.01, Math.min(1, w));
  const safeH = Math.max(0.01, Math.min(1, h));
  return (
    <figure className="region-crop">
      <div
        className="region-crop-image"
        role="img"
        aria-label={`Crop of ${region.docId} page ${region.page}${region.label ? `: ${region.label}` : ""}`}
        style={{
          backgroundImage: `url(${url})`,
          backgroundSize: `${100 / safeW}% ${100 / safeH}%`,
          backgroundPosition: `${safeW >= 1 ? 0 : (x / (1 - safeW)) * 100}% ${safeH >= 1 ? 0 : (y / (1 - safeH)) * 100}%`,
          aspectRatio: size ? `${safeW * size.w} / ${safeH * size.h}` : "3 / 2",
        }}
      />
      <figcaption><span>{region.label ?? "Evidence region"}</span><span className="mono-value">{region.docId} · p{region.page} · [{region.bbox.map((value) => value.toFixed(3)).join(", ")}]</span></figcaption>
    </figure>
  );
}

/** The recorded evidence for a finding: description, region crops, and the measurements behind it. */
export function EvidenceViewer({ evidence, docId }: { evidence: Evidence[]; docId?: string }) {
  return (
    <div className="evidence-list">
      {evidence.map((item) => {
        const regions = docId ? item.regions.filter((region) => region.docId === docId) : item.regions;
        return (
          <article className="evidence-record" key={item.evidenceId}>
            <div className="evidence-record-top"><span className="mono-value">{item.evidenceId}</span><span className="kind-label">{humanize(item.kind)}</span></div>
            <p>{item.description}</p>
            {regions.length > 0 && <div className="crop-grid">{regions.map((region, index) => <RegionCrop key={`${region.docId}-${region.page}-${index}`} region={region} />)}</div>}
            {item.assertionIds && item.assertionIds.length > 0 && <small className="muted-text">Assertions: {item.assertionIds.join(", ")}</small>}
            {item.measurements && Object.keys(item.measurements).length > 0 && (
              <details open>
                <summary>The numbers behind it</summary>
                <dl className="measurements">{Object.entries(item.measurements).map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd className="mono-value">{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>
              </details>
            )}
            <div className="provenance-line"><span className="mono-value">{item.provenance.analyzer} v{item.provenance.analyzerVersion}</span><StatusBadge status={item.provenance.status} /></div>
          </article>
        );
      })}
    </div>
  );
}
