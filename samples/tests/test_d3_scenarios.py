"""D3 verification: 8 patterns x 2 variants, expectations that point at real documents and regions.

Run from the repo root:  python -m pytest samples/tests/test_d3_scenarios.py -v
"""
from __future__ import annotations

import json
import re
import sys
from decimal import Decimal
from pathlib import Path

import pdfplumber
import pikepdf
import pytest
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from samples.generator import scenarios as S  # noqa: E402
from samples.generator import tamper as T  # noqa: E402

PATTERN_IDS = [p for p, _ in S.PATTERNS]


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    out = tmp_path_factory.mktemp("d3")
    idx = S.build_all(out, flat=True)
    cases = {}
    for c in idx["cases"]:
        d = out / c["dir"]
        cases[c["caseId"]] = {
            "dir": d,
            "case": json.loads((d / "case.json").read_text(encoding="utf-8")),
            "findings": json.loads((d / "expected_findings.json").read_text(encoding="utf-8"))["findings"],
            "non": json.loads((d / "expected_non_findings.json").read_text(encoding="utf-8"))["non_findings"],
        }
    return out, idx, cases


def docs(c):
    return {d["doc_id"]: d for d in c["case"]["documents"]}


def field(doc, name):
    return next(f for f in doc["fields"] if f["name"] == name)


def inside(b):
    x, y, w, h = b
    return x >= 0 and y >= 0 and w > 0 and h > 0 and x + w <= 1 + 1e-6 and y + h <= 1 + 1e-6


# ------------------------------------------------------------------ structure
def test_all_patterns_and_both_variants(built):
    _, idx, cases = built
    assert len(cases) == 16
    for p in PATTERN_IDS:
        for v in "ab":
            assert f"{p}{v}" in cases
    assert {c["split"] for c in idx["cases"] if c["variant"] == "a"} == {"dev"}
    assert {c["split"] for c in idx["cases"] if c["variant"] == "b"} == {"test"}


def test_every_case_has_the_three_files(built):
    _, _, cases = built
    for cid, c in cases.items():
        for name in ("case.json", "expected_findings.json", "expected_non_findings.json"):
            assert (c["dir"] / name).is_file(), (cid, name)
        assert c["case"]["fictional"] is True and c["case"]["bbox_format"] == "xywh"


def test_documents_exist_open_and_hash(built):
    _, _, cases = built
    for cid, c in cases.items():
        for d in c["case"]["documents"]:
            p = c["dir"] / d["file"]
            assert p.is_file(), (cid, d["file"])
            assert T.sha256_file(p) == d["sha256"], (cid, d["file"])
            if p.suffix == ".pdf":
                with pikepdf.open(p) as pdf:
                    assert len(pdf.pages) == 1
            else:
                with Image.open(p) as im:
                    im.load()
            for f in d["fields"]:
                assert inside(f["region"]["bbox"]), (cid, d["doc_id"], f["name"])
                assert f["region"]["docId"] == d["doc_id"]


def test_sample_marker_on_every_document(built):
    _, _, cases = built
    for c in cases.values():
        for d in c["case"]["documents"]:
            assert any(f["name"] == "sample_marker" for f in d["fields"])


# ------------------------------------------------------------------ expectations reference real things
def _check_evidence(c, ev):
    d = docs(c)[ev["docId"]]
    f = field(d, ev["field"])
    assert f["region"] == ev["region"] and inside(ev["region"]["bbox"])
    assert f["text"] == ev["text"] and f["value"] == ev["value"], "evidence quotes the document's own content"


