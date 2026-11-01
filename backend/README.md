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

- `POST /api/v1/cases/:caseId/documents` (multipart, field `files`, up to 20 files) returns `201 { docIds, documents }`.
  B3 will extend this to also return job ids.
- File type is decided from magic bytes (PDF, PNG, JPEG, TIFF). The client's extension and Content-Type are ignored.
  One bad file rejects the whole request and nothing is stored.
- Originals go to `DATA_DIR/evidence/<docId>/original.<ext>`, opened with the `wx` flag (the OS refuses an
  overwrite) and set read-only. Paths are built only from the server-generated docId, never from the filename.
- `DATA_DIR/audit/manifest.json` is an append-only array of `{docId, caseId, filename, sha256, bytes, mimeType, storedAs, receivedAt}`.
  `caseId`, `mimeType` and `storedAs` are additions beyond the minimum so B12 can re-verify without guessing paths.
- Derivatives belong in `DATA_DIR/derived/<docId>/` (`Storage.derivedDir`).
- Note: the case is not yet checked for existence. B3 adds cases and that check.
