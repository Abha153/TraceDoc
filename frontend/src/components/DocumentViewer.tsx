import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ExtractedField, Finding, ForensicSignal, Region } from "../../../contracts/types";
import { fixturePageUrls } from "../mockData";
import { Button, Icon } from "./ui";

export interface DocumentViewerHandle {
  focusRegion: (region: Region) => void;
}

interface DocumentViewerProps {
  docId: string;
  fields?: ExtractedField[];
  signals?: ForensicSignal[];
  findings?: Finding[];
  initialRegion?: Region;
  pageCount?: number;
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  title?: string;
}

interface OverlayRegion {
  id: string;
  region: Region;
  kind: "field" | "signal" | "finding";
  label: string;
  detail: string;
  confidence?: number;
  status?: Finding["observationStatus"];
}

export const DocumentViewer = forwardRef<DocumentViewerHandle, DocumentViewerProps>(
  function DocumentViewer(
    { docId, fields = [], signals = [], findings = [], initialRegion, pageCount, zoom: controlledZoom, onZoomChange, title },
    ref,
  ) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const controlledZoomRef = useRef(controlledZoom);
    const zoomChangeRef = useRef(onZoomChange);
    const previousControlledZoom = useRef(controlledZoom);
    controlledZoomRef.current = controlledZoom;
    zoomChangeRef.current = onZoomChange;
    const [page, setPage] = useState(1);
    const [internalZoom, setInternalZoom] = useState(1);
    const zoom = controlledZoom ?? internalZoom;
    const [showFields, setShowFields] = useState(true);
    const [showSignals, setShowSignals] = useState(true);
    const [showFindings, setShowFindings] = useState(true);
    const [activeRegion, setActiveRegion] = useState<Region | null>(null);
    const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

    const overlays = useMemo<OverlayRegion[]>(() => [
      ...(showFields ? fields.map((field) => ({
        id: field.fieldId,
        region: field.region,
        kind: "field" as const,
        label: field.name.replaceAll("_", " "),
        detail: field.normalizedValue ?? field.rawValue,
        confidence: field.ocrConfidence,
      })) : []),
      ...(showSignals ? signals.flatMap((signal) => signal.regions.map((region, index) => ({
        id: `${signal.signalId}-${index}`,
        region,
        kind: "signal" as const,
        label: signal.type.replaceAll("_", " "),
        detail: signal.detector,
        confidence: signal.confidence,
      }))) : []),
      ...(showFindings ? findings.flatMap((finding) => finding.evidence.flatMap((evidence) =>
        evidence.regions.filter((region) => region.docId === docId).map((region, index) => ({
          id: `${finding.findingId}-${evidence.evidenceId}-${index}`,
          region,
          kind: "finding" as const,
          label: finding.type.replaceAll("_", " "),
          detail: evidence.description,
          confidence: finding.confidence,
          status: finding.observationStatus,
        })),
      )) : []),
    ], [docId, fields, findings, signals, showFields, showFindings, showSignals]);

    const totalPages = Math.max(1, pageCount ?? 1, ...overlays.map((overlay) => overlay.region.page));
    const imageUrl = page === 1 ? fixturePageUrls[docId] : undefined;
    const pageOverlays = overlays.filter((overlay) => overlay.region.page === page);

    useEffect(() => {
      if (previousControlledZoom.current !== undefined && controlledZoom === undefined) {
        setInternalZoom(previousControlledZoom.current);
      }
      previousControlledZoom.current = controlledZoom;
    }, [controlledZoom]);

    const focusRegion = useCallback((region: Region) => {
      setPage(region.page);
      if (controlledZoomRef.current === undefined) setInternalZoom(2);
      zoomChangeRef.current?.(2);
      setActiveRegion(region);
      window.setTimeout(() => {
        const element = scrollRef.current;
        if (!element) return;
        const left = region.bbox[0] * element.scrollWidth;
        const top = region.bbox[1] * element.scrollHeight;
        element.scrollTo({
          left: Math.max(0, left - element.clientWidth / 2),
          top: Math.max(0, top - element.clientHeight / 2),
          behavior: "smooth",
        });
      }, 80);
    }, []);

    useImperativeHandle(ref, () => ({ focusRegion }), [focusRegion]);

    useEffect(() => {
      if (initialRegion) {
        focusRegion(initialRegion);
      } else {
        setPage(1);
        if (controlledZoomRef.current === undefined) setInternalZoom(1);
        zoomChangeRef.current?.(1);
        setActiveRegion(null);
      }
    }, [focusRegion, initialRegion]);

    function zoomBy(amount: number) {
      const next = Math.min(2.5, Math.max(0.65, Math.round((zoom + amount) * 100) / 100));
      if (controlledZoom === undefined) setInternalZoom(next);
      onZoomChange?.(next);
    }

    function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
      if (event.button !== 0 || (event.target as HTMLElement).closest("svg")) return;
      const element = scrollRef.current;
      if (!element) return;
      drag.current = {
        x: event.clientX,
        y: event.clientY,
        left: element.scrollLeft,
        top: element.scrollTop,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
      const start = drag.current;
      if (!start || !scrollRef.current) return;
      scrollRef.current.scrollLeft = start.left - (event.clientX - start.x);
      scrollRef.current.scrollTop = start.top - (event.clientY - start.y);
    }

    return (
      <section className="viewer-card" aria-label={title ?? `Document viewer ${docId}`}>
        <div className="viewer-toolbar">
          <div className="viewer-doc-title">
            <span className="viewer-file-icon"><Icon name="file" size={17} /></span>
            <span><strong>{title ?? docId}</strong><small>Canonical render · page {page}</small></span>
          </div>
          <div className="viewer-controls">
            <Button
              variant="quiet"
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => zoomBy(-0.15)}
              disabled={zoom <= 0.65}
            ><Icon name="zoomOut" size={17} /></Button>
            <span className="zoom-label">{Math.round(zoom * 100)}%</span>
            <Button
              variant="quiet"
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => zoomBy(0.15)}
              disabled={zoom >= 2.5}
            ><Icon name="zoomIn" size={17} /></Button>
          </div>
        </div>
        <div className="viewer-tools">
          <label className="toggle-control"><input type="checkbox" checked={showFields} onChange={(event) => setShowFields(event.target.checked)} /> Fields</label>
          <label className="toggle-control"><input type="checkbox" checked={showSignals} onChange={(event) => setShowSignals(event.target.checked)} /> Signals</label>
          <label className="toggle-control"><input type="checkbox" checked={showFindings} onChange={(event) => setShowFindings(event.target.checked)} /> Findings</label>
          <div className="viewer-page-nav">
            <Button variant="quiet" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>‹</Button>
            <span>{page} / {totalPages}</span>
            <Button variant="quiet" aria-label="Next page" disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>›</Button>
          </div>
        </div>
        <div
          className="viewer-viewport"
          ref={scrollRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
          onKeyDown={(event) => {
            if (event.key === "+" || event.key === "=") zoomBy(0.15);
            if (event.key === "-") zoomBy(-0.15);
          }}
          tabIndex={0}
          aria-label="Document page. Drag to pan; use plus or minus to zoom."
        >
          <div className="viewer-stage" style={{ width: `${zoom * 100}%` }}>
            {imageUrl ? (
              <>
                <img src={imageUrl} alt={`${docId}, canonical page ${page}`} draggable={false} />
                <svg
                  className="viewer-overlay"
                  viewBox="0 0 1240 1754"
                  role="img"
                  aria-label="Evidence regions"
                  preserveAspectRatio="none"
                >
                  {pageOverlays.map((overlay) => {
                    const [x, y, width, height] = overlay.region.bbox;
                    const isActive = activeRegion === overlay.region ||
                      (activeRegion?.docId === overlay.region.docId &&
                        activeRegion?.label === overlay.region.label);
                    return (
                      <rect
                        key={overlay.id}
                        x={x * 1240}
                        y={y * 1754}
                        width={width * 1240}
                        height={height * 1754}
                        rx="3"
                        className={`region-box region-${overlay.kind} ${overlay.status ? `region-status-${overlay.status.toLowerCase()}` : ""} ${isActive ? "region-active" : ""}`}
                        tabIndex={0}
                        role="button"
                        aria-label={`${overlay.label}: ${overlay.detail}${overlay.confidence === undefined ? "" : `, ${Math.round(overlay.confidence * 100)} percent confidence`}`}
                        onClick={() => focusRegion(overlay.region)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            focusRegion(overlay.region);
                          }
                        }}
                      >
                        <title>{`${overlay.label}: ${overlay.detail}${overlay.confidence === undefined ? "" : ` · ${Math.round(overlay.confidence * 100)}% confidence`}`}</title>
                      </rect>
                    );
                  })}
                </svg>
              </>
            ) : (
              <div className="viewer-no-image">
                <Icon name="file" size={30} />
                <strong>Page preview unavailable</strong>
                <span>Fixture mode has no canonical render for this upload.</span>
              </div>
            )}
          </div>
        </div>
        <div className="viewer-legend" aria-label="Overlay legend">
          <span><i className="legend-dot legend-field" /> Extracted field</span>
          <span><i className="legend-dot legend-signal" /> Forensic signal</span>
          <span><i className="legend-dot legend-finding" /> Recorded observation</span>
          <span><i className="legend-dot legend-status-inconsistent" /> Inconsistent</span>
          <span><i className="legend-dot legend-status-potential" /> Potential anomaly</span>
          <span><i className="legend-dot legend-status-observed" /> Observed</span>
          <span><i className="legend-dot legend-status-inconclusive" /> Inconclusive</span>
          <span className="pan-hint">Drag page to pan</span>
        </div>
      </section>
    );
  },
);
