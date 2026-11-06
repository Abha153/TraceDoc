# samples/: fictional documents, edits, cases and ground truth

Everything here is fictional and marked SAMPLE. No real person, no real ID format.

| Path | What | Batch |
| --- | --- | --- |
| `genuine/`, `manifest.json`, `persons*.json` | Two person sets x (ID card, application form, bank statement) x (original, scan, hard scan, recompressed control) = 24 files, with field values, semantic types and boxes | D1 |
| `tampered/`, `controls/`, `tampered/ground_truth.json` | Eight single edits (value replaced, font changed, digits painted over, copy-move, signature replaced, photo swapped, incremental save, hidden text) and four false-positive controls (recompressed, re-saved, legitimate bold, legitimate highlight) | D2 |
| `dev/`, `test/` | 16 cases = 8 patterns (S1 to S8) x 2 variants, each with `expected_findings.json` and `expected_non_findings.json` | D3, D4 |
| `ground-truth.md` | One table per case: documents, intended edit or legitimate difference, expected findings and non-findings (generated) | D4 |
| `engine_check/` | Runs the real reasoning engine over every case with ground-truth ("perfect OCR") input and compares with `expected_findings.json` | D4 |
| `validate.py` | Checks files, hashes, boxes, references and leakage between dev and test | D4 |
| `d1-lite/` | The original single-set hand-over to Person 3, unchanged; superseded by D1 above | legacy |

## dev and test

`dev/` (variant a) is for building and tuning. `test/` (variant b) is held out: a different variant of every
pattern, people drawn from disjoint name pools, never used to tune thresholds. `validate.py` fails if any person,
id number, account number, document id, file name or file content appears in both, or if `backend/config` refers
to `samples/test`.

## Boxes

Ground-truth `bbox` and every `region.bbox` are the contract `Region` form `[x, y, w, h]`, fractions of the page,
origin top-left. The D1 manifest keeps `bbox` as `[x_min, y_min, x_max, y_max]` beside a contract-shaped `region`;
`generator/bbox.py` converts. Each structure holds one format and says which.

## Commands (repository root)

```bash
pip install -r samples/requirements.txt
python samples/generator/generate.py          # D1  -> genuine/, manifest.json
python samples/generator/tamper.py            # D2  -> tampered/, controls/
python samples/generator/scenarios.py         # D3  -> dev/, test/, scenarios_index.json
python samples/generator/ground_truth_doc.py  # D4  -> ground-truth.md
python samples/validate.py                    # D4  -> VALID or a list of problems
python -m pytest samples/tests -q             # all sample tests

# reasoning check against the real engine (needs node; one-time `npm ci` in backend/src/engine)
python samples/engine_check/make_inputs.py /tmp/in
(cd backend/src/engine && npx tsx ../../../samples/engine_check/run.ts /tmp/in /tmp/out.json)
python samples/engine_check/compare.py /tmp/out.json dev     # tune on dev; run `test` once
```

## Notes and limits

* Output is deterministic for a given library build. The original D1-lite bytes were made with different library
  builds, so `d1-lite/` is kept as committed rather than regenerated. Set `TRACEDOCS_STRICT_BYTES=1` to also compare
  raw bytes against the committed files on the machine that generated them.
* `expectedAnalyzers` and `detectability` in the cases are the author's assessment of what each detector class should
  see, not a guarantee. Photo replacement is listed as unsupported in `ARCHITECTURE.md`, so S-case expectations
  for it are `optional`.
* The application form prints the applicant's and the guarantor's `id_number` (as the contract fixture form does). The reasoning engine links documents only on an exact `id_number` or `account_number`; without it no cross-document comparison is possible.
* Dependencies: Pillow (HPND), ReportLab (BSD), pypdfium2 (Apache-2.0/BSD), pikepdf (MPL-2.0, wraps qpdf, Apache-2.0;
  needed for operator-level PDF edits in `tamper.py`), Faker (MIT, only for `--rebuild-persons`); tests use pytest,
  pypdf and pdfplumber.

## Engine check results (what it showed)

With ground-truth input, the engine reproduces the expected cross-document findings in 15 of 16 cases, including both
DOB contradictions, both tampered-with-inconsistency cases, and S4 (similar names resolve to two separate entities).
Known gap: S7a (wrong *debits* total) is not detected because the arithmetic rule only compares credit rows with the credits
total. The check covers reasoning only; forensic detectors (analyzers) are not simulated, so tamper findings are not scored here.
