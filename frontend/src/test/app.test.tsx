import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { parseContractFixture } from "../parseContractFixture";
import { server } from "./setup";

vi.mock("../components/CytoscapeGraph", () => ({ CytoscapeGraph: () => null }));
vi.mock("../config", async (importOriginal) => ({ ...(await importOriginal<typeof import("../config")>()), jobPollIntervalMs: 30 }));

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /sign in/i }));
  expect(await screen.findByRole("heading", { name: "Analysed documents" })).toBeInTheDocument();
}

async function openCases(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("link", { name: /^Cases$/ }));
  await screen.findByRole("heading", { name: "Cases" });
}

describe("fixture workspace", () => {
  it("creates a case inline, validates and uploads a file, and polls it to a result that is never presented as clean", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /document scanner/i }));
    await screen.findByRole("heading", { name: "Scan documents" });
    await user.click(screen.getByRole("button", { name: "New case" }));
    await user.type(screen.getByLabelText("New case title"), "Evidence intake test");
    await user.click(screen.getByRole("button", { name: "Create and select case" }));
    await waitFor(() => expect(screen.queryByLabelText("New case title")).not.toBeInTheDocument());

    const pdf = new File(["%PDF-1.4"], "evidence.pdf", { type: "application/pdf" });
    const unsupported = new File(["text"], "notes.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("Choose documents"), [pdf, unsupported]);
    expect(screen.getByText("notes.txt: file type is not supported.")).toBeInTheDocument();
    expect(screen.getByText("evidence.pdf")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Analyse 1 file" }));

    expect(await screen.findByText("No analyzer ran, so this is not a clean result.", {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText("0 / 7")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Investigation priority: not yet available" })).toBeInTheDocument();
  });

  it("analyses the recorded sample documents and opens a dock pre-filled for the selected document", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/samples/:file", () => new HttpResponse(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } })));
    render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /document scanner/i }));
    await user.click(await screen.findByRole("button", { name: "Use sample documents" }));
    await screen.findByText("D-03.pdf");
    expect(screen.getByText(/Only the recorded sample documents/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Analyse 3 files" }));

    expect(await screen.findByRole("img", { name: /Investigation priority: High, score 69 out of 100/ }, { timeout: 10_000 })).toBeInTheDocument();
    const dock = screen.getByRole("navigation", { name: "Document sections" });
    expect(within(dock).getByLabelText("2 findings")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open investigation/i })).toHaveAttribute("href", "/documents/D-01/overview");
    expect(within(dock).getByRole("link", { name: /next step/i })).toHaveAttribute("href", "/documents/D-01/overview");
    await user.click(screen.getByRole("button", { name: "bank_statement_aarav.pdf" }));
    expect(screen.getByRole("link", { name: /open investigation/i })).toHaveAttribute("href", "/documents/D-03/overview");
  });

  it("keeps other documents navigable when one upload fails and disables the dock for the failed one", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /document scanner/i }));
    await screen.findByRole("heading", { name: "Scan documents" });
    await user.upload(screen.getByLabelText("Choose documents"), [
      new File(["x"], "D-01.png", { type: "image/png" }),
      new File(["%PDF-1.4"], "fail-evidence.pdf", { type: "application/pdf" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Analyse 2 files" }));

    const failedChip = await screen.findByRole("button", { name: /fail-evidence\.pdf \(failed\)/ }, { timeout: 10_000 });
    const dock = screen.getByRole("navigation", { name: "Document sections" });
    expect(within(dock).getByRole("link", { name: /Overview/ })).toHaveAttribute("href", "/documents/D-01/overview");
    await user.click(failedChip);
    expect(await screen.findByText(/Fixture failure simulation for a file named with 'fail'/)).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Document sections" })).getAllByRole("link", { name: /Overview/ })[0]).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: /open investigation/i })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("button", { name: "id_card_aarav.png" }));
    expect(within(screen.getByRole("navigation", { name: "Document sections" })).getByRole("link", { name: /Overview/ })).not.toHaveAttribute("aria-disabled");
  });

  it("focuses reviewed evidence from the findings list", async () => {
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /findings/i }));
    await user.click(await screen.findByRole("link", { name: /DOB CONFLICT/i }));
    expect(await screen.findAllByText("INCONSISTENT")).not.toHaveLength(0);
    await waitFor(() => expect(screen.getByRole("button", { name: /DOB CONFLICT/ })).toHaveClass("region-active"));
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("215%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /confirm observation/i }));

    await waitFor(() => expect(screen.getAllByText("CONFIRMED")).not.toHaveLength(0));
    expect(screen.getAllByText("INCONSISTENT")).not.toHaveLength(0);
  });

  it("creates and opens a case from the case list", async () => {
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
    await openCases(user);
    await user.click(screen.getByRole("button", { name: /new case/i }));
    await user.type(screen.getByLabelText("Case title"), "Case list creation test");
    await user.click(screen.getByRole("button", { name: "Create case" }));
    expect(await screen.findByRole("heading", { name: "Case list creation test" })).toBeInTheDocument();
  });

  it("limits the findings view to the selected case when opened from case detail", async () => {
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
    await openCases(user);
    await user.click(screen.getByRole("link", { name: /CASE-002/ }));
    await user.click(await screen.findByRole("link", { name: "Review findings" }));

    expect(await screen.findByRole("combobox", { name: "Case" })).toHaveValue("CASE-002");
    expect(screen.getByText(/\d+ of \d+ recorded findings/)).toBeInTheDocument();
  });

  it("filters by recorded category and exposes the active sort direction", async () => {
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /findings/i }));
    await screen.findByText(/\d+ of \d+ recorded findings/);
    await user.selectOptions(screen.getByRole("combobox", { name: "Category" }), "context");
    expect(screen.getByText(/\d+ of \d+ recorded findings/).textContent).toMatch(/^[1-9]\d* of /);

    await user.click(screen.getByRole("button", { name: /confidence/i }));
    expect(screen.getByRole("columnheader", { name: /confidence/i })).toHaveAttribute("aria-sort", "descending");
  });

  it("requires dismissal reasons, records review history, supports comments and reopen, and rolls back a failed update", async () => {
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /findings/i }));
    await user.click(await screen.findByRole("link", { name: /F-0002/ }));
    await screen.findByRole("heading", { name: "Review history" });

    await user.click(screen.getByRole("button", { name: /dismiss with reason/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add a reason before dismissing");
    expect(screen.getAllByText("UNREVIEWED")).not.toHaveLength(0);
    await user.type(screen.getByLabelText("Reason for dismissal"), "The recorded spelling difference is explainable.");
    await user.click(screen.getByRole("button", { name: /dismiss with reason/i }));
    expect(await screen.findAllByText("DISMISSED")).not.toHaveLength(0);
    expect(await screen.findByText("The recorded spelling difference is explainable.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Add a comment"), "Review the original source document.");
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    expect(await screen.findByText("Review the original source document.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reopen review" }));
    expect(await screen.findAllByText("UNREVIEWED")).not.toHaveLength(0);
    expect(screen.getByText("REOPEN")).toBeInTheDocument();

    server.use(http.post("*/api/v1/findings/F-0002/review", () =>
      HttpResponse.json({ error: { code: "REVIEW_UNAVAILABLE", message: "Review update failed." } }, { status: 500 }),
    ));
    await user.click(screen.getByRole("button", { name: /confirm observation/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review update failed.");
    expect(screen.getAllByText("UNREVIEWED")).not.toHaveLength(0);
    expect(screen.getAllByText("INCONSISTENT")).not.toHaveLength(0);
  });

  it("compares contract extraction values, syncs viewer zoom, and swaps the evidence panels", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /findings/i }));
    await user.click(await screen.findByRole("link", { name: /DOB CONFLICT/i }));
    await user.click(await screen.findByRole("link", { name: /compare regions/i }));

    expect(await screen.findByText("2004-08-12")).toBeInTheDocument();
    expect(screen.getByText("2001-08-12")).toBeInTheDocument();
    expect(screen.getByText("95%")).toBeInTheDocument();
    expect(screen.getByText("91%")).toBeInTheDocument();
    expect(screen.getByText("none apply to semantic type dob")).toBeInTheDocument();
    const firstViewer = () => container.querySelector(".compare-viewers .viewer-card")?.getAttribute("aria-label");
    expect(firstViewer()).toBe("D-01");
    await user.click(screen.getByRole("button", { name: /swap panels/i }));
    expect(firstViewer()).toBe("D-02");

    await waitFor(() => expect(screen.getAllByText("200%")).toHaveLength(2));
    await user.click(screen.getAllByRole("button", { name: "Zoom in" })[0]);
    await waitFor(() => expect(screen.getAllByText("215%")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: /sync zoom on/i }));
    await user.click(screen.getAllByRole("button", { name: "Zoom in" })[0]);
    expect(await screen.findByText("230%")).toBeInTheDocument();
    expect(screen.getByText("215%")).toBeInTheDocument();
  });

  it("opens the assertion-linked region using the graph's keyboard-accessible node list", async () => {
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /entities/i }));
    expect(await screen.findByRole("heading", { name: "Entities & assertions" })).toBeInTheDocument();
    const documentNode = await screen.findByRole("button", { name: /document: D-01 id_card/i });
    await user.click(documentNode);
    expect(await screen.findByRole("button", { name: /full name:/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /full name:/i })).toHaveClass("region-active"));
  });

  it("keeps entity search recoverable when there are no matching records", async () => {
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /entities/i }));
    await screen.findByRole("button", { name: /document: D-01 id_card/i });

    await user.type(screen.getByRole("textbox", { name: "Find entity" }), "no matching entity");
    expect(await screen.findByRole("status")).toHaveTextContent("No entities match this search.");
    expect(screen.getByText("No entity selected")).toBeInTheDocument();

    await user.clear(screen.getByRole("textbox", { name: "Find entity" }));
    expect(await screen.findByRole("heading", { name: "Assertions by semantic type" })).toBeInTheDocument();
  });

  it("exports the recorded dossier and runs the explicitly labelled fixture integrity check", async () => {
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /reports/i }));
    expect(await screen.findByRole("heading", { name: "Reports" })).toBeInTheDocument();

    const createObjectURL = vi.mocked(URL.createObjectURL);
    createObjectURL.mockClear();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: "JSON" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "application/json" })));
    await user.click(screen.getByRole("button", { name: /download pdf/i }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "application/pdf" })));
    await user.click(screen.getByRole("button", { name: /check integrity/i }));
    expect(await screen.findByText(/Fixture check: PASS/)).toBeInTheDocument();
    expect(screen.getByText(/uploaded files are not hashed/i)).toBeInTheDocument();
  });

  it("rejects fixture values that violate the shared schema", () => {
    expect(() => parseContractFixture("GraphResponse", {
      caseId: "CASE-001",
      nodes: [{ id: "D-01", kind: "unknown", label: "Document" }],
      edges: [],
    })).toThrow(/Invalid GraphResponse fixture/);
  });
});
