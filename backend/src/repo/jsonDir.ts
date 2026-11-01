import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeId } from "../services/storage.js";
import { Mutex } from "../util/mutex.js";

/**
 * One JSON file per record in a directory. Writes go to a temp file and are renamed into place,
 * so a crash never leaves a half-written record. Ids are validated before they touch a path.
 */
export class JsonDir<T> {
  private readonly lock = new Mutex();

  constructor(private readonly dir: string) {}

  private file(id: string): string {
    assertSafeId(id);
    return path.join(this.dir, `${id}.json`);
  }

  async get(id: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  put(id: string, value: T): Promise<void> {
    const target = this.file(id);
    return this.lock.run(async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
      await rename(tmp, target);
    });
  }

  async list(): Promise<T[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: T[] = [];
    for (const n of names.filter((f) => f.endsWith(".json")).sort()) {
      out.push(JSON.parse(await readFile(path.join(this.dir, n), "utf8")) as T);
    }
    return out;
  }
}
