// Validates sample objects against the generated schemas. Also checks that bad objects are rejected.
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(resolve(root, p), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

let failed = 0;
function expect(schemaFile, sampleFile, shouldPass, mutate) {
  const validate = ajv.compile(load(schemaFile));
  let data = load(sampleFile);
  if (mutate) data = mutate(data);
  const ok = validate(data);
  const good = ok === shouldPass;
  console.log(`${good ? "ok  " : "FAIL"} ${schemaFile} <- ${sampleFile}${shouldPass ? "" : " (must be rejected)"}`);
  if (!good) { failed++; if (shouldPass) console.log(JSON.stringify(validate.errors, null, 2)); }
}

expect("analyze.schema.json", "examples/analyze-response.sample.json", true);
expect("ocr.schema.json", "examples/ocr-page.sample.json", true);
expect("comparability.schema.json", "examples/comparability-rule.sample.json", true);
expect("analyze.schema.json", "examples/analyze-response.sample.json", false, (d) => { d.fields[0].extra = 1; return d; });
expect("analyze.schema.json", "examples/analyze-response.sample.json", false, (d) => { d.analyzerStatuses.ocr = "CLEAN"; return d; });
expect("comparability.schema.json", "examples/comparability-rule.sample.json", false, (d) => { d.ruleType = "SOMETIMES"; return d; });
expect("analyze.schema.json", "examples/analyze-response.sample.json", false, (d) => { d.fields[0].region.bbox = [0.1, 0.2, 0.3]; return d; });

// The bundle must expose every contract type, including the reasoning entry-point types.
const bundle = load("contracts.schema.json");
for (const name of ["ReasoningInput", "ReasoningOutput", "Job", "Finding", "ForensicSignal", "Entity", "PriorityOutput", "OcrPage", "InvestigationEvent"]) {
  const present = !!bundle.definitions[name];
  console.log(`${present ? "ok  " : "FAIL"} contracts.schema.json defines ${name}`);
  if (!present) failed++;
}
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("all schema checks passed");
