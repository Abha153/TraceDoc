import { describe, expect, it } from "vitest";
import { pageRenderUrl } from "../config";

describe("live page render url", () => {
  it("points at the backend render route and encodes the document id", () => {
    expect(pageRenderUrl("D-01", 2)).toBe("/api/v1/documents/D-01/pages/2/render");
    expect(pageRenderUrl("a/b", 1)).toBe("/api/v1/documents/a%2Fb/pages/1/render");
  });
});
