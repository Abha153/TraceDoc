# backend/

Express + TypeScript API for TraceDocs (Person 2 owns everything here except `src/engine/`).

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
