import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CaseSummary } from "../../../contracts/api";
import { App } from "../App";
import { sortCases } from "../pages/Cases";

vi.mock("../components/CytoscapeGraph", () => ({ CytoscapeGraph: () => null }));

const mk = (id: string, title: string, docs: number, band: "low" | "moderate" | "high" | "critical" | null, created: string): CaseSummary => ({
  case: { caseId: id, title, createdAt: created, status: "OPEN" } as unknown as CaseSummary["case"],
  documents: Array.from({ length: docs }, (_, i) => ({ docId: `${id}-${i}` })) as unknown as CaseSummary["documents"],
  jobs: [], perDocumentPriority: {},
  priority: band ? { priorityBand: band, score: 0.5, confidence: 0.5, coverage: 1 } as unknown as CaseSummary["priority"] : null,
});
const items = [
  mk("C-1", "Bravo", 3, "low", "2026-01-02T00:00:00Z"),
  mk("C-2", "alpha", 1, "critical", "2026-01-01T00:00:00Z"),
  mk("C-3", "Charlie", 2, null, "2026-01-03T00:00:00Z"),
  mk("C-4", "Delta", 2, "high", "2026-01-04T00:00:00Z"),
];
const ids = (list: CaseSummary[]) => list.map((c) => c.case.caseId);

describe("sortCases", () => {
  it("keeps the recorded order by default and never mutates its input", () => {
    const before = ids(items);
    expect(ids(sortCases(items, "default", true))).toEqual(before);
    sortCases(items, "title", true);
    expect(ids(items)).toEqual(before);
  });
  it("orders by priority band, with a case that has no priority yet sorting lowest", () => {
    expect(ids(sortCases(items, "priority", true))).toEqual(["C-2", "C-4", "C-1", "C-3"]);
    expect(ids(sortCases(items, "priority", false))).toEqual(["C-3", "C-1", "C-4", "C-2"]);
  });
  it("orders by title case-insensitively, by document count with a stable tie-break, and by date", () => {
    expect(ids(sortCases(items, "title", false))).toEqual(["C-2", "C-1", "C-3", "C-4"]);
    expect(ids(sortCases(items, "documents", false))).toEqual(["C-2", "C-3", "C-4", "C-1"]);
    expect(ids(sortCases(items, "newest", true))).toEqual(["C-4", "C-3", "C-1", "C-2"]);
  });
});

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /sign in/i }));
  expect(await screen.findByRole("heading", { name: "Cases" })).toBeInTheDocument();
}

describe("sorting in the UI", () => {
  it("re-orders the case list and announces the direction", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/login");
    render(<App />);
    await signIn(user);
    const titles = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "").filter((t) => !/create/i.test(t));
    await screen.findAllByRole("link", { name: /open case/i });
    const recorded = titles();
    expect(recorded.length).toBeGreaterThan(1);
    await user.selectOptions(screen.getByLabelText("Sort by"), "title");
    expect(titles()).toEqual([...recorded].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    await user.click(screen.getByRole("button", { name: /sorted ascending/i }));
    expect(titles()).toEqual([...recorded].sort((a, b) => b.toLowerCase().localeCompare(a.toLowerCase())));
    expect(screen.getByRole("button", { name: /sorted descending/i })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Sort by"), "default");
    expect(titles()).toEqual(recorded);
    expect(screen.getByRole("button", { name: /sorted/i })).toBeDisabled();
  });

  it("sorts the investigation event log by column and marks the active column with aria-sort", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/login");
    render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /reports/i }));
    const table = await screen.findByRole("table");
    const first = () => within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent ?? "");
    const header = within(table).getByRole("columnheader", { name: /activity/i });
    expect(header).toHaveAttribute("aria-sort", "none");
    await user.click(within(header).getByRole("button"));
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(first()).toEqual([...first()].sort());
    await user.click(within(header).getByRole("button"));
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(first()).toEqual([...first()].sort().reverse());
  });
});
