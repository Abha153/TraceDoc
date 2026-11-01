// Generates JSON Schemas from the TypeScript contracts so the two never drift.
import { createGenerator } from "ts-json-schema-generator";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  { type: "AnalyzeResponse", out: "analyze.schema.json", title: "AnalyzeResponse" },
  { type: "ComparabilityRule", out: "comparability.schema.json", title: "ComparabilityRule" },
  { type: "OcrPage", out: "ocr.schema.json", title: "OcrPage" },
];
for (const t of targets) {
  const schema = createGenerator({
    path: resolve(root, "index.ts"),
    tsconfig: resolve(root, "tsconfig.json"),
    type: t.type,
    expose: "export",
    topRef: t.type !== "*",
    additionalProperties: false,
    skipTypeCheck: false,
  }).createSchema(t.type);
  schema.title = t.title;
  writeFileSync(resolve(root, t.out), JSON.stringify(schema, null, 2) + "\n");
  console.log("wrote", t.out);
}

// Bundle: every exported contract type as a definition (merged one root at a time, because the
// generator's "*" mode silently drops some interfaces).
const roots = [
  "AnalyzeResponse", "ComparabilityRule", "OcrPage", "ReasoningInput", "ReasoningOutput", "Job",
  "DocumentRecord", "InvestigationEvent", "Finding", "Entity", "DocumentAssertion", "ForensicSignal",
  "RegionEvent", "PriorityOutput", "StructuredExplanation", "ReviewStatus", "ObservationStatus",
];
const bundle = { $schema: "http://json-schema.org/draft-07/schema#", title: "TraceDocs contracts (all types as definitions)", definitions: {} };
for (const name of roots) {
  const s = createGenerator({
    path: resolve(root, "index.ts"), tsconfig: resolve(root, "tsconfig.json"),
    type: name, expose: "export", topRef: true, additionalProperties: false,
  }).createSchema(name);
  Object.assign(bundle.definitions, s.definitions);
}
writeFileSync(resolve(root, "contracts.schema.json"), JSON.stringify(bundle, null, 2) + "\n");
console.log("wrote contracts.schema.json");
