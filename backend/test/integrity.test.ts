import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import type { IntegrityReport, UploadResponse } from "@contracts/api";
import type { ManifestEntry } from "../src/services/manifest.js";
import { FIXTURES_DIR, agentWithCase, expectMatchesContract, testApp } from "./helpers.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const original = (name: string) => readFile(path.join(FIXTURES_DIR, "originals", name));

/** CASE-001 with the three fixture originals stored (no analysis needed: integrity only looks at the stored files). */
async function stored() {
  const t = await testApp();
  const agent = await agentWithCase(t.app);
  const files = ["D-01.png", "D-02.png", "D-03.pdf"];
  const req = agent.post("/api/v1/cases/CASE-001/documents");
  for (const f of files) req.attach("files", await original(f), f);
  const up = (await req.expect(202)).body as UploadResponse;
  const docs = up.documents.map((d) => d.docId);
  const fileOf = (i: number) => t.deps.storage.originalAbsPath(docs[i]!, files[i]!.split(".").pop()!);
  const check = async () => (await agent.get("/api/v1/cases/CASE-001/integrity").expect(200)).body as IntegrityReport;
  const manifestPath = t.deps.manifest.filePath;
  return { ...t, agent, docs, files, fileOf, check, manifestPath };
}

/** The stored originals are read-only, so a tamper has to make them writable first. */
async function tamper(file: string, content: Buffer) {
  await chmod(file, 0o644);
  await writeFile(file, content);
}

