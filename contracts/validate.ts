/**
 * Validates every fixture against the contract schemas and checks cross-references, box geometry,
 * OCR/field agreement, hashes and the expected (non-)findings. Fails loudly (exit code 1).
 * Run: npm run validate   (from contracts/)
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AnalyzeResponse, CaseFixture, Finding, GraphResponse, OcrPage, ReasoningOutput, Region,
} from "./index";

const root = dirname(fileURLToPath(import.meta.url));
const fx = resolve(root, "fixtures");
const read = <T>(p: string): T => JSON.parse(readFileSync(resolve(fx, p), "utf8")) as T;
const bundle = JSON.parse(readFileSync(resolve(root, "contracts.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const errors: string[] = [];
const fail = (m: string) => errors.push(m);
let checks = 0;
const ok = (cond: boolean, msg: string) => { checks++; if (!cond) fail(msg); };

function schemaCheck(type: string, file: string, data: unknown) {
  const v = ajv.compile({ definitions: bundle.definitions, $ref: `#/definitions/${type}` });
  checks++;
  if (!v(data)) fail(`${file}: not a valid ${type}: ${JSON.stringify(v.errors?.slice(0, 3))}`);
}

const CASES: Record<string, string[]> = { "CASE-001": ["D-01", "D-02", "D-03"], "CASE-002": ["D-11", "D-12", "D-13"] };
const inUnit = (b: number[]) => b.length === 4 && b.every((v) => v >= 0 && v <= 1) && b[0] + b[2] <= 1.0001 && b[1] + b[3] <= 1.0001 && b[2] > 0 && b[3] > 0;
const overlap = (a: number[], b: number[]) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const centerIn = (w: number[], box: number[]) => {
  const cx = w[0] + w[2] / 2, cy = w[1] + w[3] / 2;
  return cx >= box[0] && cx <= box[0] + box[2] && cy >= box[1] && cy <= box[1] + box[3];
};

// ---------------------------------------------------------------- per-document files
const ocrByDoc: Record<string, OcrPage[]> = {};
const analyzeByDoc: Record<string, AnalyzeResponse> = {};
for (const docs of Object.values(CASES)) for (const docId of docs) {
  const a = read<AnalyzeResponse>(`analyze/${docId}.json`);
  analyzeByDoc[docId] = a;
  schemaCheck("AnalyzeResponse", `analyze/${docId}.json`, a);
  ocrByDoc[docId] = [];
  for (const p of a.pages) {
    const img = resolve(fx, `pages/${docId}-page-${p.page}.png`);
    ok(existsSync(img), `missing page image for ${docId} page ${p.page}`);
    ok(p.renderPath.endsWith(`pages/${docId}-page-${p.page}.png`), `${docId}: renderPath does not point at the page image`);
    const ocr = read<OcrPage>(`ocr/${docId}-page-${p.page}.json`);
    schemaCheck("OcrPage", `ocr/${docId}-page-${p.page}.json`, ocr);
    ocrByDoc[docId].push(ocr);
    ocr.words.forEach((w, i) => ok(inUnit(w.bbox) && w.lineIndex < ocr.lines.length, `${docId} ocr word ${i} bad box or lineIndex`));
    ocr.lines.forEach((l, i) => ok(inUnit(l.bbox) && l.wordIndices.every((k) => k < ocr.words.length), `${docId} ocr line ${i} bad`));
  }
  // every field box must sit on exactly the OCR words that spell its raw value
  for (const f of a.fields) {
    ok(inUnit(f.region.bbox), `${f.fieldId}: bbox outside 0..1`);
    const ocr = ocrByDoc[docId].find((o) => o.page === f.region.page);
    if (!ocr) { fail(`${f.fieldId}: no OCR page`); continue; }
    const text = ocr.words.filter((w) => centerIn(w.bbox, f.region.bbox)).map((w) => w.text).join(" ");
    ok(text === f.rawValue, `${f.fieldId} (${f.name}): box covers OCR text "${text}" but rawValue is "${f.rawValue}"`);
    ok(f.ocrConfidence >= 0 && f.ocrConfidence <= 1 && f.extractionConfidence >= 0 && f.extractionConfidence <= 1, `${f.fieldId}: confidence out of range`);
  }
  // signal boxes must overlap visible OCR text
  for (const s of a.signals) for (const r of s.regions) {
    ok(inUnit(r.bbox), `${s.signalId}: bbox outside 0..1`);
    const ocr = ocrByDoc[docId].find((o) => o.page === r.page)!;
    ok(ocr.words.some((w) => overlap(w.bbox, r.bbox)), `${s.signalId}: region does not overlap any OCR word`);
  }
  // a NOT_APPLICABLE or UNAVAILABLE analyzer must never have produced signals (missing is not clean)
  for (const s of a.signals) ok(a.analyzerStatuses[s.detector] === "AVAILABLE", `${s.signalId}: detector ${s.detector} is not AVAILABLE`);
}

// ---------------------------------------------------------------- per-case files
const expectedF = read<Record<string, any[]>>("expected_findings.json");
const expectedN = read<Record<string, any[]>>("expected_non_findings.json");
for (const [caseId, docIds] of Object.entries(CASES)) {
  const reasoning = read<ReasoningOutput>(`${caseId}.reasoning.json`);
  const bundleCase = read<CaseFixture>(`${caseId}.case.json`);
  const graph = read<GraphResponse>(`${caseId}.graph.json`);
  schemaCheck("ReasoningOutput", `${caseId}.reasoning.json`, reasoning);
  schemaCheck("CaseFixture", `${caseId}.case.json`, bundleCase);
  schemaCheck("GraphResponse", `${caseId}.graph.json`, graph);

  const docSet = new Set(docIds);
  const assertionIds = new Set(reasoning.assertions.map((a) => a.assertionId));
  ok(assertionIds.size === reasoning.assertions.length, `${caseId}: duplicate assertionIds`);
  const fieldIds = new Set(docIds.flatMap((d) => analyzeByDoc[d].fields.map((f) => f.fieldId)));
  const entityIds = new Set(reasoning.entities.map((e) => e.entityId));
  const regionOf = new Map<string, Region>();
  for (const a of reasoning.assertions) {
    regionOf.set(a.assertionId, a.region);
    ok(docSet.has(a.docId) && fieldIds.has(a.fieldId), `${a.assertionId}: unknown doc or field`);
    ok(a.entityId === null || entityIds.has(a.entityId), `${a.assertionId}: unknown entity`);
    const f = analyzeByDoc[a.docId].fields.find((x) => x.fieldId === a.fieldId)!;
    ok(JSON.stringify(f.region) === JSON.stringify(a.region), `${a.assertionId}: region differs from its field`);
    ok(f.normalizedValue === a.normalizedValue, `${a.assertionId}: value differs from its field`);
  }
  for (const e of reasoning.entities) e.assertionIds.forEach((id) => ok(assertionIds.has(id), `${e.entityId}: unknown assertion ${id}`));
  for (const e of reasoning.entities) {
    ok((e.resolution === "SUGGESTED") === !!e.suggestedLinks?.length, `${e.entityId}: suggestedLinks must exist exactly when resolution is SUGGESTED`);
    (e.suggestedLinks ?? []).forEach((l) => ok(entityIds.has(l.entityId) && l.entityId !== e.entityId, `${e.entityId}: suggestedLink to unknown or same entity`));
    ok(e.resolution !== "RESOLVED" || e.basis.some((b) => /exact match/.test(b)), `${e.entityId}: RESOLVED needs an exact-match basis`);
  }
  const assigned = reasoning.entities.flatMap((e) => e.assertionIds);
  ok(new Set(assigned).size === assigned.length, `${caseId}: an assertion belongs to two entities`);

  const findingIds = new Set(reasoning.findings.map((f) => f.findingId));
  ok(findingIds.size === reasoning.findings.length, `${caseId}: duplicate findingIds`);
  const evIds = reasoning.findings.flatMap((f) => f.evidence.map((e) => e.evidenceId));
  ok(new Set(evIds).size === evIds.length, `${caseId}: duplicate evidenceIds`);
  const signalIds = new Set(docIds.flatMap((d) => analyzeByDoc[d].signals.map((s) => s.signalId)));
  for (const f of reasoning.findings) {
    ok(f.caseId === caseId, `${f.findingId}: wrong caseId`);
    ok(f.confidence >= 0 && f.confidence <= 1, `${f.findingId}: confidence out of range`);
    ok(f.needsVerification.length > 0, `${f.findingId}: needsVerification is empty`);
    for (const e of f.evidence) {
      for (const r of e.regions) {
        ok(docSet.has(r.docId) && inUnit(r.bbox), `${e.evidenceId}: bad region`);
        const ocr = ocrByDoc[r.docId].find((o) => o.page === r.page)!;
        ok(ocr.words.some((w) => overlap(w.bbox, r.bbox)), `${e.evidenceId}: region does not overlap any OCR word`);
      }
      (e.assertionIds ?? []).forEach((id) => ok(assertionIds.has(id), `${e.evidenceId}: unknown assertion ${id}`));
      if (e.kind === "assertion_pair") {
        ok((e.assertionIds ?? []).length === 2 && e.regions.length === 2, `${e.evidenceId}: assertion_pair needs two assertions and two regions`);
        (e.assertionIds ?? []).forEach((id, i) => ok(JSON.stringify(regionOf.get(id)) === JSON.stringify(e.regions[i]), `${e.evidenceId}: region ${i} is not its assertion's region`));
      }
    }
    // honesty rules: no intent language anywhere in a finding
    const blob = JSON.stringify(f).toLowerCase();
    for (const bad of ["forged", "fraudulent", "intentionally", "deliberately", "fake"]) ok(!blob.includes(bad), `${f.findingId}: contains banned word "${bad}"`);
    if (f.observationStatus === "OBSERVED") fail(`${f.findingId}: findings are INCONSISTENT or POTENTIAL_ANOMALY`);
  }
  for (const ev of reasoning.events) {
    ev.signalIds.forEach((id) => ok(signalIds.has(id), `${ev.eventId}: unknown signal ${id}`));
    ok(ev.confidence <= 1, `${ev.eventId}: confidence above 1`);
  }
  // priority
  const pr = reasoning.priority;
  for (const r of [pr.perCase, ...Object.values(pr.perDocument)]) {
    r.contributingFindingIds.forEach((id) => ok(findingIds.has(id), `priority references unknown finding ${id}`));
    ok(r.coverage >= 0 && r.coverage <= 1 && r.confidence >= 0 && r.confidence <= 1, "priority confidence/coverage out of range");
  }
  ok(Object.keys(pr.perDocument).sort().join() === [...docIds].sort().join(), `${caseId}: perDocument keys`);

  // case bundle: hashes, jobs, statuses
  for (const d of bundleCase.documents) {
    const orig = readdirSync(resolve(fx, "originals")).find((n: string) => n.startsWith(`${d.docId}.`));
    ok(!!orig, `${d.docId}: missing original file`);
    if (orig) ok(createHash("sha256").update(readFileSync(resolve(fx, "originals", orig))).digest("hex") === d.sha256, `${d.docId}: sha256 does not match original`);
    ok(JSON.stringify(d.processing) === JSON.stringify(analyzeByDoc[d.docId].analyzerStatuses), `${d.docId}: processing differs from analyzerStatuses`);
    const job = bundleCase.jobs.find((j) => j.docId === d.docId)!;
    const bad = Object.values(d.processing).some((s) => s === "UNAVAILABLE" || s === "ERROR");
    ok(job.status === (bad ? "PARTIAL" : "DONE"), `${d.docId}: job status ${job.status} does not match analyzer statuses`);
  }
  const gids = new Set(graph.nodes.map((n) => n.id));
  graph.edges.forEach((e) => ok(gids.has(e.source) && gids.has(e.target) && (!e.findingId || findingIds.has(e.findingId)), `${caseId} graph edge ${e.id} dangling`));

  // expected findings must be present, expected non-findings absent
  const matches = (f: Finding, exp: any) => {
    if (f.type !== exp.type) return false;
    if (exp.assertionIds) {
      const have = new Set(f.evidence.flatMap((e) => e.assertionIds ?? []));
      return exp.assertionIds.every((id: string) => have.has(id));
    }
    if (exp.signalIds) {
      const ev = reasoning.events.find((e) => exp.signalIds.every((s: string) => e.signalIds.includes(s)));
      return !!ev && f.evidence.some((e) => String(e.measurements?.["eventId"]) === ev.eventId);
    }
    return true;
  };
  for (const exp of expectedF[caseId] ?? []) {
    const hit = reasoning.findings.filter((f) => matches(f, exp));
    ok(hit.length === 1, `${caseId} ${exp.expectedId}: expected exactly one ${exp.type} finding, found ${hit.length}`);
    const f = hit[0];
    if (f) {
      ok(f.severity === exp.severity && f.category === exp.category && f.observationStatus === exp.observationStatus, `${exp.expectedId}: severity/category/status differ`);
      if (exp.maxConfidence !== undefined) ok(f.confidence <= exp.maxConfidence, `${exp.expectedId}: confidence ${f.confidence} above cap ${exp.maxConfidence}`);
    }
  }
  ok(reasoning.findings.length === (expectedF[caseId] ?? []).length, `${caseId}: findings not covered by expected_findings.json (or missing)`);
  for (const nf of expectedN[caseId] ?? []) {
    nf.assertionIds.forEach((id: string) => ok(assertionIds.has(id), `${nf.nonFindingId}: unknown assertion ${id}`));
    const viol = reasoning.findings.filter((f) => {
      const have = new Set(f.evidence.flatMap((e) => e.assertionIds ?? []));
      return nf.assertionIds.every((id: string) => have.has(id)) && (nf.forbiddenTypes.includes("*") || nf.forbiddenTypes.includes(f.type));
    });
    ok(viol.length === 0, `${caseId} ${nf.nonFindingId} (${nf.description}) must NOT produce a finding, got ${viol.map((v) => v.findingId)}`);
  }
}

// ---------------------------------------------------------------- rule table (backend/config/comparability.json)
{
  const rules = JSON.parse(readFileSync(resolve(root, "../backend/config/comparability.json"), "utf8")) as Array<{ ruleId: string }>;
  rules.forEach((r) => schemaCheck("ComparabilityRule", `comparability.json ${r.ruleId}`, r));
  ok(new Set(rules.map((r) => r.ruleId)).size === rules.length, "comparability.json: duplicate ruleIds");
  const ids = new Set(rules.map((r) => r.ruleId));
  for (const file of ["expected_findings.json", "expected_non_findings.json"]) {
    for (const m of readFileSync(resolve(fx, file), "utf8").matchAll(/"ruleId": "(R-[A-Z-]+)"/g)) ok(ids.has(m[1] ?? ""), `${file}: rule ${m[1]} is not in comparability.json`);
  }
}

// ---------------------------------------------------------------- scenario guarantees
const r1 = read<ReasoningOutput>("CASE-001.reasoning.json");
const r2 = read<ReasoningOutput>("CASE-002.reasoning.json");
ok(r1.entities.find((e) => e.entityId === "E-001")?.resolution === "RESOLVED", "CASE-001 applicant must be RESOLVED");
ok(r2.entities.length === 2 && r2.entities.every((e) => e.resolution === "RESOLVED") && r2.entities[0].role !== r2.entities[1].role, "CASE-002: applicant and guarantor must stay two RESOLVED entities");
ok(r1.priority.perCase.coverage < 1 && r1.priority.perDocument["D-02"].coverage < 1, "CASE-001 must show an UNAVAILABLE analyzer as reduced coverage");

if (errors.length) {
  console.error(`\nFIXTURE VALIDATION FAILED (${errors.length} problem${errors.length > 1 ? "s" : ""}):`);
  errors.forEach((e) => console.error(" - " + e));
  process.exit(1);
}
console.log(`fixture validation passed (${checks} checks)`);
