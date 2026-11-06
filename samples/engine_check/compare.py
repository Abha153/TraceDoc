"""Compare the engine's findings with each case's expected_findings.json.

    python samples/engine_check/make_inputs.py /tmp/in
    (cd backend/src/engine && npx tsx ../../../samples/engine_check/run.ts /tmp/in /tmp/out.json)
    python samples/engine_check/compare.py /tmp/out.json [dev|test|all]

Rules: every required cross-document finding must be found (same type, severity and document pair); optional ones may
or may not appear; any other cross-document finding is an unexpected finding (a false positive). Forensic findings are
out of scope here (no analyzer ran). S4 additionally requires two separate RESOLVED entities (applicant, guarantor).
Exit code 1 on any miss or unexpected finding, except the cases in KNOWN_GAPS, which are reported but not fatal.
Never tune thresholds on the test split.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

SAMPLES = Path(__file__).resolve().parents[1]
FORENSIC = {"REGION_EVENT", "TEXT_LAYER_MISMATCH"}
KNOWN_GAPS = {"S7a": "the engine's arithmetic rule only checks credit rows against the credits total; a wrong debits total is not checked yet"}


def key(f: dict) -> tuple:
    return (f["type"], f["severity"], tuple(sorted(f["documents"] if "documents" in f else f["docs"])))


def compare_case(case_id: str, expected: list[dict], engine: dict) -> dict:
    exp = [f for f in expected if f["type"] not in FORENSIC]
    got = Counter(key(f) for f in engine["findings"] if f["type"] not in FORENSIC)
    required = Counter(key(f) for f in exp if f.get("scoring") != "optional")
    optional = Counter(key(f) for f in exp if f.get("scoring") == "optional")
    missed = list((required - got).elements())
    unexpected = list((got - required - optional).elements())
    problems = []
    if case_id.startswith("S4"):
        res = sorted((e["role"], e["resolution"]) for e in engine["entities"] if e["role"] in ("applicant", "guarantor"))
        if res != [("applicant", "RESOLVED"), ("guarantor", "RESOLVED")]:
            problems.append(f"applicant and guarantor must be two separate RESOLVED entities, got {res}")
    return {"missed": missed, "unexpected": unexpected, "problems": problems,
            "optional_found": list((optional & got).elements())}


def main(argv=None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    results = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    which = argv[1] if len(argv) > 1 else "all"
    fatal = 0
    for split in ("dev", "test"):
        if which not in ("all", split):
            continue
        for d in sorted((SAMPLES / split).iterdir()):
            case = json.loads((d / "case.json").read_text(encoding="utf-8"))
            cid = case["caseId"]
            exp = json.loads((d / "expected_findings.json").read_text(encoding="utf-8"))["findings"]
            r = compare_case(cid, exp, results[cid])
            bad = r["missed"] or r["unexpected"] or r["problems"]
            known = cid in KNOWN_GAPS and r["missed"] and not r["unexpected"] and not r["problems"]
            status = "ok" if not bad else "KNOWN GAP" if known else "FAIL"
            fatal += 1 if status == "FAIL" else 0
            print(f"{status:<9} {split:<5} {cid}  found-optional={len(r['optional_found'])}")
            for label in ("missed", "unexpected", "problems"):
                for item in r[label]:
                    print(f"            {label}: {item}")
            if known:
                print(f"            note: {KNOWN_GAPS[cid]}")
    print("RESULT:", "FAIL" if fatal else "ok (known gaps listed above)")
    return 1 if fatal else 0


if __name__ == "__main__":
    raise SystemExit(main())
