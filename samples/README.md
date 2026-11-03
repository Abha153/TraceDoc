# samples/

All records and documents are fictional. The D1 set lives in `d1-lite/`; page images are 1240 x 1754
pixels at 150 dpi. Its PDFs include a searchable text layer, and scan variants have a small rotation,
deterministic noise and JPEG compression. The manifest uses the field names in
`../contracts/fixtures/README.md` and normalized page bounding boxes.

From the repository root, generate or verify the set with:

```powershell
python samples\generator\generate.py
python -m pytest samples\generator\test_generate.py
```

The generator uses Pillow (HPND), ReportLab (BSD), Faker (MIT), and Python's standard library. Pytest
(MIT) is used for tests. The fixed Faker seed and invariant PDF metadata make every generated file
byte-identical across repeated runs in the same environment.
