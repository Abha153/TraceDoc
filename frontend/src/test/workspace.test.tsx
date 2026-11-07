import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";

vi.mock("../components/CytoscapeGraph", () => ({ CytoscapeGraph: () => null }));

async function openWorkspace(path: string) {
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

describe("document workspace", () => {
  it("opens a document on Overview with a persistent header and dock", async () => {
    await openWorkspace("/documents/D-01/overview");
    expect(await screen.findByRole("heading", { level: 1, name: "id_card_aarav.png" })).toBeInTheDocument();
    expect(screen.getByText(/SHA-256 /)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "CASE-001" }).some((link) => link.getAttribute("href") === "/cases/CASE-001")).toBe(true);
    // one miniature gauge in the header and one full gauge on the Overview tab
    expect(await screen.findAllByRole("img", { name: /Investigation priority: High, score 69 out of 100/ })).toHaveLength(2);
    const dock = screen.getByRole("navigation", { name: "Document sections" });
    expect(within(dock).getByRole("link", { name: /Overview/ })).toHaveAttribute("aria-current", "page");
    expect(within(dock).getByLabelText("2 findings")).toBeInTheDocument();
  });

  it("shows three separate readings and a numbered Why flagged list with potential-anomaly wording", async () => {
    await openWorkspace("/documents/D-01/overview");
    const readings = await screen.findByRole("list", { name: "Three separate readings" }, { timeout: 5000 }).catch(() => screen.getByLabelText("Three separate readings"));
    expect(within(readings).getByText("Confidence")).toBeInTheDocument();
    expect(within(readings).getByText("Severity of top finding")).toBeInTheDocument();
    expect(within(readings).getByText("Coverage")).toBeInTheDocument();
    const why = await screen.findByRole("region", { name: "Why flagged" });
    expect(await within(why).findByText("01")).toBeInTheDocument();
    expect(within(why).getAllByText(/Observed|Potential anomaly \(needs verification\)/).length).toBeGreaterThan(0);
  });

  it("keeps the header and dock mounted while the tab content changes", async () => {
    const user = await openWorkspace("/documents/D-01/overview");
    const heading = await screen.findByRole("heading", { level: 1, name: "id_card_aarav.png" });
    const dock = screen.getByRole("navigation", { name: "Document sections" });
    for (const tab of ["Investigation", "Findings", "Evidence", "Report", "Overview"]) {
      await user.click(within(dock).getByRole("link", { name: new RegExp(`^${tab}`) }));
      await waitFor(() => expect(within(dock).getByRole("link", { name: new RegExp(`^${tab}`) })).toHaveAttribute("aria-current", "page"));
      expect(screen.getByRole("heading", { level: 1, name: "id_card_aarav.png" })).toBe(heading);
      expect(screen.getByRole("navigation", { name: "Document sections" })).toBe(dock);
    }
  });

  it("walks Overview, Investigation, Findings, Evidence, Report with Next step and ends on scanning another document", async () => {
    const user = await openWorkspace("/documents/D-01/overview");
    await screen.findByRole("heading", { level: 1, name: "id_card_aarav.png" });
    const dock = () => screen.getByRole("navigation", { name: "Document sections" });
    for (const tab of ["Investigation", "Findings", "Evidence", "Report"]) {
      await user.click(within(dock()).getByRole("link", { name: /next step/i }));
      await waitFor(() => expect(within(dock()).getByRole("link", { name: new RegExp(`^${tab}`) })).toHaveAttribute("aria-current", "page"));
    }
    expect(within(dock()).getByRole("link", { name: /scan another document/i })).toHaveAttribute("href", "/scanner");
  });

  it("labels case-wide content on the Investigation tab and shows the integrity result", async () => {
    await openWorkspace("/documents/D-01/investigation");
    expect(await screen.findByText("Case-wide investigation")).toBeInTheDocument();
    expect(screen.getAllByText("Case-wide").length).toBeGreaterThan(1);
    expect(await screen.findByRole("region", { name: "Integrity and related cases" })).toBeInTheDocument();
    expect(await screen.findByText(/Fixture mode: this integrity result is recorded/)).toBeInTheDocument();
  });

  it("redirects a bare document link to Overview and a region link to Evidence", async () => {
    await openWorkspace("/documents/D-01");
    await waitFor(() => expect(window.location.pathname).toBe("/documents/D-01/overview"));
  });

  it("remembers the last viewed document and tab for the top bar", async () => {
    await openWorkspace("/documents/D-02/findings");
    await screen.findByRole("heading", { level: 1, name: /loan_application/ });
    const resume = await screen.findByRole("link", { name: /Last viewed/ });
    expect(resume).toHaveAttribute("href", "/documents/D-02/findings");
  });

  it("shows a plain-language error with a retry for an unknown document", async () => {
    await openWorkspace("/documents/DEMO-UNKNOWN/overview");
    expect(await screen.findByText("We couldn’t load this view", {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
