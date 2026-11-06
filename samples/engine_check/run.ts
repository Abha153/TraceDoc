// Runs the real reasoning engine over the inputs written by make_inputs.py.
//   cd backend/src/engine && npm ci && npx tsx ../../../samples/engine_check/run.ts <inputsDir> <results.json>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { runReasoning } from "../../backend/src/engine/index";

const [inDir, outFile] = process.argv.slice(2);
if (!inDir || !outFile) throw new Error("usage: run.ts <inputsDir> <results.json>");
const results: Record<string, unknown> = {};
for (const file of readdirSync(inDir).filter((f) => f.endsWith(".json")).sort()) {
  const { caseId, documents } = JSON.parse(readFileSync(`${inDir}/${file}`, "utf8"));
  const out = runReasoning({ caseId, documents });
  results[caseId] = {
    findings: out.findings.map((f) => ({
      type: f.type, category: f.category, observationStatus: f.observationStatus, severity: f.severity,
      docs: [...new Set(f.evidence.flatMap((e) => e.regions.map((r) => r.docId)))].sort(),
    })),
    entities: out.entities.map((e) => ({ role: e.role, resolution: e.resolution, assertions: e.assertionIds.length })),
    priorityBand: out.priority.perCase?.priorityBand ?? null,
  };
}
writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log(`ran ${Object.keys(results).length} cases`);
