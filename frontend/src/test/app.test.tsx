import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { UploadResponse } from "../../../contracts/api";
import type { DocumentRecord, Job } from "../../../contracts/types";
import { App } from "../App";
import { registerFixtureUpload } from "../mocks/handlers";
import { parseContractFixture } from "../parseContractFixture";
import { server } from "./setup";

vi.mock("../components/CytoscapeGraph", () => ({ CytoscapeGraph: () => null }));

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /sign in/i }));
  expect(await screen.findByRole("heading", { name: "Cases" })).toBeInTheDocument();
}

describe("fixture workspace", () => {
  it("creates a case inline, validates and uploads a file, polls and retries a job, and focuses reviewed evidence", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const now = new Date().toISOString();
    const docId = "TEST-UPLOAD-DOC";
    const jobId = "TEST-UPLOAD-JOB";
    const document: DocumentRecord = {
      docId,
      caseId: "CASE-TEST",
      filename: "evidence.pdf",
      sha256: "0".repeat(64),
      mimeType: "application/pdf",
      pageCount: 1,
      processing: { ocr: "UNAVAILABLE" },
      pipelineVersion: "fixture-test",
      receivedAt: now,
    };
    const queuedJob: Job = {
      jobId,
      caseId: "CASE-TEST",
      docId,
      pipelineVersion: "fixture-test",
      status: "QUEUED",
      analyzers: { ocr: { state: "PENDING" } },
      attempts: 1,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
    };
    server.use(http.post("*/api/v1/cases/:caseId/documents", async ({ params }) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const caseId = String(params.caseId);
      const response: UploadResponse = {
        caseId,
        documents: [{ ...document, caseId }],
        jobs: [{ ...queuedJob, caseId }],
      };
      registerFixtureUpload(response);
      return HttpResponse.json(response, { status: 202 });
    }));

    render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /upload/i }));
    await screen.findByRole("heading", { name: "Upload documents" });
    await user.click(screen.getByRole("button", { name: "Create case" }));
    await user.type(screen.getByLabelText("New case title"), "Evidence intake test");
    await user.click(screen.getByRole("button", { name: "Create and select case" }));
    await waitFor(() => expect(screen.queryByLabelText("New case title")).not.toBeInTheDocument());

    const fileInput = screen.getByLabelText("Choose documents");
    const pdf = new File(["%PDF-1.4"], "evidence.pdf", { type: "application/pdf" });
    const unsupported = new File(["text"], "notes.txt", { type: "text/plain" });
    await user.upload(fileInput, [pdf, unsupported]);
    expect(screen.getByText("notes.txt: file type is not supported.")).toBeInTheDocument();
    expect(screen.getByText("evidence.pdf")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Upload 1 file" }));

    expect(await screen.findByRole("progressbar", { name: "File upload progress" })).toHaveAttribute("aria-valuenow", "100");
    expect(await screen.findByText("QUEUED")).toBeInTheDocument();
    expect(await screen.findAllByText("RUNNING", {}, { timeout: 10_000 })).not.toHaveLength(0);
    await screen.findByRole("button", { name: /retry fixture job/i }, { timeout: 10_000 });
    expect(await screen.findByText("Fixture mode: no document analysis is performed.")).toBeInTheDocument();
    expect(await screen.findByText("PARTIAL")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry fixture job/i }));
    expect(await screen.findByText("QUEUED")).toBeInTheDocument();
    expect(await screen.findByText(/Attempt 2 \/ 3/)).toBeInTheDocument();
    expect(await screen.findByText("DONE", {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText("The fixture job completed; no new analysis results were produced.")).toBeInTheDocument();

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
    await user.click(screen.getByRole("button", { name: /new case/i }));
    await user.type(screen.getByLabelText("Case title"), "Case list creation test");
    await user.click(screen.getByRole("button", { name: "Create case" }));
    expect(await screen.findByRole("heading", { name: "Case list creation test" })).toBeInTheDocument();
  });

  it("limits the findings view to the selected case when opened from case detail", async () => {
    const user = userEvent.setup();
    render(<App />);
    await signIn(user);
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

  it("shows simulated job failures and their analyzer reasons without presenting them as clean results", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const now = new Date().toISOString();
    const docId = "TEST-FAILED-DOC";
    const jobId = "TEST-FAILED-JOB";
    const document: DocumentRecord = {
      docId,
      caseId: "CASE-001",
      filename: "fail-evidence.pdf",
      sha256: "1".repeat(64),
      mimeType: "application/pdf",
      pageCount: 1,
      processing: { ocr: "UNAVAILABLE" },
      pipelineVersion: "fixture-test",
      receivedAt: now,
    };
    const job: Job = {
      jobId,
      caseId: "CASE-001",
      docId,
      pipelineVersion: "fixture-test",
      status: "QUEUED",
      analyzers: { ocr: { state: "PENDING" } },
      attempts: 1,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
    };
    server.use(http.post("*/api/v1/cases/:caseId/documents", ({ params }) => {
      const response: UploadResponse = {
        caseId: String(params.caseId),
        documents: [document],
        jobs: [job],
      };
      registerFixtureUpload(response);
      return HttpResponse.json(response, { status: 202 });
    }));

    render(<App />);
    await signIn(user);
    await user.click(screen.getByRole("link", { name: /upload/i }));
    await screen.findByRole("heading", { name: "Upload documents" });
    await user.upload(screen.getByLabelText("Choose documents"), new File(["%PDF-1.4"], "fail-evidence.pdf", { type: "application/pdf" }));
    await user.click(screen.getByRole("button", { name: "Upload 1 file" }));

    expect(await screen.findByText("FAILED", {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByText(/Fixture failure simulation for a file named with 'fail'/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry fixture job/i })).toBeInTheDocument();
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
