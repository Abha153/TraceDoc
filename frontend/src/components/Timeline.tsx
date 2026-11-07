import type { InvestigationEvent } from "../../../contracts/types";
import { humanize } from "../lib/format";
import { reviewEventLabel } from "../lib/review";

export function Timeline({ events, empty = "No activity recorded yet." }: { events: InvestigationEvent[]; empty?: string }) {
  if (events.length === 0) return <p className="muted-text">{empty}</p>;
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.eventId}>
          <span className="timeline-dot" aria-hidden="true" />
          <div>
            <strong>{humanize(reviewEventLabel(event))}</strong>
            <small>{event.actor} · <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time> · <span className="mono-value">{event.targetId}</span></small>
            {typeof event.payload.reason === "string" && <p>{event.payload.reason}</p>}
            {typeof event.payload.comment === "string" && <p>{event.payload.comment}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
