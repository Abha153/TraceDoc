import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import {
  EXE_BYTES, JPG_BYTES, PDF_BYTES, PNG_BYTES, TIFF_BE_BYTES, TIFF_LE_BYTES, loggedInAgent, testApp,
} from "./helpers.js";
import { detectFileType } from "../src/services/fileType.js";
import { sanitizeFilename } from "../src/services/filename.js";
import { Storage } from "../src/services/storage.js";
import { Manifest, type ManifestEntry } from "../src/services/manifest.js";

const URL = "/api/v1/cases/CASE-001/documents";

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk(dir);
  return out;
}

describe("POST /cases/:caseId/documents", () => {
  it("requires login", async () => {
    const { app } = await testApp();
    const res = await request(app).post(URL).attach("files", PDF_BYTES, "a.pdf");
    expect(res.status).toBe(401);
  });

  it("stores a PDF write-once, hashes it and appends to the manifest", async () => {
    const { app, config } = await testApp();
    const agent = await loggedInAgent(app);
    const res = await agent.post(URL).attach("files", PDF_BYTES, "statement.pdf");
    expect(res.status).toBe(201);
    expect(res.body.docIds).toHaveLength(1);
    const docId: string = res.body.docIds[0];
    expect(docId).toMatch(/^D-[0-9a-f]{12}$/);

    const stored = path.join(config.dataDir, "evidence", docId, "original.pdf");
    expect(await readFile(stored)).toEqual(PDF_BYTES);
    expect((await stat(stored)).mode & 0o777).toBe(0o444);

    const manifest = JSON.parse(await readFile(path.join(config.dataDir, "audit", "manifest.json"), "utf8")) as ManifestEntry[];
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({
      docId,
      caseId: "CASE-001",
      filename: "statement.pdf",
      bytes: PDF_BYTES.length,
      mimeType: "application/pdf",
      sha256: createHash("sha256").update(PDF_BYTES).digest("hex"),
    });
    expect(new Date(manifest[0]!.receivedAt).toString()).not.toBe("Invalid Date");
  });

  it("accepts PNG, JPEG and both TIFF byte orders in one request, with distinct docIds", async () => {
    const { app } = await testApp();
    const agent = await loggedInAgent(app);
    const res = await agent
      .post(URL)
      .attach("files", PNG_BYTES, "a.png")
      .attach("files", JPG_BYTES, "b.jpg")
      .attach("files", TIFF_LE_BYTES, "c.tif")
      .attach("files", TIFF_BE_BYTES, "d.tiff");
    expect(res.status).toBe(201);
    expect(new Set(res.body.docIds).size).toBe(4);
    expect(res.body.documents.map((d: { mimeType: string }) => d.mimeType)).toEqual([
      "image/png", "image/jpeg", "image/tiff", "image/tiff",
    ]);
  });

  it("rejects a renamed .exe, whatever its extension or declared type, and stores nothing", async () => {
    const { app, config } = await testApp();
    const agent = await loggedInAgent(app);
    for (const name of ["invoice.pdf", "photo.png", "scan.jpg"]) {
      const res = await agent.post(URL).attach("files", EXE_BYTES, { filename: name, contentType: "application/pdf" });
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe("UNSUPPORTED_FILE_TYPE");
    }
    expect(await allFiles(path.join(config.dataDir, "evidence"))).toEqual([]);
    expect(await allFiles(path.join(config.dataDir, "audit"))).toEqual([]);
  });

  it("rejects the whole request when any file is bad", async () => {
    const { app, config } = await testApp();
    const agent = await loggedInAgent(app);
    const res = await agent.post(URL).attach("files", PDF_BYTES, "ok.pdf").attach("files", EXE_BYTES, "bad.pdf");
    expect(res.status).toBe(415);
    expect(res.body.error.details).toEqual([expect.objectContaining({ filename: "bad.pdf" })]);
    expect(await allFiles(path.join(config.dataDir, "evidence"))).toEqual([]);
  });

  it("rejects an empty file", async () => {
    const { app } = await testApp();
    const agent = await loggedInAgent(app);
    const res = await agent.post(URL).attach("files", Buffer.alloc(0), "empty.pdf");
    expect(res.status).toBe(415);
  });

  it("rejects a file over MAX_UPLOAD_BYTES with 413 and stores nothing", async () => {
    const { app, config } = await testApp({ MAX_UPLOAD_BYTES: "1024" });
    const agent = await loggedInAgent(app);
    const big = Buffer.concat([PDF_BYTES, Buffer.alloc(2048, 0x20)]);
    const res = await agent.post(URL).attach("files", big, "big.pdf");
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("FILE_TOO_LARGE");
    expect(await allFiles(path.join(config.dataDir, "evidence"))).toEqual([]);
  });

  it("returns 400 when no files are sent", async () => {
    const { app } = await testApp();
    const agent = await loggedInAgent(app);
    const res = await agent.post(URL).field("note", "nothing attached");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("NO_FILES");
  });

  it("returns 400 for an unexpected field name", async () => {
    const { app } = await testApp();
    const agent = await loggedInAgent(app);
    const res = await agent.post(URL).attach("document", PDF_BYTES, "a.pdf");
    expect(res.status).toBe(400);
  });

  it("rejects an unsafe caseId", async () => {
    const { app } = await testApp();
    const agent = await loggedInAgent(app);
    const res = await agent.post("/api/v1/cases/..%2F..%2Fetc/documents").attach("files", PDF_BYTES, "a.pdf");
    expect([400, 404]).toContain(res.status);
  });

  it("never uses the client filename in a path", async () => {
    const { app, config } = await testApp();
    const agent = await loggedInAgent(app);
    const res = await agent.post(URL).attach("files", PDF_BYTES, { filename: "../../../etc/passwd.pdf" });
    expect(res.status).toBe(201);
    const docId = res.body.docIds[0] as string;
    expect(res.body.documents[0].filename).toBe("passwd.pdf");
    const files = await allFiles(config.dataDir);
    for (const f of files) expect(f.startsWith(path.resolve(config.dataDir))).toBe(true);
    expect(files).toContain(path.join(path.resolve(config.dataDir), "evidence", docId, "original.pdf"));
    expect(files.some((f) => f.includes("passwd"))).toBe(false);
  });

  it("keeps all manifest entries under concurrent uploads", async () => {
    const { app, config } = await testApp();
    const server = app.listen(0); // one server for all parallel requests
    try {
    const agent = await loggedInAgent(server);
    await Promise.all(Array.from({ length: 10 }, (_, i) => agent.post(URL).attach("files", PDF_BYTES, `f${i}.pdf`).expect(201)));
    const manifest = JSON.parse(await readFile(path.join(config.dataDir, "audit", "manifest.json"), "utf8")) as ManifestEntry[];
    expect(manifest).toHaveLength(10);
    expect(new Set(manifest.map((m) => m.docId)).size).toBe(10);
    } finally {
      server.close();
    }
  });

  it("rolls back stored originals if the manifest cannot be appended", async () => {
    const { app, config } = await testApp();
    const agent = await loggedInAgent(app);
    await mkdir(path.join(config.dataDir, "audit"), { recursive: true });
    await writeFile(path.join(config.dataDir, "audit", "manifest.json"), "{ corrupt", "utf8");
    const res = await agent.post(URL).attach("files", PDF_BYTES, "a.pdf");
    expect(res.status).toBe(500);
    expect(await allFiles(path.join(config.dataDir, "evidence"))).toEqual([]);
    // the corrupt manifest is left for a human to inspect, not overwritten
    expect(await readFile(path.join(config.dataDir, "audit", "manifest.json"), "utf8")).toBe("{ corrupt");
  });
});

