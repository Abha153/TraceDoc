import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import path from "node:path";
import type { InvestigationEvent, ReviewStatus } from "@contracts/types";
import { Mutex } from "../util/mutex.js";
import type { ReviewSource } from "./reviewSource.js";

export type NewEvent = Omit<InvestigationEvent, "eventId" | "at">;

/** Same actor viewing the same thing again within this window is not logged again. */
const VIEW_DEDUPE_MS = 60_000;

/**
 * Append-only investigation log: one JSON object per line in DATA_DIR/audit/events.jsonl.
 * There is no update or delete. Events are only ever added at the end.
 *
 *  - A corrupt line anywhere in the file stops the log from loading (audit data is never silently dropped).
 *  - The one tolerated damage is an unfinished LAST line (a crash mid-write). It cannot be a valid event, so on load
 *    it is cut off the end of the file (as any write-ahead log does) and kept in events.jsonl.discarded. Every complete
 *    event before it is untouched.
 */
export class JsonlEventLog {
  private events?: InvestigationEvent[];
  private readonly lock = new Mutex();
  private readonly lastView = new Map<string, number>();

  constructor(
    private readonly auditDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get filePath(): string {
    return path.join(this.auditDir, "events.jsonl");
  }

  private async load(): Promise<InvestigationEvent[]> {
    if (this.events) return this.events;
    let text = "";
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const lines = text.split("\n");
    const endsClean = text === "" || text.endsWith("\n");
    if (endsClean) lines.pop(); // the empty string after the final newline
    const events: InvestigationEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") throw new Error(`events.jsonl: empty line at ${i + 1}`);
      try {
        events.push(JSON.parse(line) as InvestigationEvent);
      } catch {
        const isUnfinishedTail = !endsClean && i === lines.length - 1;
        if (!isUnfinishedTail) throw new Error(`events.jsonl is corrupt at line ${i + 1}; refusing to continue`);
        await this.discardTail(lines.slice(0, i), line);
      }
    }
    return (this.events = events);
  }

  /** Keeps the unfinished fragment aside, then cuts it off so the file ends on a complete line again. */
  private async discardTail(goodLines: string[], fragment: string): Promise<void> {
    await appendFile(path.join(this.auditDir, "events.jsonl.discarded"), fragment + "\n", "utf8");
    const keep = goodLines.length === 0 ? "" : goodLines.join("\n") + "\n";
    await truncate(this.filePath, Buffer.byteLength(keep, "utf8"));
  }

  append(e: NewEvent): Promise<InvestigationEvent> {
    return this.lock.run(async () => {
      const events = await this.load();
      const next = events.reduce((m, ev) => Math.max(m, Number(/^IE-(\d+)$/.exec(ev.eventId)?.[1] ?? 0)), 0) + 1;
      const event: InvestigationEvent = {
        eventId: `IE-${String(next).padStart(4, "0")}`,
        caseId: e.caseId,
        at: this.now().toISOString(),
        actor: e.actor,
        type: e.type,
        targetId: e.targetId,
        payload: e.payload,
      };
      await mkdir(this.auditDir, { recursive: true });
      await appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8");
      events.push(event); // memory is updated only after the line is on disk
      return event;
    });
  }

  /** Logs a VIEW unless the same actor viewed the same target within the last minute. */
  async recordView(caseId: string, actor: string, targetId: string): Promise<InvestigationEvent | undefined> {
    const key = `${actor}|${targetId}`;
    const t = this.now().getTime();
    const last = this.lastView.get(key);
    if (last !== undefined && t - last < VIEW_DEDUPE_MS) return undefined;
    this.lastView.set(key, t);
    return this.append({ caseId, actor, type: "VIEW", targetId, payload: {} });
  }

  async forCase(caseId: string): Promise<InvestigationEvent[]> {
    return this.lock.run(async () => (await this.load()).filter((e) => e.caseId === caseId));
  }

  async forTarget(targetId: string): Promise<InvestigationEvent[]> {
    return this.lock.run(async () => (await this.load()).filter((e) => e.targetId === targetId));
  }
}

const REVIEW_STATUSES: readonly ReviewStatus[] = ["CONFIRMED", "DISMISSED", "INCONCLUSIVE"];

/**
 * Review status is never stored on a finding. It is what you get by replaying that finding's events in order:
 * REVIEW sets the status, REOPEN goes back to UNREVIEWED, COMMENT and everything else change nothing.
 */
export function deriveReviewStatus(events: InvestigationEvent[]): ReviewStatus {
  let status: ReviewStatus = "UNREVIEWED";
  for (const e of events) {
    if (e.type === "REVIEW") {
      const s = e.payload["status"];
      if (typeof s === "string" && (REVIEW_STATUSES as readonly string[]).includes(s)) status = s as ReviewStatus;
    } else if (e.type === "REOPEN") {
      status = "UNREVIEWED";
    }
  }
  return status;
}

/** What the analyst did to a finding: reviews, comments and reopenings (VIEW and system events are not review history). */
const HISTORY_TYPES = new Set<InvestigationEvent["type"]>(["REVIEW", "COMMENT", "REOPEN"]);

export class EventLogReviews implements ReviewSource {
  constructor(private readonly log: Pick<JsonlEventLog, "forTarget">) {}

  async statusOf(findingId: string): Promise<ReviewStatus> {
    return deriveReviewStatus(await this.log.forTarget(findingId));
  }

  async historyOf(findingId: string): Promise<InvestigationEvent[]> {
    return (await this.log.forTarget(findingId)).filter((e) => HISTORY_TYPES.has(e.type));
  }
}
