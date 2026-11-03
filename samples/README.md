# samples/ - D1 genuine fictional documents (set 001 = the D1-lite hand-over)

Owner: Person 4 (dataset). Consumer: Person 3 (OCR testing).
**Everything here is fictional.** Every document is stamped SAMPLE; the ID number format
(`SMP-1234-5678-AB`) and the issuer ("Republic of Samplia") are invented and imitate no real ID.

## What is delivered

Two independent **sets** (`001`, `002`, different fictional people) x 3 documents x 4 variants = **24 files** in
`samples/genuine/`. Set 001 is the original D1-lite delivery; set 002 is a second applicant/guarantor.

| File pattern | What it is |
|---|---|
| `id_card_NNN.png` | ID card image (1011x638): SAMPLE stamp, photo placeholder, signature, name, DOB, address, ID number, issue/expiry |
| `loan_application_NNN.pdf` | Loan application, 1 page, **searchable text layer**: name, DOB, permanent + current address, amount, term, purpose, guarantor, 2 signatures |
| `bank_statement_NNN.pdf` | Statement, 1 page, text layer: holder, account no., period, opening balance, 18 transactions, totals, closing balance |
| `*_scan.jpg` | Scan-like raster: 0.5-1.2 deg rotation, tint + shading, blur, noise, JPEG q72 (PDFs rasterised at 200 dpi) |
| `*_scan_hard.jpg` | Harder scan for OCR robustness: 2.0-3.5 deg rotation, more blur/noise, lower contrast, JPEG q45 |
| `*_recompressed.jpg` | **Control (S8):** the genuine page only re-saved as JPEG q85. No rotation, noise or edit. Forensic detectors must NOT flag it. `control: "recompressed_only"` in the manifest |

Plus `persons.json` (set 001) / `persons_002.json` (set 002; stdlib-only builder, no Faker) and `manifest.json`.

## Manifest conventions

* `bbox = [x_min, y_min, x_max, y_max]`, **0-1 fractions of page/image width and height, origin top-left, y down.**
* Per field: `name`, `field_type` (`text|date|money|identifier|integer|date_range|signature|photo|marker`),
  `text` (exactly as printed - ID text is upper-case, addresses on the ID are 2 lines joined by `\n`),
  `value` (the true/normalised value: ISO dates, plain `1234.50` money, true-case names), `page` (always 1).
* Signature and photo fields have `text: null, value: null`.
* Text boxes are the string's advance width + 1 pt (PDF) / 2 px (ID); a trailing `1` can leave ~2 pt blank.
* **Scan files:** bboxes are the axis-aligned box *enclosing* the rotated field rectangle; the angle is in
  `scan.rotation_deg` (counter-clockwise positive). Rotating the scan by `-rotation_deg` restores the original layout.
* Each original is immediately followed by its scan (`derived_from`). Statement transaction fields are
  `transaction_NN_{date,description,debit,credit,balance}`; an empty debit/credit cell has no field.
* Every field also carries `semantic_type` (vocabulary of ARCHITECTURE.md: `dob`, `full_name`, `id_number`,
  `address_permanent`, `address_current`, `requested_amount`, `account_balance`, `statement_total`, ...; `semantic_detail`
  = `opening|closing|debits|credits`), ground-truth `true_person_id` / `true_entity_role` (null when the field belongs
  to no person), and `region` = a contract-shaped `Region` `{docId, page, bbox: [x, y, w, h], label}`. `bbox` stays
  `[x_min, y_min, x_max, y_max]`; `samples/generator/bbox.py` converts both ways.
* Statement documents have a `tables` entry (`transactions`: columns, rows -> cell field names + row boxes, totals row).
* `sets.<id>.legitimate_differences` lists values that differ on purpose in a genuine set (permanent vs current address,
  requested amount vs balance, applicant vs guarantor) with `expected_finding: false`: a correct reasoner must not report them.
* Variants: `original`, `scan`, `scan_hard`, `recompressed`; each non-original has `derived_from`.
* This manifest schema is local to D1. It is **not** a shared contract; map it to `contracts/` when those exist.

## Regenerate

```bash
pip install -r samples/requirements.txt
python samples/generator/generate.py            # writes into samples/ (fixed seed 20260101)
python samples/generator/generate.py --out /tmp/x --persons samples/persons.json
python samples/generator/generate.py --rebuild-persons   # needs Faker; output depends on the Faker version
python samples/verify_hashes.py                 # stdlib only: every file matches manifest sha256/bytes
```
Rendering reads the **committed `persons.json`** by default, so Faker is not needed and the data cannot drift with the
Faker version (a different `--seed` or `--rebuild-persons` rebuilds it with Faker). Fonts: Liberation Sans/Mono
(`fonts-liberation`); set `TRACEDOCS_FONT_DIR` if they live elsewhere.

Output is deterministic on the same library versions. A different Pillow/libjpeg/reportlab build changes the **bytes**
of PNG/PDF files (zlib streams), not their content, so the manifest hashes only match files from the same build.
**Hand over the committed set as a whole** (files + manifest) and run `verify_hashes.py` before sending; never mix
files regenerated elsewhere with this manifest.

## Tests

```bash
python -m pytest samples/tests -v        # ~70 s (OCR cross-check is skipped if tesseract is missing)
```
Covers: two-run determinism, committed manifest/persons equal a fresh run (bytes only with `TRACEDOCS_STRICT_BYTES=1`), committed files match manifest hashes, both sets, semantic labels + regions, table entries, legitimate differences, hard-scan and control variants, exact file set, sha256, bbox ranges, PDFs open with a
text layer (pypdf + pdfplumber), values traced to `persons.json`, statement arithmetic (Decimal), bbox == PDF word
boxes, ink inside every bbox (originals, rasterised PDFs, raw and de-rotated scans), OCR of every cropped bbox.
