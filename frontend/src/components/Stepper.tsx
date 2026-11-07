import { Icon } from "./ui";
import { LINE_LABEL, lineState, orderedAnalyzers } from "../lib/jobs";
import type { LineState } from "../lib/jobs";
import { humanize } from "../lib/format";
import type { Job } from "../../../contracts/types";

export function StepProgress({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="stepper" aria-label="Scan progress">
      {steps.map((step, index) => (
        <li key={step} className={`step ${index < current ? "step-done" : ""} ${index === current ? "step-current" : ""}`} aria-current={index === current ? "step" : undefined}>
          <span className="step-index">{index < current ? <Icon name="check" size={13} /> : String(index + 1).padStart(2, "0")}</span>
          <span className="step-label">{step}</span>
        </li>
      ))}
    </ol>
  );
}

const LINE_TONE: Record<LineState, string> = { queued: "grey", running: "red", available: "green", "not-applicable": "grey", unavailable: "grey", error: "red" };

/** Per-analyzer checklist. Status is always spelled out, so colour is never the only signal. */
export function AnalyzerChecklist({ analyzers }: { analyzers: Job["analyzers"] }) {
  return (
    <ul className="checklist" aria-label="Analyzer checklist">
      {orderedAnalyzers(analyzers).map(([name, progress]) => {
        const state = lineState(progress);
        return (
          <li key={name} className={`check-line check-${LINE_TONE[state]}`} data-state={state}>
            <span className="check-name mono">{name}</span>
            <span className="check-state">{state === "running" && <i className="spinner spinner-sm" aria-hidden="true" />}{LINE_LABEL[state]}</span>
            {progress.message && <small className="check-message">{progress.message}</small>}
            {!progress.message && state === "not-applicable" && <small className="check-message">{humanize(name)} does not apply to this file type.</small>}
          </li>
        );
      })}
    </ul>
  );
}
