# contracts/

Source of truth shared by backend, ocr-service and frontend. Contract changes go through Person 1 only:
update this folder and the fixtures in one commit, then tell the affected owners.

| File | What it is |
| --- | --- |
| `types.ts` | Every interface from ARCHITECTURE.md section 5, plus `Job`, `ForensicSignal`, `AnalyzeResponse`, `RegionEvent`, `PriorityOutput`, `ComparabilityRule` |
| `ocr.ts` | `OcrWord`, `OcrLine`, `OcrPage`: OCR output with boxes normalized to the canonical render |
| `reasoning.ts` | `ReasoningInput`, `ReasoningOutput`, and `RunReasoning`, the single entry point between the platform and the engine |
| `index.ts` | Re-exports everything |
| `analyze.schema.json` | JSON Schema for the Python service output (`AnalyzeResponse`) |
| `comparability.schema.json` | JSON Schema for one row of `backend/config/comparability.json` |
| `ocr.schema.json` | JSON Schema for `OcrPage` |
| `contracts.schema.json` | All contract types as `definitions`, used to validate fixtures (batch C1) |
| `analyze_models.py` | Pydantic mirror of the Python-side shapes (`AnalyzeResponse`, `OcrPage`, ...) |
| `examples/` | Small sample objects used by the checks below |
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
npm test        # tsc typecheck, schema validation (good and bad samples), pydantic checks
```
Python: `pip install pydantic`, put `contracts/` on `PYTHONPATH`, then `from analyze_models import AnalyzeResponse`.