describe("Storage write-once", () => {
  it("refuses to overwrite an existing original and leaves it unchanged", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "td-store-"));
    const storage = new Storage(dir);
    await storage.writeOriginal("D-abc", "pdf", PDF_BYTES);
    await expect(storage.writeOriginal("D-abc", "pdf", Buffer.from("%PDF-evil"))).rejects.toMatchObject({
      status: 409,
      code: "EVIDENCE_EXISTS",
    });
    expect(await readFile(storage.originalAbsPath("D-abc", "pdf"))).toEqual(PDF_BYTES);
  });

  it("rejects ids and extensions that could escape the data directory", async () => {
    const storage = new Storage(await mkdtemp(path.join(tmpdir(), "td-store-")));
    await expect(storage.writeOriginal("../x", "pdf", PDF_BYTES)).rejects.toMatchObject({ code: "INVALID_ID" });
    await expect(storage.writeOriginal("D-1/../../x", "pdf", PDF_BYTES)).rejects.toMatchObject({ code: "INVALID_ID" });
    await expect(storage.writeOriginal("D-1", "../pdf", PDF_BYTES)).rejects.toMatchObject({ code: "INVALID_EXTENSION" });
  });

  it("creates a derived directory per document", async () => {
    const storage = new Storage(await mkdtemp(path.join(tmpdir(), "td-store-")));
    const d = await storage.derivedDir("D-abc");
    expect((await stat(d)).isDirectory()).toBe(true);
    expect(d).toContain(path.join("derived", "D-abc"));
  });
});

