# TraceDocs

AI-assisted document forensics and contextual intelligence (hackathon prototype, built from scratch).
Fictional documents only. Findings are observations or potential anomalies, never fraud verdicts.

See `ARCHITECTURE.md` (design) and `BUILD_PLAN.md` (batches and ownership). Full README (setup, licenses,
AI-assistance disclosure) is written in batch X3.

| Folder | Purpose |
| --- | --- |
| `contracts/` | Shared types, JSON Schemas, pydantic mirror, fixtures, OpenAPI. Source of truth. |
| `backend/` | Node + Express API and the reasoning engine (`backend/src/engine/`) |
| `ocr-service/` | Python + FastAPI analysis service (OCR, extraction, forensic analyzers) |
| `frontend/` | React + Vite investigation UI |
| `samples/` | Fictional sample documents, ground truth |
| `eval/` | Evaluation scripts and results |
| `docs/` | Limitations, integration status, demo script |
