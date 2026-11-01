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