def test_expectations_reference_real_documents_and_regions(built):
    _, _, cases = built
    for cid, c in cases.items():
        ds = docs(c)
        gts = {g["id"]: g for g in c["case"]["tamper_ground_truth"]}
        for f in c["findings"]:
            assert set(f["documents"]) <= set(ds), (cid, f["expectedId"])
            for ev in f.get("evidence", []):
                _check_evidence(c, ev)
            if "tamperRef" in f:
                g = gts[f["tamperRef"]]
                assert f["region"] == g["region"] and g["doc_id"] in f["documents"]
        for n in c["non"]:
            assert set(n["documents"]) <= set(ds), (cid, n["nonFindingId"])
            for ev in n["fields"]:
                _check_evidence(c, ev)
        ids = [f["expectedId"] for f in c["findings"]] + [n["nonFindingId"] for n in c["non"]]
        assert len(ids) == len(set(ids)), f"{cid}: duplicate expectation ids"


def test_tamper_ground_truth_files_and_boxes(built):
    _, _, cases = built
    n = 0
    for cid, c in cases.items():
        for g in c["case"]["tamper_ground_truth"]:
            n += 1
            assert (c["dir"] / g["file"]).is_file() and (c["dir"] / g["source_file"]).is_file()
            assert T.sha256_file(c["dir"] / g["file"]) == g["sha256"]
            assert inside(g["bbox"]) and g["role"] == "tampered" and g["expected_finding"] is True
            assert g["doc_id"] in docs(c) and docs(c)[g["doc_id"]]["role"] == "tampered"
    assert n == 4, "S5 and S6 have one edit each, two variants"


def test_no_intent_language(built):
    _, _, cases = built
    banned = re.compile(r"fraud|forg|intention|deliberate|malicious|\bcheat", re.I)
    for cid, c in cases.items():
        blob = json.dumps([c["findings"], c["non"]])
        assert not banned.search(blob), cid


def test_findings_never_contradict_non_findings(built):
    """A legitimate difference must not also be an expected finding."""
    _, _, cases = built
    for cid, c in cases.items():
        pairs = {frozenset((e["docId"], e["field"]) for e in n["fields"]) for n in c["non"] if len(n["fields"]) == 2}
        for f in c["findings"]:
            ev = frozenset((e["docId"], e["field"]) for e in f.get("evidence", []))
            assert ev not in pairs, (cid, f["expectedId"])


# ------------------------------------------------------------------ per pattern semantics
@pytest.mark.parametrize("cid", ["S1a", "S1b", "S4a", "S4b", "S8a", "S8b"])
def test_clean_cases_expect_no_findings(built, cid):
    _, _, cases = built
    assert cases[cid]["findings"] == []
    assert all(d["role"] != "tampered" for d in cases[cid]["case"]["documents"])


@pytest.mark.parametrize("cid", ["S1a", "S1b"])
def test_s1_legitimate_differences_are_non_findings(built, cid):
    _, _, cases = built
    c = cases[cid]
    legit = [n for n in c["non"] if "legitimateDifferenceId" in n]
    assert len(legit) == 5
    assert {n["ruleId"] for n in legit} >= {"R-ADDR-MAY-DIFFER", "R-AMOUNT-NOT-COMPARABLE"}
    for n in legit:
        a, b = n["fields"]
        assert a["value"] != b["value"], "the values really do differ, yet nothing is expected"
        assert n["forbiddenTypes"] == ["*"]


@pytest.mark.parametrize("cid", ["S2a", "S2b"])
def test_s2_spelling_variant_in_engine_band(built, cid):
    _, _, cases = built
    c = cases[cid]
    f, second = c["findings"]
    assert f["type"] == second["type"] == "NAME_VARIANT_SPELLING" and f["severity"] == "low"
    assert f["observationStatus"] == "INCONSISTENT" and f["scoring"] == "required" and second["scoring"] == "optional"
    # the required pair is ID card vs application form (linked by the id_number both print)
    assert {d.split("_S2")[0] for d in f["documents"]} == {"id_card", "loan_application"}
    assert any(d.startswith("bank_statement") for d in second["documents"])
    a, b = f["evidence"]
    r = S.token_sort_ratio(a["value"], b["value"])
    assert 75 <= r < 92 and abs(r - f["tokenSortRatio"]) < 0.1
    assert a["value"].split()[0][0] == b["value"].split()[0][0]
    assert not any(x["type"] in S.FORENSIC_TYPES for x in c["findings"])


