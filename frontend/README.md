# TraceDocs frontend

The React/Vite/TypeScript workspace uses the shared `contracts/` types and fixture JSON schemas. Fixture mode is enabled by default; set `VITE_USE_MOCKS=false` to use the configured backend for implemented routes.

## Local checks

Run these commands from `frontend/`:

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Install the Playwright browser once before the browser smoke tests:

```sh
npx playwright install chromium
```

Copy `.env.example` to `.env.local` to override the fixture-mode default, API base path, 20 MB per-file upload limit, or 1.1-second job polling interval. Numeric settings must be positive values.

The Vitest integration suite exercises fixture login, case creation, upload validation and byte-progress reporting, the job lifecycle and retry, case-scoped findings navigation, category filtering/sorting, finding-region focus at zoom, analyst review/history/rollback, evidence comparison, region-linked entity navigation, dossier downloads, and the fixture integrity action. Component tests cover all contract status badge variants. Playwright covers the browser upload path, golden review path, real Cytoscape rendering, keyboard navigation, and narrow-screen overflow.

## Feature status and limits

| Feature | Status | Evidence and limits |
| --- | --- | --- |
| F1 shell and mocks | Implemented | Protected routes, app shell, error/loading/empty states, contract-backed MSW handlers, generated browser worker, typed status badges, and responsive styles. |
| F2 login and cases | Implemented | Fixture login, case list/detail, case creation dialog, and inline upload-page case creation. Live login/case/document routes exist in the backend. |
| F3 upload and jobs | Fixture implementation | Type/extension and 20 MB checks, choose/create case, measured browser upload-byte progress, polling, analyzer messages, retries, and QUEUED/RUNNING/PARTIAL/DONE/FAILED fixture outcomes. DONE explicitly reports no analysis output; a filename containing `fail` selects the deterministic failure example. Retry is local mock state only; no retry endpoint is defined by the contract or mounted backend. |
| F4 document viewer | Implemented with fixture image limit | Normalized field/signal/finding overlays, observation-status legend and styling, focus/highlight, pan, zoom, keyboard-accessible regions, and page navigation. Only recorded page-one images are supplied; later pages show an unavailable preview rather than reusing the wrong image. |
| F5 findings | Implemented for fixtures | Category, observation, review, severity, and document filters; sorting with announced direction; case-scoped navigation from case detail; separate finding confidence; evidence, thresholds/configuration, provenance, explanations, and focused document regions. |
| F6 analyst review | Implemented for fixtures | Confirm, reason-required dismiss, inconclusive, comment, reopen, append-only history, optimistic updates, and rollback on request failure. Machine observation status remains independent. |
| F7 comparison | Implemented for cross-document fixtures | Side-by-side regions, assertion extraction confidence, swap, sync-zoom toggle, rule/entity resolution, and legitimate-difference metadata. Comparison is not offered for single-document evidence. Live assertion/finding endpoints are not mounted. |
| F8 entities | Implemented for fixtures | Cytoscape graph (MIT-licensed), match/conflict/suggested edge styling with a legend, visible resolution states, assertion grouping, basis-aware entity search, keyboard-accessible graph-item controls, and assertion-region navigation. |
| F9 reports | Implemented for fixtures | Dossier JSON/PDF downloads, separate priority/confidence/coverage, event filter, limitations, and a labelled mock integrity result. Integrity PASS is not a hash check of uploaded bytes. |
| F10 polish and smoke tests | Implemented | Responsive styling verified at 320, 390, 768, 1024, and 1440 px; keyboard-operable mobile navigation; route-level code splitting; copy that distinguishes observations from analyst review; Vitest integration coverage; and Playwright upload/review golden paths. |

The jsdom suite uses a fetch-backed `XMLHttpRequest` adapter with deterministic progress events because jsdom's native XHR is not intercepted by the MSW Node server. Playwright separately verifies the real browser XHR request against the MSW service worker.

## Backend integration boundary

Run against the real backend with `VITE_USE_MOCKS=false` (for example in `.env.local`). The Vite dev server proxies `/api` to `http://127.0.0.1:4000` (override with `VITE_BACKEND_URL`), so the session cookie stays same-origin. Start the backend first (`backend/`: `npm run dev`, with `ANALYST_PASSWORD_HASH` set) and sign in with the backend's `ANALYST_ID` and password; the login form is not pre-filled in this mode.

Mounted in `backend/src/routes/` and used live by this frontend: `/auth/login|logout|me`, `/cases` (list/create/detail/recompute), `/cases/{id}/documents` upload, `/documents/{id}`, `/jobs/{id}`, `/cases/{id}/findings`, `/findings/{id}`, `/cases/{id}/assertions`, `/cases/{id}/entities`, `/cases/{id}/graph`, `/documents/{id}/pages/{n}/render`, and `/health`. In live mode the document viewer loads the canonical page render from the backend and shows the extracted fields returned by `GET /documents/{id}`; forensic signals are not exposed by any mounted route, so none are drawn.

Not mounted, so gated or disabled in live mode: `POST /findings/{id}/review` (review controls show a read-only notice), `/cases/{id}/events`, `/dossier`, `/integrity` (Reports shows the unavailable-route page), page reclassification, and an upload retry endpoint (retry is local fixture state only).
