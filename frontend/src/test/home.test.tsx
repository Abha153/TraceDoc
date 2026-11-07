import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DocumentRecord, Job } from "../../../contracts/types";
import { App } from "../App";
import { documentStatus, matchesFilter, matchesSearch, sortRows } from "../pages/Home";
import type { DocRow } from "../pages/Home";

vi.mock("../components/CytoscapeGraph", () => ({ CytoscapeGraph: () => null }));

async function openHome(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /sign in/i }));
  await screen.findByRole("heading", { name: "Analysed documents" });
  await screen.findByText("6 of 6 documents");
}

describe("home: analysed documents", () => {
  it("flattens every case into one row per document with status, coverage and findings", async () => {
    const user = userEvent.setup();
    await openHome(user);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(6);
    const aarav = rows.find((row) => within(row).queryByText("id_card_aarav.png"))!;
    expect(within(aarav).getByText("CASE-001")).toBeInTheDocument();
    expect(within(aarav).getByText("ID card")).toBeInTheDocument();
    expect(within(aarav).getByText("5 / 5")).toBeInTheDocument();
    await waitFor(() => expect(within(aarav).getByText("2")).toBeInTheDocument());
  });

  it("says what the analyzers observed for a document with no findings, never that it is genuine", async () => {
    const user = userEvent.setup();
    await openHome(user);
    expect(await screen.findAllByText("No anomalies observed by the analyzers that ran")).toHaveLength(3);
    expect(document.body.textContent).not.toMatch(/\b(verified|genuine|authentic|forged|fraud\w*)\b/i);
  });

  it("filters and searches the list and keeps the choice in the URL", async () => {
    const user = userEvent.setup();
    await openHome(user);
    await user.click(screen.getByRole("button", { name: "Partial results" }));
    expect(screen.getByText("1 of 6 documents")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Needs review" }));
    expect(await screen.findByText("3 of 6 documents")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "No findings observed" }));
    expect(await screen.findByText("3 of 6 documents")).toBeInTheDocument();
    expect(window.location.search).toContain("filter=no-findings");
    await user.click(screen.getByRole("button", { name: "All" }));
    await user.type(screen.getByRole("searchbox", { name: "Search documents" }), "9d1a2b62");
    expect(await screen.findByText("1 of 6 documents")).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search documents" }));
    await user.type(screen.getByRole("searchbox", { name: "Search documents" }), "no such file");
    expect(await screen.findByText("No documents match")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(await screen.findByText("6 of 6 documents")).toBeInTheDocument();
  });

  it("previews a selected document with its top observations and an INSPECT action", async () => {
    const user = userEvent.setup();
    await openHome(user);
    await user.click(screen.getByRole("button", { name: "Preview id_card_aarav.png" }));
    const panel = await screen.findByRole("complementary", { name: "Preview of id_card_aarav.png" });
    expect(within(panel).getByRole("link", { name: /INSPECT/ })).toHaveAttribute("href", "/documents/D-01/overview");
    expect(await within(panel).findByText("Dob conflict")).toBeInTheDocument();
    expect(within(panel).getAllByText(/Observed ·/).length).toBeGreaterThan(0);
    expect(within(panel).getByText(/case-wide/)).toBeInTheDocument();
  });

  it("groups by case and offers a scan action", async () => {
    const user = userEvent.setup();
    await openHome(user);
    await user.click(screen.getByRole("button", { name: "Group by case" }));
    expect(await screen.findAllByText(/^CASE-00[12] · /)).toHaveLength(2);
    expect(screen.getByRole("link", { name: /scan new document/i })).toHaveAttribute("href", "/scanner");
  });
});

describe("home helpers", () => {
  const doc = (over: Partial<DocumentRecord>): DocumentRecord => ({ docId: "D-1", caseId: "C-1", filename: "a.png", sha256: "abc123", mimeType: "image/png", pageCount: 1, processing: { ocr: "AVAILABLE" }, pipelineVersion: "v", receivedAt: "2026-11-01T00:00:00Z", ...over });
  const row = (over: Partial<DocRow>): DocRow => ({ doc: doc({}), caseTitle: "T", casePriority: null, status: "DONE", findings: [], openCount: 0, ran: 1, possible: 1, lastReviewed: null, types: null, ...over });

  it("derives status from the latest job, else from analyzer statuses", () => {
    const jobs = [
      { jobId: "1", docId: "D-1", status: "FAILED", updatedAt: "2026-11-01T00:00:00Z" },
      { jobId: "2", docId: "D-1", status: "DONE", updatedAt: "2026-11-02T00:00:00Z" },
    ] as unknown as Job[];
    expect(documentStatus(doc({}), jobs)).toBe("DONE");
    expect(documentStatus(doc({ processing: { ocr: "AVAILABLE", signature: "UNAVAILABLE" } }), [])).toBe("PARTIAL");
  });

  it("does not call a document without any analyzer run a 'no findings' document", () => {
    expect(matchesFilter(row({ ran: 0 }), "no-findings")).toBe(false);
    expect(matchesFilter(row({ ran: 2 }), "no-findings")).toBe(true);
    expect(matchesFilter(row({ status: "FAILED", ran: 2 }), "no-findings")).toBe(false);
  });

  it("matches search on filename, hash and case, and sorts by date", () => {
    expect(matchesSearch(row({}), "ABC1")).toBe(true);
    expect(matchesSearch(row({}), "zzz")).toBe(false);
    const older = row({ doc: doc({ docId: "old", receivedAt: "2026-10-01T00:00:00Z" }) });
    const newer = row({ doc: doc({ docId: "new", receivedAt: "2026-11-01T00:00:00Z" }) });
    expect(sortRows([older, newer], "date").map((item) => item.doc.docId)).toEqual(["new", "old"]);
  });
});