describe("Manifest", () => {
  const entry = (docId: string): ManifestEntry => ({
    docId, caseId: "C", filename: "f.pdf", sha256: "0".repeat(64), bytes: 1,
    mimeType: "application/pdf", storedAs: `evidence/${docId}/original.pdf`, receivedAt: new Date().toISOString(),
  });

  it("appends and preserves earlier entries", async () => {
    const m = new Manifest(await mkdtemp(path.join(tmpdir(), "td-man-")));
    await m.append([entry("D-1")]);
    await m.append([entry("D-2")]);
    expect((await m.list()).map((e) => e.docId)).toEqual(["D-1", "D-2"]);
  });

  it("refuses a duplicate docId", async () => {
    const m = new Manifest(await mkdtemp(path.join(tmpdir(), "td-man-")));
    await m.append([entry("D-1")]);
    await expect(m.append([entry("D-1")])).rejects.toThrow(/already has/);
  });

  it("does not overwrite a corrupt manifest", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "td-man-"));
    const m = new Manifest(dir);
    await writeFile(m.filePath, "{ not json", "utf8");
    await expect(m.append([entry("D-1")])).rejects.toThrow();
    expect(await readFile(m.filePath, "utf8")).toBe("{ not json");
  });
});

describe("detectFileType", () => {
  it("identifies by content, not by name", () => {
    expect(detectFileType(PDF_BYTES)?.ext).toBe("pdf");
    expect(detectFileType(PNG_BYTES)?.ext).toBe("png");
    expect(detectFileType(JPG_BYTES)?.ext).toBe("jpg");
    expect(detectFileType(TIFF_LE_BYTES)?.ext).toBe("tiff");
    expect(detectFileType(EXE_BYTES)).toBeNull();
    expect(detectFileType(Buffer.from("<html>%PDF-</html>".padStart(2000, " ")))).toBeNull();
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
  });
});

describe("sanitizeFilename", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\x\\scan.pdf", "scan.pdf"],
    ["..hidden.pdf", "hidden.pdf"],
    ["a\u0000b\n.pdf", "a_b_.pdf"],
    ["", "unnamed"],
    ["...", "unnamed"],
    ["rm -rf `x`; $(y).pdf", "rm -rf _x__ _(y).pdf"],
  ])("%j -> %j", (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });
  it("truncates long names but keeps the extension", () => {
    const out = sanitizeFilename("a".repeat(500) + ".pdf");
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith(".pdf")).toBe(true);
  });
});
