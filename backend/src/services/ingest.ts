import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../errors.js";
import { detectFileType, type DetectedType } from "./fileType.js";
import { sanitizeFilename } from "./filename.js";
import type { Manifest, ManifestEntry } from "./manifest.js";
import type { Storage } from "./storage.js";

export interface IncomingFile {
  originalname: string;
  buffer: Buffer;
}

export interface IngestedDocument {
  docId: string;
  caseId: string;
  filename: string;
  sha256: string;
  bytes: number;
  mimeType: string;
}

export function newDocId(): string {
  return `D-${randomBytes(6).toString("hex")}`;
}

export class IngestService {
  constructor(
    private readonly storage: Storage,
    private readonly manifest: Manifest,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Validates every file first, so a bad file rejects the whole request and nothing is written.
   * Then stores each original write-once, hashes it, and appends to the manifest.
   */
  async ingest(caseId: string, files: IncomingFile[]): Promise<IngestedDocument[]> {
    if (files.length === 0) throw new AppError(400, "NO_FILES", "No files were uploaded");

    const rejected: { filename: string; reason: string }[] = [];
    const checked: { file: IncomingFile; type: DetectedType; filename: string }[] = [];
    for (const file of files) {
      const filename = sanitizeFilename(file.originalname);
      const type = detectFileType(file.buffer);
      if (!type) {
        rejected.push({ filename, reason: "Unsupported or unrecognised file content (PDF, PNG, JPEG or TIFF only)" });
      } else {
        checked.push({ file, type, filename });
      }
    }
    if (rejected.length > 0) {
      const list = rejected.map((r) => `${r.filename}: ${r.reason}`).join("; ");
      throw new AppError(400, "UNSUPPORTED_FILE_TYPE", `Nothing was stored. ${list}`, rejected);
    }

    const written: { docId: string; ext: string }[] = [];
    const entries: ManifestEntry[] = [];
    try {
      for (const { file, type, filename } of checked) {
        const docId = newDocId();
        const storedAs = await this.storage.writeOriginal(docId, type.ext, file.buffer);
        written.push({ docId, ext: type.ext });
        entries.push({
          docId,
          caseId,
          filename,
          sha256: createHash("sha256").update(file.buffer).digest("hex"),
          bytes: file.buffer.length,
          mimeType: type.mimeType,
          storedAs,
          receivedAt: this.now().toISOString(),
        });
      }
      await this.manifest.append(entries);
    } catch (err) {
      // Nothing is recorded in the manifest, so roll back the originals written by this request.
      await Promise.all(written.map((w) => this.storage.discardJustWritten(w.docId, w.ext)));
      throw err;
    }

    return entries.map(({ docId, caseId: c, filename, sha256, bytes, mimeType }) => ({
      docId,
      caseId: c,
      filename,
      sha256,
      bytes,
      mimeType,
    }));
  }
}