@pytest.mark.parametrize("cid", ["S3a", "S3b"])
def test_s3_dob_really_differs(built, cid):
    _, _, cases = built
    (f,) = cases[cid]["findings"]
    a, b = f["evidence"]
    assert f["type"] == "DOB_CONFLICT" and f["severity"] == "high" and f["ruleId"] == "R-DOB-MUST-AGREE"
    assert a["docId"] != b["docId"] and a["value"] != b["value"]
    assert all(d["role"] == "genuine" for d in cases[cid]["case"]["documents"]), "no pixel edit involved"


@pytest.mark.parametrize("cid", ["S4a", "S4b"])
def test_s4_similar_names_different_people(built, cid):
    _, _, cases = built
    c = cases[cid]
    ds = docs(c)
    app = ds[f"loan_application_{cid}"]
    a, g = field(app, "full_name")["value"], field(app, "guarantor_full_name")["value"]
    assert a != g and S.token_sort_ratio(a, g) >= 80
    ida = field(ds[f"id_card_{cid}"], "id_number")["value"]
    idg = field(ds[f"id_card_guarantor_{cid}"], "id_number")["value"]
    assert ida != idg
    people = {p["role"]: p for p in c["case"]["persons"]}
    assert people["applicant"]["date_of_birth"] != people["guarantor"]["date_of_birth"]
    nf = next(n for n in c["non"] if n["nonFindingId"] == "NF-050")
    assert nf["entityExpectations"][1]["mustNotMergeWith"] == c["case"]["persons"][0]["person_id"]
    assert field(ds[f"id_card_guarantor_{cid}"], "full_name")["true_entity_role"] == "guarantor"


@pytest.mark.parametrize("cid", ["S5a", "S5b"])
def test_s5_tampered_with_inconsistency(built, cid):
    _, _, cases = built
    c = cases[cid]
    dob, tam = c["findings"]
    assert dob["type"] == "DOB_CONFLICT" and tam["type"] in ("REGION_EVENT", "TEXT_LAYER_MISMATCH")
    assert dob["relatedFindings"] == ["EF-002"] and tam["relatedFindings"] == ["EF-001"]
    a, b = dob["evidence"]
    assert a["value"] != b["value"]
    (g,) = c["case"]["tamper_ground_truth"]
    edited = docs(c)[g["doc_id"]]
    ev = next(e for e in dob["evidence"] if e["docId"] == g["doc_id"])
    assert ev["region"]["bbox"] == field(edited, "date_of_birth")["region"]["bbox"]
    # the edit's ground-truth region covers the edited DOB field
    gx, gy, gw, gh = g["bbox"]
    ex, ey, ew, eh = ev["region"]["bbox"]
    assert gx <= ex + 1e-3 and gy <= ey + 1e-3 and gx + gw >= ex + ew - 1e-3 and gy + gh >= ey + eh - 1e-3
    assert field(edited, "date_of_birth")["genuine_value"] != field(edited, "date_of_birth")["value"]
    assert (c["dir"] / "_genuine_source").is_dir()


@pytest.mark.parametrize("cid", ["S6a", "S6b"])
def test_s6_tampered_without_inconsistency(built, cid):
    _, _, cases = built
    c = cases[cid]
    (f,) = c["findings"]
    assert f["type"] in ("REGION_EVENT", "TEXT_LAYER_MISMATCH")
    assert not [x for x in c["findings"] if x["category"] == "cross_document"]
    (g,) = c["case"]["tamper_ground_truth"]
    edited = docs(c)[g["doc_id"]]
    assert edited["role"] == "tampered"
    nf = next(n for n in c["non"] if n["nonFindingId"] == "NF-060")
    assert "DOB_CONFLICT" in nf["forbiddenTypes"]
    # no printed value was changed (font only / signature only), so nothing comparable can conflict
    assert not [x for x in edited["fields"] if x.get("edited")]


