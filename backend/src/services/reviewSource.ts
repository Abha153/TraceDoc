import type { InvestigationEvent, ReviewStatus } from "@contracts/types";

/**
 * Where review state comes from. It is derived by replaying events, never stored on the finding.
 * B9 provides the real implementation on top of the append-only event log; until then every finding is UNREVIEWED.
 */
export interface ReviewSource {
  statusOf(findingId: string): Promise<ReviewStatus>;
  historyOf(findingId: string): Promise<InvestigationEvent[]>;
}

export class NoReviews implements ReviewSource {
  async statusOf(): Promise<ReviewStatus> {
    return "UNREVIEWED";
  }
  async historyOf(): Promise<InvestigationEvent[]> {
    return [];
  }
}
