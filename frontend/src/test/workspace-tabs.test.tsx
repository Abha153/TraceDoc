import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { server } from "./setup";

vi.mock("../components/CytoscapeGraph", () => ({ CytoscapeGraph: () => null }));
vi.mock("../config", async (importOriginal) => ({ ...(await importOriginal<typeof import("../config")>()), jobPollIntervalMs: 30 }));

const BANNED = /\b(verified|genuine|authentic|forged|forgery|fraud\w*|intentional(ly)?|deliberate(ly)?)\b/i;

async function open(path: string) {
  const user = userEvent.setup();
  window.history.pushState({}, "", "/login");
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /sign in/i }));
  await screen.findByRole("heading", { name: "Analysed documents" });
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  return user;
}
beforeEach(() => localStorage.clear());

describe("findings tab", () => {
  it("lists the document's findings, filters them, and shows evidence with the numbers behind it", async () => {
    const user = await open("/documents/D-01/findings");
    const list = await screen.findByRole("region", { name: "Findings for this document" });
    expect(await within(list).findByText("2 of 2 findings")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Review status"), "CONFIRMED");
    expect(await screen.findByText("No findings match")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(await screen.findByText("2 of 2 findings")).toBeInTheDocument();
    const evidence = await screen.findByRole("region", { name: "Evidence" });
    expect(within(evidence).getAllByRole("img", { name: /^Crop of D-01/ }).length).toBeGreaterThan(0);
    expect(within(evidence).getAllByText("The numbers behind it").length).toBeGreaterThan(0);
  });

  it("shows the review state from the server while the machine observation stays unchanged", async () => {
    const user = await open("/documents/D-01/findings");
    const detail = await screen.findByRole("region", { name: "Finding detail" });
    const machineBefore = within(detail).getByText("Machine observation").parentElement!.textContent;
    await user.click(await screen.findByRole("button", { name: /confirm observation/i }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Analyst review" })).getByText("CONFIRMED")).toBeInTheDocument());
    expect(within(screen.getByRole("region", { name: "Finding detail" })).getByText("Machine observation").parentElement!.textContent).toBe(machineBefore);
    expect(await screen.findByText(/CONFIRMED|Confirmed/, { selector: ".timeline strong" })).toBeInTheDocument();
  });

  it("requires a reason to dismiss and shows the validation", async () => {
    const user = await open("/documents/D-01/findings");
    await user.click(await screen.findByRole("button", { name: /dismiss with reason/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a reason before dismissing this observation.");
    await user.type(screen.getByLabelText("Reason for dismissal"), "Matches the scanned original.");
    await user.click(screen.getByRole("button", { name: /dismiss with reason/i }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Analyst review" })).getByText("DISMISSED")).toBeInTheDocument());
  });

  it("explains a 409 conflict, saves nothing and keeps the review state", async () => {
    server.use(http.post("*/findings/:findingId/review", () => HttpResponse.json({ error: { code: "STALE_GENERATION", message: "stale" } }, { status: 409 })));
    const user = await open("/documents/D-01/findings");
    const panel = await screen.findByRole("region", { name: "Analyst review" });
    const before = within(panel).getByText("Review state (from server)").parentElement!.textContent;
    await user.click(await screen.findByRole("button", { name: /confirm observation/i }));
    expect(await screen.findByText(/changed after you opened it/i)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Analyst review" })).getByText("Review state (from server)").parentElement!.textContent).toBe(before);
  });

  it("links a finding to its region on the Evidence tab", async () => {
    await open("/documents/D-01/findings");
    const link = await screen.findByRole("link", { name: /show on page/i });
    expect(link.getAttribute("href")).toMatch(/^\/documents\/D-01\/evidence\?finding=/);
  });

  it("states what no findings means for a document without any, including its coverage", async () => {
    await open("/documents/D-11/findings");
    expect(await screen.findByText("No findings for this document")).toBeInTheDocument();
    expect(screen.getByText(/No anomalies observed by the analyzers that ran \(\d+ of \d+ possible\)/)).toBeInTheDocument();
  });
});

describe("evidence tab", () => {
  it("shows the page viewer, extracted fields as claims, and per-page document type", async () => {
    await open("/documents/D-01/evidence");
    expect(await screen.findByRole("region", { name: "Page viewer" })).toBeInTheDocument();
    const fields = await screen.findByRole("region", { name: "Extracted fields" });
    expect(within(fields).getByText(/OCR output is a claim, not ground truth/)).toBeInTheDocument();
    expect(within(fields).getByText("Claimed value")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pages and document type" })).toBeInTheDocument();
    expect((await screen.findAllByRole("button", { name: /Show on page:/ })).length).toBeGreaterThan(0);
  });

  it("reclassifies a page, shows the re-run job and the corrected type afterwards", async () => {
    const user = await open("/documents/D-01/evidence");
    const pages = await screen.findByRole("region", { name: "Pages and document type" });
    await user.selectOptions(within(pages).getByLabelText("Document type for page 1"), "bank_statement");
    await user.click(within(pages).getByRole("button", { name: "Reclassify" }));
    expect(await screen.findByRole("status", { name: "Re-run job" })).toBeInTheDocument();
    expect(await screen.findByText(/corrected by fixture-analyst/, {}, { timeout: 5000 })).toBeInTheDocument();
  });
});

describe("entities and report tabs", () => {
  it("labels the entities and graph as case-wide", async () => {
    await open("/documents/D-01/entities");
    expect(await screen.findByText("Case entities")).toBeInTheDocument();
    expect(screen.getAllByText("Case-wide").length).toBeGreaterThan(0);
  });

  it("renders every report section with observed and potential findings kept apart and no verdict wording", async () => {
    await open("/documents/D-01/report");
    for (const name of ["Executive summary", "Technical analysis", "Observed versus potential", "Limitations and analyzer failures", "Review outcomes and history", "Integrity", "Event timeline"]) {
      expect(await screen.findByRole("region", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /export pdf/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /share/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /print/i })).toBeInTheDocument();
    expect(screen.getByText("Potential anomaly (needs verification)")).toBeInTheDocument();
    expect(screen.queryByText(/not available from the configured backend/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(BANNED);
  });

  it("makes a failed integrity check loud", async () => {
    server.use(http.get("*/cases/:caseId/integrity", ({ params }) => HttpResponse.json({
      caseId: String(params.caseId), checkedAt: "2026-11-07T10:00:00Z", status: "FAIL",
      documents: [{ docId: "D-01", expectedSha256: "a".repeat(64), actualSha256: "b".repeat(64), status: "FAIL" }],
    })));
    await open("/documents/D-01/report");
    const alert = await screen.findByText("Integrity check FAILED");
    expect(alert.closest("[role=alert]")).toBeInTheDocument();
    expect(screen.getByText("FAIL")).toBeInTheDocument();
  });

  it("serves the same report at /cases/:caseId/report", async () => {
    await open("/cases/CASE-001/report");
    expect(await screen.findByRole("heading", { name: "Case report" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Executive summary" })).toBeInTheDocument();
  });
});
