# backend/src/engine

The reasoning engine: pure TypeScript modules, no I/O, deterministic. Owned by Person 1.
Own package so it never conflicts with `backend/package.json`:

```bash
cd backend/src/engine
npm install
npm test          # tsx --test *.test.ts, driven by contracts/fixtures
npm run typecheck
```

| Module | Batch | Status |
| --- | --- | --- |
| `assertions.ts` | B4 | done: `buildAssertions(fields, pages, caseId)`, plus exported normalizers |
| `entityResolver.ts` | B5 | todo |
| `comparability.ts`, `contextRules.ts` | B6 | todo |
| `eventGrouper.ts`, `priorityEngine.ts` | B7 | todo |
| `index.ts` | B7b | todo: `runReasoning` |

## B4 notes
- Canonical semantic types are the fixture field names (`full_name`, `dob`, `id_number`, `address_permanent`, ...). Extractor aliases
  such as `account_holder`, `closing_balance`, `total` map to them; unknown names pass through unchanged.
- A role prefix in the field name (`guarantor_`, `co_applicant_`, `nominee_`, `applicant_`) sets the provisional role.
- Dates parse day-first when both parts could be a month; two-digit years and impossible dates give `null`, never a guess.
- A value that cannot be normalized gives `normalizedValue: null`; the assertion is kept and downstream rules skip it.
