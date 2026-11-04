# Integration status

The only place that may claim a capability works. Updated 2026-11-04. "Verified" means a test in this repository exercises it.

| Capability | State | Evidence |
| --- | --- | --- |
| Shared contracts (types, JSON Schemas, pydantic mirror, OpenAPI, fixtures) | Working | `contracts/` `npm test`: schema checks, pydantic checks, 964 fixture checks |
| Upload, write-once evidence, SHA-256 manifest | Working | `backend/test/ingest.test.ts` |
| Cases, documents, persistent job store, worker | Working | `backend/test/jobs.test.ts`, `worker.test.ts`, `cases-api.test.ts` |
| Reasoning engine (assertions, entity resolution, comparability and context rules, event grouping, priority) | Working on fixtures | `backend/src/engine/*.test.ts` |
| Reasoning wired into the job pipeline | Working with mock analysis | `backend/test/reasoning.test.ts` |
| Evidence store and read APIs (findings, assertions, entities, graph, page render) | Working | `backend/test/evidence-api.test.ts` |
| Analyst review, append-only event log, reclassification | Working | `backend/test/review.test.ts` |
| Access log (VIEW events on case, document and finding reads) | Working | `backend/test/cases-api.test.ts`, `review.test.ts` |
| Integrity verifier (`/cases/:id/integrity`) | Working | `backend/test/integrity.test.ts` |
| Retention policy (`/compliance/retention-policy`) | Reports configuration only; nothing is purged | `backend/test/cases-api.test.ts` |
| Related cases (`/cases/:id/related`) | Working: exact id_number, account_number and file-hash matches | `backend/src/engine/correlation.test.ts`, `backend/test/related.test.ts` |
| Frontend (fixture mode) | Working | `frontend` `npm test` (24 tests) |
| Frontend (live mode against the backend) | API shapes checked against the contract; not exercised in a browser | `frontend/src/api/client.test.ts`, manual API run on 2026-11-03 |
| Sample documents (D1) | Working; no tampered samples yet | `samples/generator/test_generate.py` |
| **Analysis of a real uploaded document** | **Not built.** The backend answers from recorded fixtures by file hash; any other file fails with a clear reason | `ANALYSIS_MODE=mock` is the only mode |
| Python service: rendering, OCR, classification, field extraction | Not started | `ocr-service/` holds a README only |
| Forensic detectors (text layer, fonts, PDF structure, ELA, copy-move) | Not started | none |
| Dossier PDF and `/cases/:id/dossier` | Not built; the frontend composes a labelled view from the live read routes | none |
| LLM explainer | Not built; findings carry no generated explanation | none |
| Evaluation harness and results | Not built | `eval/` holds a README only |
