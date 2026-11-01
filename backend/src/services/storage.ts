import { chmod, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";

export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_ID = SAFE_ID_RE;
const SAFE_EXT = /^[a-z0-9]{2,5}$/;

export function assertSafeId(id: string, what = "id"): void {
  if (!SAFE_ID.test(id)) throw new AppError(400, "INVALID_ID", `Invalid ${what}`);
}

/**
 * Filesystem layout (DATA_DIR):
 *   evidence/<docId>/original.<ext>   write-once, read-only
 *   derived/<docId>/...               renders and other derivatives
 *   records/                          JSON records (later batches)
 *   audit/manifest.json, events.jsonl
 * Paths are built only from validated ids and a validated extension.
 */
export class Storage {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.resolve(dataDir);
  }

  get auditDir(): string {
    return path.join(this.root, "audit");
  }
  get recordsDir(): string {
    return path.join(this.root, "records");
  }

  /** Relative path (from the data root) of an original; stable and recorded in the manifest. */
  originalRelPath(docId: string, ext: string): string {
    assertSafeId(docId, "docId");
    if (!SAFE_EXT.test(ext)) throw new AppError(400, "INVALID_EXTENSION", "Invalid extension");
    return path.posix.join("evidence", docId, `original.${ext}`);
  }

  originalAbsPath(docId: string, ext: string): string {
    return path.join(this.root, ...this.originalRelPath(docId, ext).split("/"));
  }

  async derivedDir(docId: string): Promise<string> {
    assertSafeId(docId, "docId");
    const dir = path.join(this.root, "derived", docId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** Absolute path of a file inside a document's derived folder. The name is a fixed pattern, never user input. */
  derivedFile(docId: string, name: string): string {
    assertSafeId(docId, "docId");
    if (!/^page-[1-9][0-9]{0,3}\.png$/.test(name)) throw new AppError(400, "INVALID_NAME", "Invalid derived file name");
    return path.join(this.root, "derived", docId, name);
  }

  /**
   * Writes an original exactly once. The 'wx' flag makes the OS refuse if the file exists,
   * so an existing original can never be replaced, even by a race. The file is then made read-only.
   */
  async writeOriginal(docId: string, ext: string, data: Buffer): Promise<string> {
    const abs = this.originalAbsPath(docId, ext);
    await mkdir(path.dirname(abs), { recursive: true });
    let handle;
    try {
      handle = await open(abs, "wx", 0o444);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new AppError(409, "EVIDENCE_EXISTS", "An original already exists for this document id");
      }
      throw err;
    }
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(abs, 0o444);
    return this.originalRelPath(docId, ext);
  }

  /** Only for rolling back a write this process just made (e.g. the manifest append failed). */
  async discardJustWritten(docId: string, ext: string): Promise<void> {
    const abs = this.originalAbsPath(docId, ext);
    await chmod(abs, 0o644).catch(() => undefined);
    await rm(abs, { force: true });
    await rm(path.dirname(abs), { force: true, recursive: false }).catch(() => undefined);
  }
}
