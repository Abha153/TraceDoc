import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { server } from "../test/setup";
import { parseContractFixture } from "../parseContractFixture";
import { api } from "./client";

class ProgressXMLHttpRequest extends EventTarget {
  static instance: ProgressXMLHttpRequest | null = null;
  readonly upload = new EventTarget();
  status = 202;
  responseText = JSON.stringify({ caseId: "CASE-001", documents: [], jobs: [] });
  withCredentials = false;
  method = "";
  url = "";
  body: XMLHttpRequestBodyInit | null | undefined;

  constructor() {
    super();
    ProgressXMLHttpRequest.instance = this;
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body?: XMLHttpRequestBodyInit | null) {
    this.body = body;
    for (const [loaded, total] of [[25, 50], [50, 50]]) {
      const progress = new Event("progress");
      Object.defineProperties(progress, {
        lengthComputable: { value: true },
        loaded: { value: loaded },
        total: { value: total },
      });
      this.upload.dispatchEvent(progress);
    }
    this.dispatchEvent(new Event("load"));
  }
}

describe("document upload", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports measured byte progress and sends multipart files with credentials", async () => {
    vi.stubGlobal("XMLHttpRequest", ProgressXMLHttpRequest);
    const onProgress = vi.fn();
    const file = new File(["sample"], "sample.pdf", { type: "application/pdf" });

    await api.upload("CASE/001", [file], onProgress);

    expect(onProgress).toHaveBeenNthCalledWith(1, { loaded: 25, total: 50, percent: 50 });
    expect(onProgress).toHaveBeenNthCalledWith(2, { loaded: 50, total: 50, percent: 100 });
    expect(ProgressXMLHttpRequest.instance?.withCredentials).toBe(true);
    expect(ProgressXMLHttpRequest.instance?.url).toContain("/cases/CASE%2F001/documents");
    expect(ProgressXMLHttpRequest.instance?.body).toBeInstanceOf(FormData);
  });
});

describe("contract alignment with the backend", () => {
  const API = "*/api/v1";
  const login = () => api.login({ username: "analyst@tracedocs.local", password: "demo-access" });

  it("GET /cases is CaseSummary[]: listCaseSummaries keeps the summaries and listCases maps them to plain cases", async () => {
    await login();
    const summaries = await api.listCaseSummaries();
    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) {
      expect(summary.case.caseId).toBeTruthy();
      expect(Array.isArray(summary.documents)).toBe(true);
    }
    const cases = await api.listCases();
    expect(cases.map((item) => item.caseId)).toEqual(summaries.map((summary) => summary.case.caseId));
  });

  it("composes the dossier from live read routes, and says so, when the dossier route is not mounted", async () => {
    server.use(http.get(`${API}/cases/:caseId/dossier`, () =>
      HttpResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 }),
    ));
    await login();
    const dossier = await api.dossier("CASE-001");
    expect(dossier.composedFromLiveRoutes).toBe(true);
    expect(dossier.integrity).toBeUndefined();
    expect(dossier.limitations.join(" ")).toContain("B14");
    expect(dossier.findings.length).toBeGreaterThan(0);
  });

  it("does not hide a real dossier failure behind the fallback", async () => {
    server.use(http.get(`${API}/cases/:caseId/dossier`, () =>
      HttpResponse.json({ error: { code: "INTERNAL", message: "boom" } }, { status: 500 }),
    ));
    await login();
    await expect(api.dossier("CASE-001")).rejects.toThrow("boom");
  });

  it("reports an unavailable integrity route as unavailable, not as a pass", async () => {
    server.use(http.get(`${API}/cases/:caseId/integrity`, () =>
      HttpResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 }),
    ));
    await login();
    await expect(api.integrity("CASE-001")).rejects.toThrow("not available on this backend yet");
  });

  it("mock responses validate against contracts.schema.json, like the real backend responses do", async () => {
    await login();
    const summaries = await api.listCaseSummaries();
    for (const summary of summaries) parseContractFixture("CaseSummary", summary);
    parseContractFixture("CaseSummary", await api.getCase("CASE-001"));
    parseContractFixture("FindingsResponse", await api.findings("CASE-001"));
    parseContractFixture("EventsResponse", await api.events("CASE-001"));
    const first = (await api.findings("CASE-001")).findings[0].finding.findingId;
    parseContractFixture("FindingDetail", await api.review(first, { action: "DISMISS", reason: "checked the original" }));
    parseContractFixture("EventsResponse", await api.events("CASE-001"));
  });
});
