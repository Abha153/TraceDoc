import { useEffect, useState } from "react";
import type { PriorityBand } from "../../../contracts/types";
import { bandLabel, scoreOutOf100 } from "../lib/format";
import { prefersReducedMotion } from "../lib/motion";

export type Tone = "red" | "amber" | "green" | "grey";
const SIZES = { sm: 44, md: 96, lg: 148 } as const;

export function bandTone(band: PriorityBand): Tone {
  return band === "critical" || band === "high" ? "red" : band === "moderate" ? "amber" : "green";
}

/** Counts up to `target` unless the user prefers reduced motion. */
export function useCountUp(target: number, ms = 800): number {
  const instant = prefersReducedMotion() || typeof requestAnimationFrame !== "function";
  const [value, setValue] = useState(instant ? target : 0);
  useEffect(() => {
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") { setValue(target); return; }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / ms);
      setValue(Math.round(target * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

interface RingProps {
  fraction: number; // 0..1
  tone: Tone;
  size?: keyof typeof SIZES;
  className?: string;
  children?: React.ReactNode;
  label: string;
}

/** Base ring used by the priority gauge and by the scanner's analysis progress. */
export function Ring({ fraction, tone, size = "md", className = "", children, label }: RingProps) {
  const dimension = SIZES[size];
  const stroke = size === "sm" ? 5 : 8;
  const radius = (dimension - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(1, Math.max(0, fraction));
  const [shown, setShown] = useState(prefersReducedMotion() ? clamped : 0);
  useEffect(() => { setShown(clamped); }, [clamped]);
  return (
    <div className={`ring ring-${size} ring-tone-${tone} ${className}`} style={{ width: dimension, height: dimension }} role="img" aria-label={label}>
      <svg width={dimension} height={dimension} viewBox={`0 0 ${dimension} ${dimension}`} aria-hidden="true">
        <circle className="ring-track" cx={dimension / 2} cy={dimension / 2} r={radius} strokeWidth={stroke} />
        <circle className="ring-progress" cx={dimension / 2} cy={dimension / 2} r={radius} strokeWidth={stroke}
          strokeDasharray={circumference} strokeDashoffset={circumference * (1 - shown)} />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

interface GaugeProps {
  /** null while reasoning has not produced a result for the case or document. */
  score: number | null;
  band?: PriorityBand;
  size?: keyof typeof SIZES;
  caption?: string;
}

/** Investigation priority gauge. The number is a priority score out of 100, not a probability, and never stands in for confidence or coverage. */
export function Gauge({ score, band, size = "lg", caption }: GaugeProps) {
  const target = score === null ? 0 : scoreOutOf100(score);
  const shown = useCountUp(target);
  if (score === null || !band) {
    return (
      <div className="gauge-block">
        <Ring fraction={0} tone="grey" size={size} label="Investigation priority: not yet available">
          <span className="ring-value">—</span><span className="ring-verdict">Pending</span>
        </Ring>
        {caption && <p className="gauge-caption">{caption}</p>}
      </div>
    );
  }
  return (
    <div className="gauge-block">
      <Ring fraction={score} tone={bandTone(band)} size={size} label={`Investigation priority: ${bandLabel[band]}, score ${target} out of 100`}>
        <span className="ring-value">{shown}</span><span className="ring-verdict">{bandLabel[band]}</span>
      </Ring>
      {caption && <p className="gauge-caption">{caption}</p>}
    </div>
  );
}
