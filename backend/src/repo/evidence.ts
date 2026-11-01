import { chmod, link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentAssertion, Entity, Finding, ForensicSignal, PriorityOutput, RegionEvent } from "@contracts/types";
import type { ReasoningOutput } from "@contracts/reasoning";
import { AppError } from "../errors.js";
import { assertSafeId } from "../services/storage.js";
import { Mutex } from "../util/mutex.js";

/** Everything the reasoning engine produced for a case in one run, frozen. */
export interface GenerationRecord {
  caseId: string;
  generation: number;
  createdAt: string;
  assertions: DocumentAssertion[];
  entities: Entity[];
  findings: Finding[];
  events: RegionEvent[];
  signals: ForensicSignal[];
  priority: PriorityOutput;
}

export interface GenerationSummary {
  generation: number;
  createdAt: string;
  findingCount: number;
}

/**
 * Evidence store. Findings, evidence, assertions, entities, events and signals of a case are written as
 * generations. A generation is never modified or overwritten: a re-run writes the next one and the old
 * one stays on disk. Review state is not stored here (it is replayed from the event log, B9).
 */
export interface EvidenceRepository {
  /** Stores a reasoning run as the next generation and returns it. */
  put(caseId: string, output: ReasoningOutput, signals: ForensicSignal[]): Promise<GenerationRecord>;
  latest(caseId: string): Promise<GenerationRecord | undefined>;
  get(caseId: string, generation: number): Promise<GenerationRecord | undefined>;
  generations(caseId: string): Promise<GenerationSummary[]>;
  /** Looks a finding up by its store-wide id (see namespaceFindingId). Any generation, not only the latest. */
  findFinding(findingId: string): Promise<{ record: GenerationRecord; finding: Finding; isLatest: boolean } | undefined>;
}

/**
 * Engine finding ids (F-0001) repeat across cases and re-runs, but GET /findings/:findingId has no case in the
 * path, so the store makes them unique: <caseId>-g<generation>-<engine id>, e.g. CASE-001-g1-F-0001.
 * A new generation therefore starts with fresh, unreviewed findings; old reviews stay attached to the old ids.
 */
export function namespaceFindingId(caseId: string, generation: number, engineId: string): string {
  return `${caseId}-g${generation}-${engineId}`;
}

export function parseFindingId(findingId: string): { caseId: string; generation: number } | undefined {
  const m = /^(.+)-g(\d+)-[A-Za-z0-9][A-Za-z0-9_-]*$/.exec(findingId);
  return m ? { caseId: m[1]!, generation: Number(m[2]) } : undefined;
}

function applyNamespace(output: ReasoningOutput, caseId: string, generation: number): ReasoningOutput {
  const map = new Map(output.findings.map((f) => [f.findingId, namespaceFindingId(caseId, generation, f.findingId)]));
  const ids = (list: string[]) => list.map((id) => map.get(id) ?? id);
  const priority: PriorityOutput = {
    ...output.priority,
    perCase: { ...output.priority.perCase, contributingFindingIds: ids(output.priority.perCase.contributingFindingIds) },
    perDocument: Object.fromEntries(
      Object.entries(output.priority.perDocument).map(([doc, p]) => [doc, { ...p, contributingFindingIds: ids(p.contributingFindingIds) }]),
    ),
  };
  return {
    ...output,
    findings: output.findings.map((f) => ({ ...f, findingId: map.get(f.findingId)! })),
    priority,
  };
}

const genFile = (n: number) => `gen-${String(n).padStart(4, "0")}.json`;

export class JsonEvidenceRepository implements EvidenceRepository {
  private readonly lock = new Mutex();

  constructor(
    private readonly recordsDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private dir(caseId: string): string {
    assertSafeId(caseId, "caseId");
    return path.join(this.recordsDir, "evidence", caseId);
  }

  private async numbers(caseId: string): Promise<number[]> {
    let names: string[];
    try {
      names = await readdir(this.dir(caseId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names
      .map((n) => /^gen-(\d{4,})\.json$/.exec(n)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  put(caseId: string, output: ReasoningOutput, signals: ForensicSignal[]): Promise<GenerationRecord> {
    return this.lock.run(async () => {
      const dir = this.dir(caseId);
      await mkdir(dir, { recursive: true });
      const generation = ((await this.numbers(caseId)).at(-1) ?? 0) + 1;
      const namespaced = applyNamespace(output, caseId, generation);
      const record: GenerationRecord = {
        caseId,
        generation,
        createdAt: this.now().toISOString(),
        assertions: namespaced.assertions,
        entities: namespaced.entities,
        findings: namespaced.findings,
        events: namespaced.events,
        signals,
        priority: namespaced.priority,
      };
      // Write to a temp file, then hard-link it into place. link() fails with EEXIST if the target exists,
      // so an existing generation can never be replaced, and a crash never leaves a half-written generation.
      const target = path.join(dir, genFile(generation));
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
      try {
        await link(tmp, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new AppError(409, "EVIDENCE_EXISTS", `Generation ${generation} of ${caseId} already exists`);
        }
        throw err;
      } finally {
        await rm(tmp, { force: true });
      }
      await chmod(target, 0o444);
      return record;
    });
  }

  async get(caseId: string, generation: number): Promise<GenerationRecord | undefined> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(caseId), genFile(generation)), "utf8")) as GenerationRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async latest(caseId: string): Promise<GenerationRecord | undefined> {
    const last = (await this.numbers(caseId)).at(-1);
    return last === undefined ? undefined : this.get(caseId, last);
  }

  async generations(caseId: string): Promise<GenerationSummary[]> {
    const out: GenerationSummary[] = [];
    for (const n of await this.numbers(caseId)) {
      const r = await this.get(caseId, n);
      if (r) out.push({ generation: n, createdAt: r.createdAt, findingCount: r.findings.length });
    }
    return out;
  }

  async findFinding(findingId: string) {
    const parsed = parseFindingId(findingId);
    if (!parsed) return undefined;
    const record = await this.get(parsed.caseId, parsed.generation);
    const finding = record?.findings.find((f) => f.findingId === findingId);
    if (!record || !finding) return undefined;
    const latest = (await this.numbers(parsed.caseId)).at(-1);
    return { record, finding, isLatest: latest === record.generation };
  }
}
