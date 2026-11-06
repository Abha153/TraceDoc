# Backend and analysis service: how they connect

The backend (Node, `backend/`) and the analysis service (Python, `ocr-service/`) are two processes. The backend decides **what** to
analyse and keeps the case; the service reads a stored original, renders it, runs the analyzers and answers with an `AnalyzeResponse`
(`contracts/analyze.schema.json`).

## The one thing that must be right: a shared `DATA_DIR`

They do not send files to each other. The backend writes the original to disk and the service reads it from the same place, so **both
processes must use the same `DATA_DIR`**:

```
DATA_DIR/
  evidence/<docId>/original.<ext>   written ONCE by the backend, read-only. The service only reads it.
  derived/<docId>/page-<n>.png      written by the service (the canonical page renders). The backend serves them.
  audit/ records/                   backend only
```

**The defaults do NOT match.** The backend defaults to `./data` (relative to `backend/`) and the service to `../data` (relative to
`ocr-service/`). Always set `DATA_DIR` explicitly, to the same **absolute** path, for both. If they differ, every document fails with
`the analysis service cannot find the original ... must use the same DATA_DIR` (HTTP 404 from the service).

## Running both (Windows PowerShell)

```powershell
$env:DATA_DIR = "C:\Users\you\TraceDoc\data"      # one folder, used by both

# 1. analysis service
cd ocr-service
pip install -r requirements.txt
$env:PYTHONPATH = "$PWD;$PWD\..\contracts"
uvicorn app.main:app --host 127.0.0.1 --port 8000

# 2. backend (another terminal; DATA_DIR set the same way)
cd backend
$env:ANALYSIS_MODE = "http"
$env:ANALYSIS_URL  = "http://127.0.0.1:8000"
npm run dev
```

On startup the backend calls `GET {ANALYSIS_URL}/health` and logs whether the service is reachable. It keeps starting if it is not: jobs
are retried until the service is up.

## Settings (backend)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANALYSIS_MODE` | `mock` | `mock` answers from `contracts/fixtures` (matched by file hash); `http` uses the real service |
| `ANALYSIS_URL` | `http://127.0.0.1:8000` | Where the service listens |
| `ANALYSIS_TIMEOUT_MS` | `110000` | Per call. Must be smaller than `JOB_TIMEOUT_MS` (120000), or the job timeout hides the real error |
| `ANALYSIS_RETRY_DELAY_MS` | `500` | Pause before the single retry |
| `CONTRACTS_DIR` | `../contracts` | Where `analyze.schema.json` is read from |
| `DATA_DIR` | `./data` | **Must equal the service's `DATA_DIR`** |

`REASONING_MODE=stub` only works with `ANALYSIS_MODE=mock`; the backend refuses to start otherwise.

## What happens when a call goes wrong

Every response is validated against `contracts/analyze.schema.json`, plus the value ranges the contract documents but the generated schema
does not enforce (every `bbox` number and every confidence in 0..1, regions on a page the document has and belonging to this document).
A bad answer is never used.

| What happened | Treated as | Job result |
| --- | --- | --- |
| Cannot connect, connection dropped, HTTP 502/503/504 | retried once by the client, then transient | job retried (up to `JOB_MAX_ATTEMPTS`), then FAILED with the reason |
| No answer within `ANALYSIS_TIMEOUT_MS` | transient, not retried by the client | same |
| HTTP 500 | transient | same |
| HTTP 404 (service cannot find the original) | permanent, message names `DATA_DIR` | FAILED at once |
| HTTP 409 (several originals), 415 (cannot open / encrypted / unsupported), 422 (bad request), other 4xx | permanent, with the service's own reason | FAILED at once |
| 200 but not valid JSON, not matching the schema, out-of-range values, or about another document | permanent | FAILED at once, nothing stored |
| 200 with some analyzers `ERROR` or `UNAVAILABLE` and others `AVAILABLE` | the answer is used | **PARTIAL**, each failed analyzer shown per job, listed in the dossier as missing, not clean |
| 200 where **no** analyzer succeeded, or the service reports **no analyzers at all** | the pages are kept for the viewer | **FAILED** ("reported no analyzers" / "no analyzer produced a usable result") |

A document whose analysis produced nothing is passed to the reasoning engine as a document whose analyzers all failed, so case coverage drops
(a case where nothing was analysed has coverage 0). It is never read as clean.

While the service has no analyzers registered (only the O1 skeleton), every job ends FAILED with "reported no analyzers"; the pages and
renders still work. This is expected until the OCR and forensic batches land.

## Testing against the real service

The normal test suite uses a fake service. To also run the backend against a real one, start the service with an **empty** `DATA_DIR`, then:

```powershell
cd backend
$env:REAL_ANALYSIS_URL      = "http://127.0.0.1:8000"
$env:REAL_ANALYSIS_DATA_DIR = "C:\path\to\that\empty\data"
npx vitest run test/realService.test.ts
```

The assertions hold whatever analyzers are registered, so they keep passing as the service gains analyzers.

## Licences

`ocr-service` uses PyMuPDF (AGPL-3.0); see its README. The backend talks to it over HTTP only.
