import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { handlers } from "../mocks/handlers";

export const server = setupServer(...handlers);

function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** jsdom's FormData and File cannot be streamed by Node's fetch, so multipart bodies are encoded by hand. */
async function encodeMultipart(form: FormData): Promise<{ body: Uint8Array; contentType: string }> {
  const boundary = `----tracedocs${Math.random().toString(16).slice(2)}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    } else {
      chunks.push(
        encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.name}"\r\nContent-Type: ${value.type || "application/octet-stream"}\r\n\r\n`),
        await readFileBytes(value),
        encoder.encode("\r\n"),
      );
    }
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  chunks.forEach((chunk) => { body.set(chunk, offset); offset += chunk.length; });
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

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
    const prepare = body instanceof FormData
      ? encodeMultipart(body).then(({ body: bytes, contentType }) => ({ body: bytes, headers: { "Content-Type": contentType } }))
      : Promise.resolve({ body, headers: {} as Record<string, string> });
    void prepare.then((prepared) => fetch(this.url, {
      method: this.method,
      body: prepared.body as BodyInit | null | undefined,
      headers: prepared.headers,
      credentials: this.withCredentials ? "include" : "same-origin",
    })).then(async (response) => {
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
