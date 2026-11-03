"""D4: the validator accepts the committed set and rejects every kind of defect and leak.

Run from the repo root:  python -m pytest samples/tests/test_d4_validate.py -v
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SAMPLES = REPO / "samples"
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(SAMPLES))

import validate as V  # noqa: E402


def test_committed_set_is_valid():
    assert V.validate(SAMPLES) == []


def test_cli_exit_code():
    assert V.main([str(SAMPLES)]) == 0


def test_splits_hold_one_variant_of_every_pattern_and_never_the_same_one():
    idx = json.loads((SAMPLES / "scenarios_index.json").read_text())
    by = {"dev": {}, "test": {}}
    for c in idx["cases"]:
        by[c["split"]][c["pattern"]] = c
    assert sorted(by["dev"]) == sorted(by["test"]) == V.PATTERNS
    for p in V.PATTERNS:
        assert by["dev"][p]["variant"] == "a" and by["test"][p]["variant"] == "b"
        assert by["dev"][p]["caseId"] != by["test"][p]["caseId"]
        assert not set(by["dev"][p]["persons"]) & set(by["test"][p]["persons"])


def test_no_person_or_file_shared_between_splits():
    def collect(split):
        names, ids, hashes = set(), set(), set()
        for d in (SAMPLES / split).iterdir():
            case = json.loads((d / "case.json").read_text())
            names |= {p["full_name"] for p in case["persons"]}
            ids |= {p["id_number"] for p in case["persons"]}
            hashes |= {V.sha(f) for f in d.rglob("*") if f.is_file() and f.suffix != ".json"}
        return names, ids, hashes
    d, t = collect("dev"), collect("test")
    assert not d[0] & t[0] and not d[1] & t[1] and not d[2] & t[2]


def test_genuine_sources_are_listed_and_hash(): 
    for split in ("dev", "test"):
        for d in (SAMPLES / split).iterdir():
            case = json.loads((d / "case.json").read_text())
            on_disk = {f.relative_to(d).as_posix() for f in (d / "_genuine_source").rglob("*") if f.is_file()} \
                if (d / "_genuine_source").is_dir() else set()
            assert on_disk == {s["file"] for s in case["genuine_sources"]}


# ------------------------------------------------------------------ negative tests on a scratch copy
@pytest.fixture()
def scratch(tmp_path):
    root = tmp_path / "repo" / "samples"
    shutil.copytree(SAMPLES, root, ignore=shutil.ignore_patterns("__pycache__", "tests", "d1-lite", ".pytest_cache"))
    return root


def case_dir(root, cid):
    c = next(c for c in json.loads((root / "scenarios_index.json").read_text())["cases"] if c["caseId"] == cid)
    return root / c["split"] / Path(c["dir"]).name


def edit_json(path, fn):
    d = json.loads(path.read_text())
    fn(d)
    path.write_text(json.dumps(d, indent=2))


def errors(root):
    return "\n".join(V.validate(root))


def test_scratch_copy_is_valid(scratch):
    assert V.validate(scratch) == []


def test_detects_person_leak(scratch):
    dev_name = json.loads((case_dir(scratch, "S1a") / "case.json").read_text())["persons"][0]["full_name"]
    edit_json(case_dir(scratch, "S1b") / "case.json", lambda d: d["persons"][0].update(full_name=dev_name))
    e = errors(scratch)
    assert "person name appears in both dev and test" in e


def test_detects_id_number_leak(scratch):
    n = json.loads((case_dir(scratch, "S1a") / "case.json").read_text())["persons"][0]["id_number"]
    edit_json(case_dir(scratch, "S2b") / "case.json", lambda d: d["persons"][1].update(id_number=n))
    assert "id number appears in both dev and test" in errors(scratch)


def test_detects_file_content_leak(scratch):
    src = next(case_dir(scratch, "S1a").glob("id_card_*.png"))
    shutil.copy(src, case_dir(scratch, "S1b") / "copy_of_dev_card.png")
    e = errors(scratch)
    assert "file content appears in both dev and test" in e and "not referenced" in e


def test_detects_missing_document(scratch):
    next(case_dir(scratch, "S3a").glob("bank_statement_*.pdf")).unlink()
    assert "missing file" in errors(scratch)


def test_detects_modified_document(scratch):
    p = next(case_dir(scratch, "S3b").glob("bank_statement_*.pdf"))
    p.write_bytes(p.read_bytes() + b"\n%edited")
    assert "sha256 mismatch" in errors(scratch)


def test_detects_bbox_outside_page(scratch):
    def bad(d):
        d["documents"][0]["fields"][1]["region"]["bbox"] = [0.95, 0.5, 0.2, 0.1]
    edit_json(case_dir(scratch, "S1a") / "case.json", bad)
    assert "outside page" in errors(scratch)


def test_detects_bad_ground_truth_box(scratch):
    edit_json(scratch / "tampered" / "ground_truth.json",
              lambda d: d["entries"][0].update(bbox=[0.9, 0.9, 0.3, 0.3]))
    assert "bbox not a valid xywh inside the page" in errors(scratch)


def test_detects_control_expecting_finding(scratch):
    def bad(d):
        next(e for e in d["entries"] if e["role"] == "control").update(expected_finding=True)
    edit_json(scratch / "tampered" / "ground_truth.json", bad)
    assert "expected_finding must be true for edits and false for controls" in errors(scratch)


def test_detects_expectation_pointing_at_unknown_document_or_edit(scratch):
    d5 = case_dir(scratch, "S5a")
    edit_json(d5 / "expected_findings.json", lambda d: d["findings"][1].update(tamperRef="T-99"))
    edit_json(d5 / "expected_non_findings.json", lambda d: d["non_findings"][0]["documents"].append("ghost_doc"))
    e = errors(scratch)
    assert "unknown tamperRef T-99" in e and "unknown document ghost_doc" in e


def test_detects_evidence_that_does_not_match_the_document(scratch):
    edit_json(case_dir(scratch, "S3a") / "expected_findings.json",
              lambda d: d["findings"][0]["evidence"][0].update(text="1900-01-01"))
    assert "does not match the document" in errors(scratch)


def test_detects_wrong_split_placement(scratch):
    shutil.move(str(case_dir(scratch, "S1b")), str(scratch / "dev" / "S1b_clean_legitimate_differences"))
    e = errors(scratch)
    assert "must hold exactly one case per pattern" in e or "folder" in e


def test_detects_stale_ground_truth_markdown(scratch):
    p = scratch / "ground-truth.md"
    p.write_text(p.read_text() + "\nhand edit\n")
    assert "stale" in errors(scratch)


def test_detects_test_split_used_for_tuning(scratch):
    cfg = scratch.parent / "backend" / "config"
    cfg.mkdir(parents=True)
    (cfg / "engine.json").write_text('{"tuneOn": "samples/test/S1b"}')
    assert "tune on samples/dev only" in errors(scratch)