describe("GET /cases/:id/integrity", () => {
  it("PASS for untouched files: expected equals actual equals the real hash of what was uploaded", async () => {
    const { agent, docs, files, check } = await stored();
    const res = await agent.get("/api/v1/cases/CASE-001/integrity").expect(200);
    expectMatchesContract("IntegrityReport", res.body);
    const report = res.body as IntegrityReport;
    expect(report.status).toBe("PASS");
    expect(report.caseId).toBe("CASE-001");
    expect(new Date(report.checkedAt).toString()).not.toBe("Invalid Date");
    expect(report.documents.map((d) => d.docId)).toEqual(docs);
    for (const [i, d] of report.documents.entries()) {
      const expected = sha(await original(files[i]!));
      expect(d).toEqual({ docId: docs[i], expectedSha256: expected, actualSha256: expected, status: "PASS" });
    }
    expect((await check()).status).toBe("PASS"); // stateless: asking again gives the same answer
  });

  it("a modified stored file is detected: that document FAILs with both hashes, the others still PASS, the case FAILs", async () => {
    const t = await stored();
    const orig = await readFile(t.fileOf(1));
    const altered = Buffer.from(orig);
    altered[altered.length - 1] = altered[altered.length - 1]! ^ 0xff; // one byte
    await tamper(t.fileOf(1), altered);

    const report = await t.check();
    expectMatchesContract("IntegrityReport", report);
    expect(report.status).toBe("FAIL");
    expect(report.documents.map((d) => d.status)).toEqual(["PASS", "FAIL", "PASS"]);
    const bad = report.documents[1]!;
    expect(bad.expectedSha256).toBe(sha(orig));
    expect(bad.actualSha256).toBe(sha(altered));
    expect(bad.actualSha256).not.toBe(bad.expectedSha256);
  });

  it("restoring the original bytes makes it PASS again (it always reads the file as it is now)", async () => {
    const t = await stored();
    const orig = await readFile(t.fileOf(0));
    await tamper(t.fileOf(0), Buffer.from("something else entirely"));
    expect((await t.check()).status).toBe("FAIL");
    await tamper(t.fileOf(0), orig);
    expect((await t.check()).status).toBe("PASS");
  });

  it("a deleted file FAILs with actualSha256 null", async () => {
    const t = await stored();
    await chmod(t.fileOf(2), 0o644);
    await rm(t.fileOf(2));
    const report = await t.check();
    expect(report.status).toBe("FAIL");
    expect(report.documents[2]).toMatchObject({ docId: t.docs[2], actualSha256: null, status: "FAIL" });
    expect(report.documents[2]!.expectedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.documents.slice(0, 2).every((d) => d.status === "PASS")).toBe(true);
  });

  it("a rewritten manifest hash is detected (the file is fine, the audit record was changed)", async () => {
    const t = await stored();
    const manifest = JSON.parse(await readFile(t.manifestPath, "utf8")) as ManifestEntry[];
    manifest[0]!.sha256 = "0".repeat(64);
    await writeFile(t.manifestPath, JSON.stringify(manifest));
    const report = await t.check();
    expect(report.status).toBe("FAIL");
    expect(report.documents[0]).toMatchObject({ expectedSha256: "0".repeat(64), status: "FAIL" });
    expect(report.documents[0]!.actualSha256).not.toBe("0".repeat(64));
    expect(report.documents.slice(1).every((d) => d.status === "PASS")).toBe(true);
  });

  it("a document missing from the manifest FAILs (nothing to verify it against)", async () => {
    const t = await stored();
    const manifest = (JSON.parse(await readFile(t.manifestPath, "utf8")) as ManifestEntry[]).filter((e) => e.docId !== t.docs[1]);
    await writeFile(t.manifestPath, JSON.stringify(manifest));
    const report = await t.check();
    expect(report.status).toBe("FAIL");
    expect(report.documents[1]).toMatchObject({ docId: t.docs[1], expectedSha256: "", status: "FAIL" });
    expect(report.documents[1]!.actualSha256).toMatch(/^[0-9a-f]{64}$/); // the file is there and is hashed anyway
  });

  it("an unreadable manifest is a loud FAIL for every document, not a 500", async () => {
    const t = await stored();
    await writeFile(t.manifestPath, "{ this is not json");
    const res = await t.agent.get("/api/v1/cases/CASE-001/integrity").expect(200);
    expectMatchesContract("IntegrityReport", res.body);
    const report = res.body as IntegrityReport;
    expect(report.status).toBe("FAIL");
    expect(report.documents).toHaveLength(3);
    for (const d of report.documents) expect(d).toMatchObject({ expectedSha256: "", status: "FAIL" });
  });

  it("a manifest storedAs pointing elsewhere cannot make it hash a different file", async () => {
    const t = await stored();
    const manifest = JSON.parse(await readFile(t.manifestPath, "utf8")) as ManifestEntry[];
    manifest[0]!.storedAs = "../../../../etc/passwd";
    await writeFile(t.manifestPath, JSON.stringify(manifest));
    const report = await t.check();
    // the real file is still found by docId and compared with the (unchanged) manifest hash: that is correct, and nothing outside DATA_DIR is read
    expect(report.documents[0]!.actualSha256).toBe(sha(await original("D-01.png")));
    // a wrong extension in storedAs is treated the same way: the content is what is verified
    manifest[0]!.storedAs = `evidence/${t.docs[0]}/original.exe`;
    await writeFile(t.manifestPath, JSON.stringify(manifest));
    expect((await t.check()).documents[0]!.actualSha256).toBe(sha(await original("D-01.png")));
  });

  it("hashes large files correctly (streamed)", async () => {
    const t = await testApp();
    const agent = await agentWithCase(t.app);
    const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(6 * 1024 * 1024, 0x41)]);
    await agent.post("/api/v1/cases/CASE-001/documents").attach("files", big, "big.pdf").expect(202);
    const report = (await agent.get("/api/v1/cases/CASE-001/integrity").expect(200)).body as IntegrityReport;
    expect(report.status).toBe("PASS");
    expect(report.documents[0]!.actualSha256).toBe(sha(big));
  });

  it("only covers the documents of that case", async () => {
    const t = await stored();
    await t.agent.post("/api/v1/cases").send({ title: "other" }).expect(201);
    await t.agent.post("/api/v1/cases/CASE-002/documents").attach("files", await original("D-11.png"), "x.png").expect(202);
    await tamper(t.deps.storage.originalAbsPath((await t.deps.documents.listByCase("CASE-002"))[0]!.docId, "png"), Buffer.from("changed"));
    expect((await t.check()).status).toBe("PASS"); // CASE-001 is unaffected by CASE-002's tampered file
    const other = (await t.agent.get("/api/v1/cases/CASE-002/integrity").expect(200)).body as IntegrityReport;
    expect(other.status).toBe("FAIL");
    expect(other.documents).toHaveLength(1);
  });

  it("a case with no documents has nothing that failed: PASS with an empty list", async () => {
    const t = await testApp();
    const agent = await agentWithCase(t.app);
    const res = await agent.get("/api/v1/cases/CASE-001/integrity").expect(200);
    expectMatchesContract("IntegrityReport", res.body);
    expect(res.body).toMatchObject({ caseId: "CASE-001", status: "PASS", documents: [] });
  });

  it("404 for an unknown case, 400 for a malformed id, 401 without login", async () => {
    const t = await testApp();
    const agent = await agentWithCase(t.app);
    expect((await agent.get("/api/v1/cases/CASE-404/integrity").expect(404)).body.error.code).toBe("CASE_NOT_FOUND");
    await agent.get("/api/v1/cases/.hidden/integrity").expect(400);
    expect((await request(t.app).get("/api/v1/cases/CASE-001/integrity")).status).toBe(401);
  });

  it("never modifies anything: the manifest and the stored files are byte-identical after any number of checks", async () => {
    const t = await stored();
    const before = [await readFile(t.manifestPath), ...(await Promise.all(t.docs.map((_, i) => readFile(t.fileOf(i)))))];
    for (let i = 0; i < 3; i++) await t.check();
    const after = [await readFile(t.manifestPath), ...(await Promise.all(t.docs.map((_, i) => readFile(t.fileOf(i)))))];
    expect(after).toEqual(before);
  });
});