@pytest.mark.parametrize("cid", ["S7a", "S7b"])
def test_s7_printed_total_really_wrong(built, cid):
    _, _, cases = built
    c = cases[cid]
    (f,) = c["findings"]
    assert f["type"] == "STATEMENT_TOTAL_MISMATCH" and f["ruleId"] == "R-STMT-TOTAL-ARITH"
    st = docs(c)[f"bank_statement_{cid}"]
    key = "debit" if "debits" in f["evidence"][0]["field"] else "credit"
    listed = sum(Decimal(x["value"]) for x in st["fields"] if re.fullmatch(rf"transaction_\d+_{key}", x["name"]))
    printed = Decimal(f["evidence"][0]["value"])
    assert printed != listed and Decimal(f["listedSum"]) == listed and Decimal(f["printedTotal"]) == printed
    # the PDF text layer prints the wrong total, and the file is otherwise internally consistent
    with pdfplumber.open(c["dir"] / st["file"]) as p:
        assert f"{printed:,.2f}" in (p.pages[0].extract_text() or "")
    od = {x["name"]: Decimal(x["value"]) for x in st["fields"] if x["name"] in ("opening_balance", "closing_balance")}
    rows = [x for x in st["fields"] if re.fullmatch(r"transaction_\d+_(debit|credit)", x["name"])]
    net = sum(Decimal(x["value"]) * (1 if x["name"].endswith("credit") else -1) for x in rows)
    assert od["opening_balance"] + net == od["closing_balance"]


@pytest.mark.parametrize("cid", ["S8a", "S8b"])
def test_s8_controls_are_recompressed_only(built, cid):
    _, _, cases = built
    c = cases[cid]
    ds = c["case"]["documents"]
    assert len(ds) == 3 and all(d["role"] == "control" and d["variant"] == "recompressed" for d in ds)
    assert all(d["file"].endswith(".jpg") and d["control"] == "recompressed_only" for d in ds)
    assert all(n["forbiddenTypes"] in (S.FORENSIC_TYPES, ["*"]) for n in c["non"])
    q = 85 if cid == "S8a" else 70
    assert all(d["scan"]["jpeg_quality"] == q for d in ds)


# ------------------------------------------------------------------ people and determinism
def test_people_are_unique_and_pools_split_disjoint(built):
    _, _, cases = built
    names, idnums, surnames = [], [], {"dev": set(), "test": set()}
    for cid, c in cases.items():
        for p in c["case"]["persons"]:
            names.append(p["full_name"].lower())
            idnums.append(p["id_number"])
            surnames[S.SPLITS[cid[-1]]].add(p["full_name"].split()[-1])
    assert len(names) == len(set(names)) == 32 and len(idnums) == len(set(idnums))
    dev_pool, test_pool = set(S.LAST[0::2]), set(S.LAST[1::2])
    assert not (dev_pool & test_pool)
    # respelled surnames (S2/S4) are new strings; no surname of one split appears in the other split
    assert not (surnames["dev"] & surnames["test"])
    assert not (surnames["dev"] & test_pool) and not (surnames["test"] & dev_pool)


def test_build_is_deterministic(built, tmp_path):
    out, idx, cases = built
    S.build_all(tmp_path, flat=True)
    for c in idx["cases"]:
        a = json.loads((out / c["dir"] / "case.json").read_text())
        b = json.loads((tmp_path / c["dir"] / "case.json").read_text())
        assert a == b, c["caseId"]
        for name in ("expected_findings.json", "expected_non_findings.json"):
            assert (out / c["dir"] / name).read_bytes() == (tmp_path / c["dir"] / name).read_bytes()
