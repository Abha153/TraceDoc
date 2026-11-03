# samples/ - D1-lite genuine fictional documents

Owner: Person 4 (dataset). Consumer: Person 3 (OCR testing).
**Everything here is fictional.** Every document is stamped SAMPLE; the ID number format
(`SMP-1234-5678-AB`) and the issuer ("Republic of Samplia") are invented and imitate no real ID.

## What is delivered

| File (`samples/genuine/`) | What it is |
|---|---|
| `id_card_001.png` | ID card image (1011x638): SAMPLE stamp, photo placeholder, signature, name, DOB, address, ID number, issue/expiry |
| `loan_application_001.pdf` | Loan application form, 1 page, **searchable text layer**: full name, DOB, permanent + current address, requested amount, term, purpose, guarantor, 2 signatures |
| `bank_statement_001.pdf` | Bank statement, 1 page, text layer: holder, account no., period, opening balance, 18 transactions (date, description, debit, credit, balance), totals, closing balance |
| `*_scan.jpg` (x3) | Scan-like raster of each of the above: 0.5-1.2 deg rotation, paper tint + shading, blur, noise, JPEG q72. PDFs rasterised at 200 dpi (1700x2200); the ID keeps its native size |

Plus `samples/persons.json` (single source of all fictional data) and `samples/manifest.json`
(every file, true values, normalised bounding boxes).

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
* This manifest schema is local to D1-lite. It is **not** a shared contract; map it to `contracts/` when those exist.

## Regenerate

```bash
pip install -r samples/requirements.txt
python samples/generator/generate.py            # writes into samples/ (fixed seed 20260101)
python samples/generator/generate.py --out /tmp/x --seed 7   # elsewhere / other seed
```
Fonts: Liberation Sans/Mono (`fonts-liberation`); set `TRACEDOCS_FONT_DIR` if they live elsewhere.
Output is byte-for-byte reproducible on the same library versions (PDF dates are pinned, all noise is seeded).
A different Pillow/libjpeg/pdfium build can change JPEG/PNG bytes (not the data); the committed files are canonical.

## Tests

```bash
python -m pytest samples/tests -v        # ~30 s (OCR cross-check is skipped if tesseract is missing)
```
Covers: two-run determinism + match with committed files, exact file set, sha256, bbox ranges, PDFs open with a
text layer (pypdf + pdfplumber), values traced to `persons.json`, statement arithmetic (Decimal), bbox == PDF word
boxes, ink inside every bbox (originals, rasterised PDFs, raw and de-rotated scans), OCR of every cropped bbox.
