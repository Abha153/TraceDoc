import { act, createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Region } from "../../../contracts/types";
import { fixtureAnalysis, fixtureReasoning } from "../mockData";
import { DocumentViewer } from "./DocumentViewer";
import type { DocumentViewerHandle } from "./DocumentViewer";

// Recorded contract fixtures: D-02 (application form) has fields, ELA/noise signals and finding F-0005 on the amount.
const analysis = fixtureAnalysis["D-02"];
const findings = fixtureReasoning["CASE-001"].findings.filter((f) => f.evidence.some((e) => e.regions.some((r) => r.docId === "D-02")));
const amountRegion: Region = analysis.signals[0].regions[0];
const VIEWBOX = { w: 1240, h: 1754 };

function viewer(props: Partial<React.ComponentProps<typeof DocumentViewer>> = {}) {
  return <DocumentViewer docId="D-02" fields={analysis.fields} signals={analysis.signals} findings={findings} {...props} />;
}
const rects = (container: HTMLElement) => Array.from(container.querySelectorAll<SVGRectElement>("rect.region-box"));
const attr = (el: Element, name: string) => Number(el.getAttribute(name));

describe("DocumentViewer overlays", () => {
  it("draws every contract region at its normalised position", () => {
    const { container } = render(viewer());
    const all = rects(container);
    expect(all.length).toBe(analysis.fields.length + analysis.signals.flatMap((s) => s.regions).length
      + findings.flatMap((f) => f.evidence.flatMap((e) => e.regions.filter((r) => r.docId === "D-02"))).length);
    for (const field of analysis.fields) {
      const [x, y, w, h] = field.region.bbox;
      const box = all.find((r) => attr(r, "x") === x * VIEWBOX.w && attr(r, "y") === y * VIEWBOX.h)!;
      expect(box, field.name).toBeTruthy();
      expect(attr(box, "width")).toBeCloseTo(w * VIEWBOX.w, 6);
      expect(attr(box, "height")).toBeCloseTo(h * VIEWBOX.h, 6);
    }
  });

  it.each([0.65, 1, 1.5, 2.5])("keeps boxes glued to the page at %s zoom", (zoom) => {
    const { container } = render(viewer({ zoom }));
    // The stage (image + overlay) is scaled as one unit, so box geometry in page units never changes with zoom.
    const stage = container.querySelector<HTMLElement>(".viewer-stage")!;
    expect(stage.style.width).toBe(`${zoom * 100}%`);
    const svg = container.querySelector("svg.viewer-overlay")!;
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${VIEWBOX.w} ${VIEWBOX.h}`);
    expect(svg.getAttribute("preserveAspectRatio")).toBe("none");
    const [x, y, w, h] = amountRegion.bbox;
    const hit = rects(container).find((r) => r.classList.contains("region-signal") && attr(r, "x") === x * VIEWBOX.w)!;
    expect([attr(hit, "x"), attr(hit, "y"), attr(hit, "width"), attr(hit, "height")])
      .toEqual([x * VIEWBOX.w, y * VIEWBOX.h, w * VIEWBOX.w, h * VIEWBOX.h]);
    expect(screen.getByText(`${Math.round(zoom * 100)}%`)).toBeInTheDocument();
  });

  it("styles each recorded observation by its own machine observation status and explains them in a legend", () => {
    const { container } = render(viewer());
    expect(new Set(findings.map((f) => f.observationStatus)).size).toBeGreaterThan(1); // fixture mixes statuses
    const byRegion = new Map<string, string>();
    for (const f of findings) for (const e of f.evidence) for (const r of e.regions.filter((x) => x.docId === "D-02")) {
      byRegion.set(`${r.bbox[0] * VIEWBOX.w}|${r.bbox[1] * VIEWBOX.h}`, f.observationStatus.toLowerCase());
    }
    const styled = rects(container).filter((r) => r.classList.contains("region-finding"));
    expect(styled.length).toBe(findings.flatMap((f) => f.evidence.flatMap((e) => e.regions.filter((r) => r.docId === "D-02"))).length);
    for (const r of styled) {
      expect(r.classList.contains(`region-status-${byRegion.get(`${attr(r, "x")}|${attr(r, "y")}`)}`)).toBe(true);
    }
    const legend = screen.getByLabelText("Overlay legend");
    for (const text of [/extracted field/i, /forensic signal/i, /recorded observation/i, /inconsistent/i, /potential anomaly/i, /observed/i]) {
      expect(within(legend).getByText(text)).toBeInTheDocument();
    }
  });

  it("toggles fields, forensic signals and conflicts independently", async () => {
    const user = userEvent.setup();
    const { container } = render(viewer());
    const count = (cls: string) => rects(container).filter((r) => r.classList.contains(cls)).length;
    expect(count("region-field")).toBeGreaterThan(0);
    expect(count("region-signal")).toBeGreaterThan(0);
    expect(count("region-finding")).toBeGreaterThan(0);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    for (const [index, cls] of ["region-field", "region-signal", "region-finding"].entries()) {
      await user.click(boxes[index]);
      expect(count(cls), cls).toBe(0);
      await user.click(boxes[index]);
      expect(count(cls), cls).toBeGreaterThan(0);
    }
  });
});

describe("DocumentViewer tooltip", () => {
  it("shows the value and confidence on hover and on keyboard focus, and hides it afterwards", () => {
    const { container } = render(viewer());
    const field = analysis.fields[0];
    const [x, y] = field.region.bbox;
    const box = rects(container).find((r) => attr(r, "x") === x * VIEWBOX.w && attr(r, "y") === y * VIEWBOX.h)!;
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseEnter(box);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent(field.normalizedValue ?? field.rawValue);
    expect(tip).toHaveTextContent(`${Math.round((field.ocrConfidence ?? 0) * 100)}% confidence`);
    fireEvent.mouseLeave(box);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(box);
    expect(screen.getByRole("tooltip")).toHaveTextContent(field.name.replaceAll("_", " "));
    fireEvent.blur(box);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("names the machine observation status for recorded observations", () => {
    const { container } = render(viewer());
    const region = findings.find((f) => f.type === "REGION_EVENT")!.evidence[0].regions[0];
    const box = rects(container).find((r) => r.classList.contains("region-finding")
      && attr(r, "x") === region.bbox[0] * VIEWBOX.w && attr(r, "y") === region.bbox[1] * VIEWBOX.h)!;
    fireEvent.mouseEnter(box);
    expect(screen.getByRole("tooltip")).toHaveTextContent(/potential anomaly/i);
  });
});

describe("DocumentViewer.focusRegion", () => {
  it("zooms, highlights the region and is callable imperatively", () => {
    const ref = createRef<DocumentViewerHandle>();
    const { container } = render(viewer({ ref }));
    expect(screen.getByText("100%")).toBeInTheDocument();
    act(() => ref.current!.focusRegion(amountRegion));
    expect(screen.getByText("200%")).toBeInTheDocument();
    const active = rects(container).filter((r) => r.classList.contains("region-active"));
    expect(active.length).toBeGreaterThan(0);
    // only regions carrying the focused label are highlighted; unrelated boxes stay plain
    expect(active.some((r) => attr(r, "x") === amountRegion.bbox[0] * VIEWBOX.w)).toBe(true);
    expect(active.length).toBeLessThan(rects(container).length);
  });

  it("opens focused on an initial region and reports zoom changes to a controlling parent", () => {
    const seen: number[] = [];
    render(viewer({ initialRegion: amountRegion, zoom: 1, onZoomChange: (z) => seen.push(z) }));
    expect(seen).toContain(2);
  });

  it("moves to the page of the region and says plainly when no preview exists for it", () => {
    const ref = createRef<DocumentViewerHandle>();
    render(viewer({ ref, pageCount: 3 }));
    act(() => ref.current!.focusRegion({ ...amountRegion, page: 2 }));
    expect(screen.getByText(/page preview unavailable/i)).toBeInTheDocument();
  });
});
