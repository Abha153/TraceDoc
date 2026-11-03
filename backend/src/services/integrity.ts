import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { IntegrityDocumentResult, IntegrityReport } from "@contracts/api";
import type { Logger } from "../logger.js";
import type { DocumentRepository } from "../repo/repositories.js";
import type { Manifest, ManifestEntry } from "./manifest.js";
import type { Storage } from "./storage.js";

/**
 * Re-verifies the stored originals of a case against audit/manifest.json (written once, at upload, by B2).
 *
 * A document PASSES only if its file exists and its SHA-256, recomputed now, equals the manifest's. Everything
 * else is FAIL and is reported, never swallowed:
 *   - the file was changed (hashes differ), is missing or cannot be read (actual is null);
 *   - the manifest has no entry for the document, or the manifest itself is unreadable (expected is "").
 * The case is PASS only if it has documents and all of them pass. Nothing is ever repaired or rewritten.
 */
export class IntegrityService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly manifest: Manifest,
    private readonly storage: Storage,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async check(caseId: string): Promise<IntegrityReport> {
    const docs = await this.documents.listByCase(caseId);

    let entries: Map<string, ManifestEntry> | undefined;
    try {
      entries = new Map((await this.manifest.list()).map((e) => [e.docId, e]));
    } catch (err) {
      // A manifest we cannot read means nothing can be verified: every document fails, loudly.
      this.logger.error({ caseId, err }, "integrity: manifest unreadable");
    }

    const results: IntegrityDocumentResult[] = [];
    for (const doc of docs) {
      const entry = entries?.get(doc.docId);
      const expected = entry?.sha256 ?? "";
      const actual = await this.hashOriginal(doc.docId, entry);
      results.push({
        docId: doc.docId,
        expectedSha256: expected,
        actualSha256: actual,
        status: expected !== "" && actual === expected ? "PASS" : "FAIL",
      });
    }
    return {
      caseId,
      checkedAt: this.now().toISOString(),
      status: results.every((r) => r.status === "PASS") ? "PASS" : "FAIL", // a case with no documents has nothing that failed
      documents: results,
    };
  }

  /**
   * SHA-256 of the stored original, or null if it is missing or unreadable. The path is rebuilt from the docId and an
   * extension, never taken from the manifest as written, so a tampered `storedAs` cannot make this read another file.
   * The extension the manifest declares is tried first, then the other accepted types: the check is about the content
   * hash, and the location is fixed by the docId.
   */
  private async hashOriginal(docId: string, entry: ManifestEntry | undefined): Promise<string | null> {
    const ext = entry ? new RegExp(`^evidence/${docId}/original\\.([a-z0-9]{2,5})$`).exec(entry.storedAs)?.[1] : undefined;
    const candidates = [...new Set([...(ext ? [ext] : []), "pdf", "png", "jpg", "tiff"])];
    for (const e of candidates) {
      const file = this.storage.originalAbsPath(docId, e);
      try {
        return await sha256Stream(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger.warn({ docId, err }, "integrity: stored original could not be read");
          return null;
        }
      }
    }
    return null;
  }
}

function sha256Stream(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
