import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ManifestEntry {
  docId: string;
  caseId: string;
  filename: string;       // sanitized display name, never used as a path
  sha256: string;
  bytes: number;
  mimeType: string;
  storedAs: string;       // path relative to DATA_DIR
  receivedAt: string;     // ISO timestamp
}

/**
 * Append-only list of ingested originals at data/audit/manifest.json.
 * Appends are serialized in-process and written via temp file + rename, so a crash never
 * leaves a half-written manifest. A corrupt manifest is never overwritten: the append fails loudly.
 */
export class Manifest {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly auditDir: string) {}

  get filePath(): string {
    return path.join(this.auditDir, "manifest.json");
  }

  async list(): Promise<ManifestEntry[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const parsed: unknown = JSON.parse(text); // throws on corruption, deliberately
    if (!Array.isArray(parsed)) throw new Error("manifest.json is not an array");
    return parsed as ManifestEntry[];
  }

  append(entries: ManifestEntry[]): Promise<void> {
    const run = async () => {
      const existing = await this.list();
      const known = new Set(existing.map((e) => e.docId));
      for (const e of entries) {
        if (known.has(e.docId)) throw new Error(`manifest already has docId ${e.docId}`);
      }
      await mkdir(this.auditDir, { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify([...existing, ...entries], null, 2) + "\n", "utf8");
      await rename(tmp, this.filePath);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
