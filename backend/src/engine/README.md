# backend/src/engine

The reasoning engine: pure TypeScript modules, no I/O, deterministic. Owned by Person 1.
Own package so it never conflicts with `backend/package.json`:

```bash
cd backend/src/engine
npm install
npm test          # tsx --test *.test.ts, driven by contracts/fixtures
npm run typecheck
```

| Module | Batch | Status |
| --- | --- | --- |
| `assertions.ts` | B4 | done: `buildAssertions(fields, pages, caseId)`, plus exported normalizers |
| `entityResolver.ts`, `nameSimilarity.ts` | B5 | done: `resolveEntities(assertions)`, token-sort ratio |
| `comparability.ts`, `contextRules.ts`, `ruleSupport.ts`, `valueCompare.ts` | B6 | done: `evaluate(assertions, entities, options)` |
| `eventGrouper.ts`, `priorityEngine.ts` | B7 | done: `groupEvents`, `computePriority` |
| `index.ts`, `eventFindings.ts` | B7b | done: `runReasoning(input)` |

## B4 notes
- Canonical semantic types are the fixture field names (`full_name`, `dob`, `id_number`, `address_permanent`, ...). Extractor aliases
  such as `account_holder`, `closing_balance`, `total` map to them; unknown names pass through unchanged.
- A role prefix in the field name (`guarantor_`, `co_applicant_`, `nominee_`, `applicant_`) sets the provisional role.
- Dates parse day-first when both parts could be a month; two-digit years and impossible dates give `null`, never a guess.
- A value that cannot be normalized gives `normalizedValue: null`; the assertion is kept and downstream rules skip it.

## B5 notes
- Parties (one document, one provisional role) merge only on an exact `id_number`, then `account_number`. Name similarity never merges.
- A merge is refused when it would join two id_numbers or two specific roles (applicant, guarantor, ...); the reason goes into `basis`.
- A party without a cross-document identifier match that resembles exactly one compatible entity (ratio >= 92) is `SUGGESTED` and gets
  `suggestedLinks` (new optional field on `Entity`); B6 uses it to compare across the link with capped confidence.
- Typecheck uses the same strict flags as `backend/tsconfig.json` (`noUncheckedIndexedAccess`), because the backend typecheck includes `src/engine`.

## B6 notes
- Rule table: `backend/config/comparability.json` (validated by `contracts/comparability.schema.json`). Thresholds: `backend/config/engine.json`. Change them there, not in code.
- MUST_AGREE compares assertions of one entity across documents, and across a SUGGESTED link with confidence capped. Different RESOLVED entities are never compared.
- MAY_DIFFER / NOT_COMPARABLE never produce findings; they guard pairs of different semantic types that a broader rule would compare.
- ARITHMETIC (row amounts vs printed total, exact decimal arithmetic), TEMPORAL (`semanticTypes[0]` strictly before `[1]`) and UNIQUENESS (one identifier, one entity) are in `contextRules.ts`.
- An arithmetic check that cannot be done (unreadable or missing rows) yields an INCONCLUSIVE info finding, never silence.
- `evaluate` has no clock: pass `processedAt` and `docSha256` (docId -> SHA-256) for provenance. `nextIdStart(findings)` lets B7b continue the F-/E- numbering.

## B7 notes
- `groupEvents(documents, caseId, options)` takes `{ docId, signals }[]` (one entry per `AnalyzeResponse`), so document-level signals with no region still know their document.
  Signals cluster per document and page by region IoU >= `iouThreshold` (transitively). Event confidence = max member + `agreementBonus` per extra distinct detector family, capped at 1.
  A region-less signal is its own event with `page: 0`. `categoryOfDetectors()` tells B7b whether an event's finding is `visual` or `pdf_structure`.
- `computePriority({ findings, analyzerStatuses }, options)` returns `{ perCase, perDocument, provenance }`. Noisy-OR within a category, weighted noisy-OR across categories,
  weak-evidence cap (info/low only) per category and overall, coverage reported but never changing the score or band. Result is named priority, never risk.
- All weights, thresholds and detector families are in `backend/config/engine.json` and echoed into provenance. Like `evaluate`, both functions take `docSha256` and `processedAt` because the engine has no clock.
- `eventFinding` thresholds (medium from 0.4, high from 0.75) are already in the config for B7b's event-to-finding conversion.

## B7b notes: using the engine from the backend
```ts
import { runReasoning } from "../engine";               // backend/src/engine/index.ts
const output = runReasoning({ caseId, documents });     // documents: AnalyzeResponse[] (one per document of the case)
// output: { assertions, entities, findings, events, priority }  (contracts/reasoning.ts)
```
- Pure and deterministic: no I/O, no clock, no randomness. Provenance hashes and timestamps come from the documents' own provenance
  (first `inputSha256`, latest `processedAt`). Call it again after every analysis or re-run; same input gives the same output.
- Signals from analyzers whose status is `UNAVAILABLE`, `ERROR` or `NOT_APPLICABLE` are ignored, and all statuses feed priority coverage.
- Events become findings: several overlapping signals give one `REGION_EVENT`; a lone signal keeps its own type (e.g. `TEXT_LAYER_MISMATCH`).
  Status is always `POTENTIAL_ANOMALY`; severity comes from the event confidence (config); the finding links the fields lying under the flagged region.
- A document-level signal (no region) gets a whole-page evidence region labelled `document`, so it is shown and counted for its document.
- The engine reads `backend/config/*.json` (import, not file I/O at call time) and imports types from `../../../contracts`, so keep that repo layout.
- Finding and evidence ids (`F-0001`, `E-0001`) restart for every run. The evidence store namespaces them per generation.
