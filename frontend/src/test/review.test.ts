import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { reviewErrorMessage, validateReview } from "../lib/review";

describe("review validation", () => {
  it("requires a reason to dismiss and a comment to comment, ignoring whitespace", () => {
    expect(validateReview({ action: "DISMISS" })).toMatch(/reason/i);
    expect(validateReview({ action: "DISMISS", reason: "   " })).toMatch(/reason/i);
    expect(validateReview({ action: "DISMISS", reason: "Matches the scanned original." })).toBeNull();
    expect(validateReview({ action: "COMMENT", comment: "" })).toMatch(/comment/i);
    expect(validateReview({ action: "CONFIRM" })).toBeNull();
    expect(validateReview({ action: "INCONCLUSIVE" })).toBeNull();
    expect(validateReview({ action: "REOPEN" })).toBeNull();
  });

  it("explains a 409 in plain language for both a stale review and a reopen of an unreviewed finding", () => {
    const conflict = new ApiError("conflict", 409);
    expect(reviewErrorMessage(conflict, "CONFIRM")).toMatch(/changed after you opened it/i);
    expect(reviewErrorMessage(conflict, "CONFIRM")).toMatch(/nothing was saved/i);
    expect(reviewErrorMessage(conflict, "REOPEN")).toMatch(/already been reviewed/i);
  });

  it("passes through the server's validation message and handles other failures", () => {
    expect(reviewErrorMessage(new ApiError("A reason is required to dismiss.", 400), "DISMISS")).toBe("A reason is required to dismiss.");
    expect(reviewErrorMessage(new ApiError("no", 401), "CONFIRM")).toMatch(/not signed in/i);
    expect(reviewErrorMessage("boom", "CONFIRM")).toMatch(/not saved/i);
  });
});
