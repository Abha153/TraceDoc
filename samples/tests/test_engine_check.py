"""The engine_check tooling: input shape, comparison logic, and (when node + tsx exist) a real end-to-end run."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SAMPLES = REPO / "samples"
sys.path.insert(0, str(SAMPLES / "engine_check"))

import compare as C  # noqa: E402
import make_inputs as M  # noqa: E402

ENGINE_DIR = REPO / "backend" / "src" / "engine"
REQUIRED_FIELD = {"fieldId", "docId", "name", "rawValue", "normalizedValue", "ocrConfidence", "extractionConfidence",
                  "validationStatus", "region", "source"}
ALIASES_FILE = (ENGINE_DIR / "assertions.ts").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def inputs():
    return M.build_inputs(SAMPLES)


def test_inputs_cover_all_16_cases_with_contract_shaped_documents(inputs):
    assert len(inputs) == 16
    for cid, payload in inputs.items():
        assert payload["caseId"] == cid and 3 <= len(payload["documents"]) <= 4
        for d in payload["documents"]:
            assert {"docId", "pages", "fields", "signals", "analyzerStatuses", "provenance"} <= set(d)
            assert d["signals"] == [], "no forensic signal is invented"
            assert d["analyzerStatuses"]["ocr"] == "AVAILABLE"
            assert all(v == "UNAVAILABLE" for k, v in d["analyzerStatuses"].items() if k != "ocr"), "never reported as clean"
            for f in d["fields"]:
                assert REQUIRED_FIELD <= set(f) and f["region"]["docId"] == d["docId"]


def test_identifying_fields_use_names_the_engine_accepts(inputs):
    for payload in inputs.values():
        for d in payload["documents"]:
            names = {f["name"] for f in d["fields"]}
            if d["pages"][0]["docType"] != "bank_statement":
                assert "id_number" in names, f"{d['docId']} needs an id_number so the engine can link it"
            for n in names & {"id_number", "date_of_birth", "full_name", "requested_loan_amount", "txn_amount"}:
                assert f'"{n}"' in ALIASES_FILE, n


def test_application_forms_print_applicant_and_guarantor_id_numbers(inputs):
    for payload in inputs.values():
        form = next(d for d in payload["documents"] if d["pages"][0]["docType"] == "application_form")
        assert {"id_number", "guarantor_id_number"} <= {f["name"] for f in form["fields"]}


# ------------------------------------------------------------------ comparison logic on canned engine output
def finding(t, sev, docs):
    return {"type": t, "severity": sev, "documents": docs}


def engine(findings=(), entities=()):
    return {"findings": [{**f, "docs": f["documents"]} for f in findings], "entities": list(entities)}


def test_compare_passes_when_required_found():
    exp = [finding("DOB_CONFLICT", "high", ["a", "b"])]
    r = C.compare_case("S3a", exp, engine(exp))
    assert not (r["missed"] or r["unexpected"] or r["problems"])


def test_compare_reports_a_miss_and_a_false_positive_separately():
    exp = [finding("DOB_CONFLICT", "high", ["a", "b"])]
    r = C.compare_case("S3a", exp, engine([finding("NAME_VARIANT_SPELLING", "low", ["a", "b"])]))
    assert len(r["missed"]) == 1 and len(r["unexpected"]) == 1


def test_compare_treats_optional_findings_as_optional_both_ways():
    opt = {**finding("NAME_VARIANT_SPELLING", "low", ["a", "c"]), "scoring": "optional"}
    assert not C.compare_case("S2a", [opt], engine())["missed"]
    r = C.compare_case("S2a", [opt], engine([opt]))
    assert not r["unexpected"] and len(r["optional_found"]) == 1


def test_compare_ignores_forensic_findings_because_no_analyzer_ran():
    exp = [finding("REGION_EVENT", "medium", ["a"])]
    r = C.compare_case("S6a", exp, engine())
    assert not r["missed"]


def test_s4_requires_two_separate_resolved_entities():
    good = [{"role": "applicant", "resolution": "RESOLVED"}, {"role": "guarantor", "resolution": "RESOLVED"}]
    assert not C.compare_case("S4a", [], engine(entities=good))["problems"]
    merged = [{"role": "applicant", "resolution": "RESOLVED"}]
    assert C.compare_case("S4a", [], engine(entities=merged))["problems"]
    unresolved = [{"role": "applicant", "resolution": "RESOLVED"}, {"role": "guarantor", "resolution": "UNRESOLVED"}]
    assert C.compare_case("S4a", [], engine(entities=unresolved))["problems"]


def test_known_gap_is_reported_not_hidden(tmp_path, capsys):
    results = {}
    for split in ("dev", "test"):
        for d in (SAMPLES / split).iterdir():
            cid = json.loads((d / "case.json").read_text())["caseId"]
            exp = json.loads((d / "expected_findings.json").read_text())["findings"]
            ents = [{"role": "applicant", "resolution": "RESOLVED"}, {"role": "guarantor", "resolution": "RESOLVED"}]
            results[cid] = engine([f for f in exp if f["type"] not in C.FORENSIC and cid != "S7a"], ents)
    p = tmp_path / "out.json"
    p.write_text(json.dumps(results))
    assert C.main([str(p)]) == 0
    out = capsys.readouterr().out
    assert "KNOWN GAP" in out and "S7a" in out
    results["S7b"] = engine()          # a miss that is NOT a known gap must fail the run
    p.write_text(json.dumps(results))
    assert C.main([str(p)]) == 1


# ------------------------------------------------------------------ end to end with the real engine
@pytest.mark.skipif(
    not (
        shutil.which("node")
        and (ENGINE_DIR / "node_modules" / "tsx" / "dist" / "cli.mjs").exists()
    ),
    reason="needs node and tsx installed in backend/src/engine",
)
def test_real_engine_matches_expectations(tmp_path):
    M.build_inputs(SAMPLES, tmp_path / "in")
    out = tmp_path / "out.json"
    node = shutil.which("node")
    tsx_cli = ENGINE_DIR / "node_modules" / "tsx" / "dist" / "cli.mjs"

    subprocess.run(
        [node, str(tsx_cli), "../../../samples/engine_check/run.ts",
         str(tmp_path / "in"), str(out)],
        cwd=ENGINE_DIR,
        check=True,
        capture_output=True,
        timeout=300,
    )
    assert C.main([str(out)]) == 0
