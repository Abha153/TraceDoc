# backend/

Express + TypeScript API for TraceDocs (Person 2 owns everything here except `src/engine/`).
See `../ARCHITECTURE.md` and `../contracts/`.


## Run

```bash
cd backend
npm install
npm run hash-password -- "your password"   # paste the output into .env as ANALYST_PASSWORD_HASH
cp .env.example .env                       # then edit
npm run dev
```

The server reads real environment variables; load `.env` with your shell or `node --env-file=.env`.

## Test

```bash
npm test
npm run typecheck
```

## Notes

- Types come from `../contracts/` through the `@contracts/*` alias (tsconfig and vitest both configured).
- Single-analyst auth: scrypt password hash from env, random server-side session token in an HttpOnly,
  SameSite=Lax cookie. Sessions live in memory and end on restart. Failed logins are rate limited per IP.
- Every route except `/health` and `/auth/*` must be mounted behind `deps.requireAuth`.

## Storage and ingestion (B2)

- `POST /api/v1/cases/:caseId/documents` (multipart, field `files`, up to 20 files). The case must exist (404 otherwise).
  Responds `202 { caseId, documents, jobs }` as in `contracts/openapi.yaml`.
- File type is decided from magic bytes (PDF, PNG, JPEG, TIFF). The client's extension and Content-Type are ignored.
  One bad file rejects the whole request with 400 and nothing is stored. Oversized files also give 400 (`FILE_TOO_LARGE`).
- Originals go to `DATA_DIR/evidence/<docId>/original.<ext>`, opened with the `wx` flag (the OS refuses an
  overwrite) and set read-only. Paths are built only from the server-generated docId, never from the filename.
- `DATA_DIR/audit/manifest.json` is an append-only array of `{docId, caseId, filename, sha256, bytes, mimeType, storedAs, receivedAt}`.
  `caseId`, `mimeType` and `storedAs` are additions beyond the minimum so B12 can re-verify without guessing paths.
- Derivatives belong in `DATA_DIR/derived/<docId>/` (`Storage.derivedDir`).

## Cases, documents and jobs (B3)

- Routes: `POST/GET /cases`, `GET /cases/:id`, `GET /documents/:docId`, `GET /jobs/:jobId` (all behind login).
  Case ids are sequential (`CASE-001`, ...), job ids too (`JOB-0001`, ...).
- Records are JSON files under `DATA_DIR/records/{cases,documents,jobs,analysis}/` behind repository interfaces
  (`src/repo/repositories.ts`), written via temp file + rename.
- A job has states QUEUED / RUNNING / PARTIAL / DONE / FAILED and per-analyzer progress.
  - Idempotent by `(docId, pipelineVersion)`: enqueueing again returns the existing job. A forced re-run is a new job.
  - `attempts` counts runs started; a failed run is re-queued until `JOB_MAX_ATTEMPTS`, then FAILED. A permanent error
    (for example no recorded analysis) fails at once.
  - Some analyzers ERROR/UNAVAILABLE and some AVAILABLE gives PARTIAL; none AVAILABLE gives FAILED. Never reported as clean.
  - On startup `recoverRunning()` moves jobs left RUNNING by a dead process back to QUEUED (FAILED if they used every attempt).
- `AnalysisClient` is the only view of the analysis service (`src/services/analysisClient.ts`). `ANALYSIS_MODE=mock` uses
  `MockAnalysisClient`: it matches the uploaded file's SHA-256 to a document in `contracts/fixtures/CASE-*.case.json`
  (upload files from `contracts/fixtures/originals/`) and returns the recorded `analyze/<docId>.json`, re-labelled with the
  server-generated docId. Any other file fails with a clear message. The real HTTP client arrives in B11.
- The worker (`src/services/worker.ts`) runs one job at a time with a timeout (`JOB_TIMEOUT_MS`) and tells listeners when a job
  finishes (B10 hooks reasoning in there). It starts from `server.ts`; tests call `worker.processNext()` directly.

## Evidence store and read APIs (B8)

- `src/repo/evidence.ts`: findings, evidence, assertions, entities, region events, signals and priority of a case are stored as
  **generations** under `DATA_DIR/records/evidence/<caseId>/gen-0001.json`, `gen-0002.json`, ... A generation is written once
  (temp file, then a hard link that fails if the target exists), made read-only, and never modified. A re-run (B10 recompute) writes
  the next generation and keeps the old ones. The API shows the latest generation; older finding ids stay readable.
- **Finding ids are namespaced** when stored: the engine's `F-0001` becomes `<caseId>-g<generation>-F-0001`
  (e.g. `CASE-001-g1-F-0001`). Engine ids repeat across cases and re-runs, and `GET /findings/:findingId` has no case in its path.
  A new generation starts with fresh, unreviewed findings, and `priority.contributingFindingIds` is renamed to match.
  Everything else in a finding is stored exactly as the engine produced it.
- Routes (all behind login, shapes from `contracts/openapi.yaml`):
  `GET /cases/:id/findings` (filters `category`, `observationStatus`, `reviewStatus`; unknown values are 400),
  `GET /findings/:id`, `GET /cases/:id/assertions`, `GET /cases/:id/entities`, `GET /cases/:id/graph`,
  `GET /documents/:docId/pages/:n/render`.
  A case with no reasoning run yet returns empty lists and a `null` priority, never a "clean" result.
  `GET /cases/:id` now carries the stored `priority` and `perDocumentPriority`.
- Review status comes from a `ReviewSource` (`src/services/reviewSource.ts`). Until B9 it reports UNREVIEWED and no history.
- The graph (`src/services/graph.ts`) is derived from stored evidence: `contains` (entity to each of its documents), `match`
  (same `id_number` / `account_number` value for one entity across documents), `conflict` (INCONSISTENT findings that span two
  documents; labelled `(capped)` when `confidenceCapped` is set) and `suggested` (a SUGGESTED entity towards the entity named in
  its `basis`, e.g. "name similarity 100 to E-001"). It reproduces `contracts/fixtures/CASE-00x.graph.json` exactly.
- **Page renders** are served from `DATA_DIR/derived/<docId>/page-<n>.png`. The path is built from the validated docId and page
  number only; the `renderPath` string in an analysis response is never used to open a file. **The Python service must write its
  canonical renders to that location** (the shared `DATA_DIR`, same convention as `renderPath`). In mock mode the mock client copies
  the fixture page images there.
- `tsconfig.json` excludes `src/engine/`: it is its own package with its own tsconfig and tests (Person 1).
