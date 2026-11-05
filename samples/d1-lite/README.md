# samples/d1-lite/ (legacy D1-lite hand-over)

The original single-set D1-lite files delivered to Person 3 (`application_form_001.pdf`, `bank_statement_001.pdf`,
`id_card_001.png` and their `_scan.jpg` versions), kept unchanged for backward compatibility.
Their manifest (`manifest.json`, paths relative to this folder) and `persons.json` are the original ones.

**Superseded by `../` (D1 v2)**, which has two person sets, hard scans and recompressed controls. Use `../manifest.json`
for new work. `legacy_generator/` is the original generator; regenerating it with a different Faker/Pillow/reportlab
build than the original author's does not reproduce these bytes, so treat the committed files as the reference.

```bash
python -m pytest samples/d1-lite/legacy_generator -q
```
