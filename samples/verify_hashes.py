"""Stdlib-only check that every file listed in manifest.json exists and matches its sha256/bytes.

    python samples/verify_hashes.py            # exit code 1 on any mismatch or extra file
Run this before handing samples to another person: loose files regenerated on a different
Pillow/libjpeg build will fail here even though their content is equivalent.
"""
import hashlib
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
bad = 0
listed = set()
for d in manifest["documents"]:
    p = root / d["file"]
    listed.add(p.resolve())
    if not p.is_file():
        print("MISSING ", d["file"]); bad += 1; continue
    b = p.read_bytes()
    ok = hashlib.sha256(b).hexdigest() == d["sha256"] and len(b) == d["bytes"]
    print("OK      " if ok else "MISMATCH", d["file"]); bad += not ok
for p in sorted((root / "genuine").glob("*")):
    if p.resolve() not in listed:
        print("UNLISTED", p.relative_to(root)); bad += 1
print("PASS" if not bad else f"FAIL ({bad} problem(s))")
sys.exit(1 if bad else 0)
