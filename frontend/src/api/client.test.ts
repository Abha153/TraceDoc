import { afterEach, describe, expect, it, vi } from "vitest";
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
