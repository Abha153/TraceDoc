# contracts/

Source of truth shared by backend, ocr-service and frontend. Contract changes go through Person 1 only:
update this folder and the fixtures in one commit, then tell the affected owners.

| File | What it is |
| --- | --- |
| `types.ts` | Every interface from ARCHITECTURE.md section 5, plus `Job`, `ForensicSignal`, `AnalyzeResponse`, `RegionEvent`, `PriorityOutput`, `ComparabilityRule` |
| `ocr.ts` | `OcrWord`, `OcrLine`, `OcrPage`: OCR output with boxes normalized to the canonical render |
| `reasoning.ts` | `ReasoningInput`, `ReasoningOutput`, and `RunReasoning`, the single entry point between the platform and the engine |
| `api.ts` | REST request/response wrappers (`CaseSummary`, `FindingWithReview`, `ReviewRequest`, `GraphResponse`, `DossierJson`, ...), the Python `AnalyzeRequest`/`HealthResponse` and `CaseFixture` |
| `index.ts` | Re-exports everything |
| `analyze.schema.json` | JSON Schema for the Python service output (`AnalyzeResponse`) |
| `comparability.schema.json` | JSON Schema for one row of `backend/config/comparability.json` |
| `ocr.schema.json` | JSON Schema for `OcrPage` |
| `contracts.schema.json` | All contract types as `definitions`, used to validate fixtures (batch C1) |
| `analyze_models.py` | Pydantic mirror of the Python-side shapes (`AnalyzeResponse`, `OcrPage`, ...) |
| `openapi.yaml` | OpenAPI 3.1 for every route in ARCHITECTURE.md section 11 plus `GET /cases` and the Python service; types are `$ref`s into `contracts.schema.json` |
| `fixtures/` | Case fixtures, page images, OCR fixtures and expected outcomes (see `fixtures/README.md`) |
| `validate.ts` | Validates every fixture against the schemas, checks cross-references, box geometry, hashes and expected (non-)findings |
| `examples/` | Small sample objects used by the schema checks |
| `scripts/` | `gen-schemas.mjs` (schemas are generated from the TS types), `check-schemas.mjs` |

## Rules
- All boxes are `[x, y, w, h]`, normalized 0..1 to the canonical page render.
- `ReasoningOutput.events` are `RegionEvent`s (grouped forensic signals). `InvestigationEvent` is the append-only analyst log.
- Priority is `perCase` / `perDocument` `PriorityResult`. Never call it fraud risk.
- A missing or failed analyzer is `UNAVAILABLE`, `ERROR` or `NOT_APPLICABLE`, never clean.

## Workflow
```bash
cd contracts
npm install
npm run gen     # regenerate *.schema.json after editing the .ts files (commit the output)
npm run fixtures   # regenerate fixtures after editing fixtures/generate.py (needs Pillow)
npm run validate   # fixture validation
npm run lint:openapi
npm test        # typecheck, schema checks, pydantic checks (incl. fixtures), fixture validation
```
Python: `pip install pydantic`, put `contracts/` on `PYTHONPATH`, then `from analyze_models import AnalyzeResponse`.
