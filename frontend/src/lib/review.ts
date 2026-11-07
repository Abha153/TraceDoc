import type { ReviewRequest } from "../../../contracts/api";
import { ApiError } from "../api/client";

/** Client-side validation that mirrors the server rules, so the analyst sees the reason before a round trip. */
export function validateReview(body: ReviewRequest): string | null {
  if (body.action === "DISMISS" && !body.reason?.trim()) return "Add a reason before dismissing this observation.";
  if (body.action === "COMMENT" && !body.comment?.trim()) return "Add a comment before posting.";
  return null;
}

/** Plain-language message for a failed review. 409 means the finding is not in the state the analyst was looking at. */
export function reviewErrorMessage(error: unknown, action: ReviewRequest["action"]): string {
  if (error instanceof ApiError && error.status === 409) {
    return action === "REOPEN"
      ? "Only a finding that has already been reviewed can be reopened. The review state was refreshed."
      : "This finding changed after you opened it, for example because the case was re-analysed. Nothing was saved. The latest version has been loaded; review it again.";
  }
  if (error instanceof ApiError && error.status === 400) return error.message;
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return "You are not signed in or not allowed to review this finding.";
  return error instanceof Error ? error.message : "The review action was not saved.";
}

export function reviewEventLabel(event: { type: string; payload: Record<string, unknown> }): string {
  if (event.type === "REVIEW" && typeof event.payload.status === "string") return event.payload.status;
  return event.type;
}
