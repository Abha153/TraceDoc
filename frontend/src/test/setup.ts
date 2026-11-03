import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { handlers } from "../mocks/handlers";

export const server = setupServer(...handlers);

class FetchBackedXMLHttpRequest extends EventTarget {
  upload = new EventTarget();
  status = 0;
  responseText = "";
  withCredentials = false;
  private method = "GET";
  private url = "";

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body?: XMLHttpRequestBodyInit | null) {
    const progress = new Event("progress");
    Object.defineProperties(progress, {
      lengthComputable: { value: true },
      loaded: { value: 1 },
      total: { value: 1 },
    });
    this.upload.dispatchEvent(progress);
    void fetch(this.url, {
      method: this.method,
      body,
      credentials: this.withCredentials ? "include" : "same-origin",
    }).then(async (response) => {
      this.status = response.status;
      this.responseText = await response.text();
      this.dispatchEvent(new Event("load"));
    }).catch(() => this.dispatchEvent(new Event("error")));
  }
}

Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  value: vi.fn(() => "blob:tracedoc-test"),
});
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  value: vi.fn(),
});

Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value(options: ScrollToOptions | number, top?: number) {
    if (typeof options === "number") {
      this.scrollLeft = options;
      this.scrollTop = top ?? this.scrollTop;
      return;
    }
    this.scrollLeft = options.left ?? this.scrollLeft;
    this.scrollTop = options.top ?? this.scrollTop;
  },
});

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/login");
  vi.stubGlobal("XMLHttpRequest", FetchBackedXMLHttpRequest);
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  localStorage.clear();
  vi.unstubAllGlobals();
});
afterAll(() => server.close());
