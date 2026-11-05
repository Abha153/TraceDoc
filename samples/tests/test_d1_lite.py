"""D1-lite verification. Run from the repo root:  python -m pytest samples/tests -v

Checks (independent of the generator's own bookkeeping where possible):
  * determinism            two fresh runs are byte-identical, and match the committed files
  * file set / hashes      exactly the 6 documents, sha256 + sizes agree with manifest.json
  * PDFs                   open, 1 page, searchable text layer (pypdf AND pdfplumber)
  * persons.json           is the single source: every manifest value traces back to it
  * statement arithmetic   running balances and totals recomputed with Decimal
  * bbox vs PDF text       pdfplumber word boxes inside each bbox spell the field text
  * bbox vs pixels         ink lives inside each bbox (originals, rasterised PDFs, de-rotated scans)
  * bbox vs OCR (optional) tesseract on the cropped bbox reads the field text
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from decimal import Decimal
from difflib import SequenceMatcher
from pathlib import Path

import pytest
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
SAMPLES = REPO / "samples"
sys.path.insert(0, str(REPO))

from samples.generator.generate import generate  # noqa: E402
from samples.generator.scan import rasterize_pdf  # noqa: E402

SET_IDS = ("001", "002")
STEMS = ("id_card", "loan_application", "bank_statement")
EXT = {"id_card": "png", "loan_application": "pdf", "bank_statement": "pdf"}
SUFFIXES = ("", "_scan", "_scan_hard", "_recompressed")
BASE_IDS = [f"{st}_{sid}" for sid in SET_IDS for st in STEMS]            # originals
PDF_IDS = [f"{st}_{sid}" for sid in SET_IDS for st in STEMS[1:]]
DOC_IDS = [f"{st}_{sid}{sx}" for sid in SET_IDS for st in STEMS for sx in SUFFIXES]   # manifest order
OCR_IDS = [f"{st}_{sid}{sx}" for sid in SET_IDS for st in STEMS for sx in ("", "_scan")]
EXPECTED_FILES = {
    f"genuine/{st}_{sid}{sx}.{EXT[st] if sx == '' else 'jpg'}"
    for sid in SET_IDS for st in STEMS for sx in SUFFIXES}
PERSONS_FILES = {"001": "persons.json", "002": "persons_002.json"}


# ----------------------------------------------------------------------------- fixtures
@pytest.fixture(scope="session")
def run_a(tmp_path_factory):
    d = tmp_path_factory.mktemp("run_a")
    generate(d)
    return d


@pytest.fixture(scope="session")
def run_b(tmp_path_factory):
    d = tmp_path_factory.mktemp("run_b")
    generate(d)
    return d


@pytest.fixture(scope="session")
def manifest(run_a):
    return json.loads((run_a / "manifest.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def persons_by_set(run_a):
    return {sid: json.loads((run_a / f).read_text(encoding="utf-8")) for sid, f in PERSONS_FILES.items()}


def docs_by_id(manifest):
    return {d["doc_id"]: d for d in manifest["documents"]}


def all_files(root: Path):
    out = list(PERSONS_FILES.values()) + ["manifest.json"] + sorted(EXPECTED_FILES)
    return [root / f for f in out]


# ------------------------------------------------------------------------ determinism
def test_two_runs_are_byte_identical(run_a, run_b):
    for fa, fb in zip(all_files(run_a), all_files(run_b)):
        assert fa.read_bytes() == fb.read_bytes(), f"non-deterministic output: {fa.name}"


def _strip_hashes(m):
    m = json.loads(json.dumps(m))
    for d in m["documents"]:
        d.pop("sha256"), d.pop("bytes")
    return m


def test_committed_samples_match_a_fresh_run(run_a):
    """Committed persons + manifest equal a fresh run. File *bytes* depend on the Pillow/libjpeg/
    reportlab build (PNG/zlib streams), so they are compared only with TRACEDOCS_STRICT_BYTES=1;
    by default the committed files must instead be self-consistent (next test)."""
    for rel in PERSONS_FILES.values():
        assert (SAMPLES / rel).read_bytes() == (run_a / rel).read_bytes(), f"stale committed file {rel}"
    committed = json.loads((SAMPLES / "manifest.json").read_text(encoding="utf-8"))
    fresh = json.loads((run_a / "manifest.json").read_text(encoding="utf-8"))
    assert _strip_hashes(committed) == _strip_hashes(fresh), "committed manifest is stale"
    if os.environ.get("TRACEDOCS_STRICT_BYTES") == "1":
        for rel in ["manifest.json"] + sorted(EXPECTED_FILES):
            assert (SAMPLES / rel).read_bytes() == (run_a / rel).read_bytes(), f"bytes differ: {rel}"


def test_committed_files_match_committed_manifest_hashes():
    """The hand-over check: every committed file has the sha256/size recorded in manifest.json."""
    r = subprocess.run([sys.executable, str(SAMPLES / "verify_hashes.py")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout


# ----------------------------------------------------------------------- file set / manifest
def test_exactly_the_expected_files(run_a, manifest):
    on_disk = {p.relative_to(run_a).as_posix() for p in (run_a / "genuine").iterdir()}
    on_disk = {f"genuine/{Path(p).name}" for p in on_disk}
    assert on_disk == EXPECTED_FILES
    assert {d["file"] for d in manifest["documents"]} == EXPECTED_FILES
    assert [d["doc_id"] for d in manifest["documents"]] == DOC_IDS


def test_manifest_structure_hashes_and_bbox_ranges(run_a, manifest):
    from samples.generator.common import sha256_file
    assert manifest["fictional"] is True
    assert manifest["persons_file"] == "persons.json" and manifest["persons_files"] == PERSONS_FILES
    for d in manifest["documents"]:
        p = run_a / d["file"]
        assert p.exists() and p.stat().st_size == d["bytes"] > 0
        assert sha256_file(p) == d["sha256"]
        assert d["role"] == "genuine"
        names = [f["name"] for f in d["fields"]]
        assert len(names) == len(set(names)), f"duplicate field names in {d['doc_id']}"
        assert "sample_marker" in names
        for f in d["fields"]:
            x0, y0, x1, y1 = f["bbox"]
            assert 0.0 <= x0 < x1 <= 1.0 and 0.0 <= y0 < y1 <= 1.0, (d["doc_id"], f["name"], f["bbox"])
            assert f["page"] == 1
            if f["field_type"] in ("signature", "photo"):
                assert f["text"] is None and f["value"] is None
            else:
                assert isinstance(f["text"], str) and f["text"] and f["value"] is not None
        assert d["set"] in SET_IDS and d["doc_id"].split("_")[-1 if d["variant"] == "original" else
                                      {"scan": -2, "scan_hard": -3, "recompressed": -2}[d["variant"]]] in SET_IDS
        if d["variant"] == "scan":
            assert d["derived_from"] in {x["doc_id"] for x in manifest["documents"]}
            assert 0.5 <= abs(d["scan"]["rotation_deg"]) <= 1.2          # "slight rotation"
            assert d["format"] == "jpg" and d["scan"]["jpeg_quality"] < 95  # compressed
        elif d["variant"] == "scan_hard":
            assert d["derived_from"] in {x["doc_id"] for x in manifest["documents"]}
            assert 2.0 <= abs(d["scan"]["rotation_deg"]) <= 3.5 and d["scan"]["jpeg_quality"] <= 50
        elif d["variant"] == "recompressed":
            assert d["control"] == "recompressed_only" and d["scan"]["content_changed"] is False
            assert d["scan"]["rotation_deg"] == 0.0 and d["derived_from"]
        else:
            assert d["variant"] == "original" and d["derived_from"] is None and "control" not in d


def test_scans_have_same_values_as_originals(manifest):
    by = docs_by_id(manifest)
    for d in manifest["documents"]:
        if d["variant"] == "original":
            continue
        src = by[d["derived_from"]]
        key = lambda f: (f["name"], f["text"], f["value"], f["semantic_type"], f["true_person_id"])  # noqa: E731
        assert [key(f) for f in d["fields"]] == [key(f) for f in src["fields"]]


# ----------------------------------------------------------------------------- PDFs
@pytest.mark.parametrize("doc_id", PDF_IDS)
def test_pdf_opens_and_has_searchable_text_layer(run_a, manifest, doc_id):
    import pdfplumber
    from pypdf import PdfReader
    d = docs_by_id(manifest)[doc_id]
    path = run_a / d["file"]
    assert path.read_bytes().startswith(b"%PDF-")
    reader = PdfReader(str(path))
    assert len(reader.pages) == 1
    pypdf_text = reader.pages[0].extract_text()
    with pdfplumber.open(str(path)) as pdf:
        assert len(pdf.pages) == 1
        plumber_text = pdf.pages[0].extract_text()
    assert d["has_text_layer"] is True
    for f in d["fields"]:
        if f["text"]:
            assert f["text"] in plumber_text, f"{f['name']} not in text layer (pdfplumber)"
            assert f["text"] in pypdf_text, f"{f['name']} not in text layer (pypdf)"
    assert "SAMPLE" in plumber_text


def _form_expectations(persons):
    by = {p["person_id"]: p for p in persons["persons"]}
    app = persons["loan_application"]
    a, g = by[app["applicant_id"]], by[app["guarantor_id"]]
    from samples.generator.common import fmt_address
    return {
        "full_name": a["full_name"], "date_of_birth": a["date_of_birth"],
        "permanent_address": fmt_address(a["permanent_address"]),
        "current_address": fmt_address(a["current_address"]),
        "requested_loan_amount": app["requested_amount"],
        "loan_term_months": str(app["term_months"]), "loan_purpose": app["purpose"],
        "application_number": app["application_no"], "application_date": app["application_date"],
        "guarantor_full_name": g["full_name"], "guarantor_date_of_birth": g["date_of_birth"],
        "guarantor_relationship": app["guarantor_relationship"],
        "applicant_signature_date": app["application_date"],
        "guarantor_signature_date": app["application_date"],
    }


@pytest.mark.parametrize("sid", SET_IDS)
def test_values_trace_back_to_persons_json(manifest, persons_by_set, sid):
    persons = persons_by_set[sid]
    by = docs_by_id(manifest)
    assert persons["_meta"]["fictional"] is True

    exp = _form_expectations(persons)
    vals = {f["name"]: f["value"] for f in by[f"loan_application_{sid}"]["fields"]}
    for k, v in exp.items():
        assert vals[k] == v, k
    assert {"applicant_signature", "guarantor_signature"} <= set(vals)

    applicant = persons["persons"][0]
    idv = {f["name"]: f["value"] for f in by[f"id_card_{sid}"]["fields"]}
    assert idv["full_name"] == applicant["full_name"]
    assert idv["date_of_birth"] == applicant["date_of_birth"]
    assert idv["id_number"] == applicant["id_number"]
    assert idv["permanent_address"] == exp["permanent_address"]
    assert idv["issue_date"] == applicant["id_issue_date"] and idv["expiry_date"] == applicant["id_expiry_date"]
    assert {"photo", "signature"} <= set(idv)
    # ID text is upper-case; value keeps the true value
    texts = {f["name"]: f["text"] for f in by[f"id_card_{sid}"]["fields"]}
    assert texts["full_name"] == applicant["full_name"].upper()

    acct = persons["bank_account"]
    sv = {f["name"]: f["value"] for f in by[f"bank_statement_{sid}"]["fields"]}
    assert sv["account_holder"] == applicant["full_name"]
    assert sv["account_number"] == acct["account_number"]
    assert sv["opening_balance"] == acct["opening_balance"]
    for i, t in enumerate(acct["transactions"], start=1):
        assert sv[f"transaction_{i:02d}_date"] == t["date"]
        assert sv[f"transaction_{i:02d}_description"] == t["description"]
        assert sv.get(f"transaction_{i:02d}_debit") == t["debit"]
        assert sv.get(f"transaction_{i:02d}_credit") == t["credit"]


def test_fictional_markers_and_no_real_id_format(persons_by_set, manifest):
    ids = {p["id_number"] for ps in persons_by_set.values() for p in ps["persons"]}
    assert len(ids) == 4
    assert all(re.fullmatch(r"SMP-\d{4}-\d{4}-[A-Z]{2}", i) for i in ids)
    for d in manifest["documents"]:
        marker = next(f for f in d["fields"] if f["name"] == "sample_marker")
        assert "SAMPLE" in marker["text"]


@pytest.mark.parametrize("sid", SET_IDS)
def test_statement_arithmetic(manifest, persons_by_set, sid):
    persons = persons_by_set[sid]
    d = docs_by_id(manifest)[f"bank_statement_{sid}"]
    v = {f["name"]: f["value"] for f in d["fields"]}
    bal = Decimal(v["opening_balance"])
    td = tc = Decimal("0")
    n = len(persons["bank_account"]["transactions"])
    assert n >= 10
    for i in range(1, n + 1):
        deb = Decimal(v[f"transaction_{i:02d}_debit"]) if f"transaction_{i:02d}_debit" in v else None
        cre = Decimal(v[f"transaction_{i:02d}_credit"]) if f"transaction_{i:02d}_credit" in v else None
        assert (deb is None) != (cre is None), "each row is exactly one of debit/credit"
        bal += (cre or 0) - (deb or 0)
        td += deb or 0
        tc += cre or 0
        assert Decimal(v[f"transaction_{i:02d}_balance"]) == bal, f"row {i} running balance"
        assert bal >= 0
    closing = Decimal(v["opening_balance"]) + tc - td
    assert bal == closing
    for k, want in (("total_debits", td), ("total_credits", tc), ("closing_balance", closing),
                    ("table_total_debits", td), ("table_total_credits", tc), ("table_closing_balance", closing)):
        assert Decimal(v[k]) == want, k
    # printed text must agree with the machine values
    t = {f["name"]: f["text"] for f in d["fields"]}
    for k in ("opening_balance", "total_debits", "total_credits", "closing_balance"):
        assert Decimal(t[k].replace(",", "")) == Decimal(v[k])


# ----------------------------------------------------------------- bbox vs PDF word boxes
@pytest.mark.parametrize("doc_id", PDF_IDS)
def test_bbox_matches_pdf_text_words(run_a, manifest, doc_id):
    import pdfplumber
    d = docs_by_id(manifest)[doc_id]
    with pdfplumber.open(str(run_a / d["file"])) as pdf:
        page = pdf.pages[0]
        W, H = float(page.width), float(page.height)
        words = page.extract_words()
    assert (W, H) == (d["pages"][0]["width_pt"], d["pages"][0]["height_pt"])
    bad = []
    for f in d["fields"]:
        if not f["text"]:
            continue
        x0, y0, x1, y1 = f["bbox"][0] * W, f["bbox"][1] * H, f["bbox"][2] * W, f["bbox"][3] * H
        inside = [w for w in words
                  if x0 <= (w["x0"] + w["x1"]) / 2 <= x1 and y0 <= (w["top"] + w["bottom"]) / 2 <= y1]
        got = " ".join(w["text"] for w in sorted(inside, key=lambda w: (round(w["top"]), w["x0"])))
        if got != f["text"]:
            bad.append((f["name"], f["text"], got))
        # the box must also hug the words (no big empty margins)
        if inside:
            wx0, wx1 = min(w["x0"] for w in inside), max(w["x1"] for w in inside)
            if x0 > wx0 + 0.5 or x1 < wx1 - 0.5 or (wx0 - x0) > 3 or (x1 - wx1) > 3:
                bad.append((f["name"], "box not tight horizontally", (x0, x1, wx0, wx1)))
    assert not bad, bad


# ------------------------------------------------------------------- bbox vs rendered pixels
INK = 150


def _mask(gray, thr=INK):
    return gray.point([255 if v < thr else 0 for v in range(256)])


def _ink_report(gray, bbox, ring=4):
    """Ink pixels inside bbox, ink in a thin ring just outside, and ink extent inside."""
    W, H = gray.size
    x0, y0 = int(round(bbox[0] * W)), int(round(bbox[1] * H))
    x1, y1 = int(round(bbox[2] * W)), int(round(bbox[3] * H))
    inside = _mask(gray.crop((x0, y0, x1, y1)))
    n_in = inside.histogram()[255]
    ext = inside.getbbox()
    px0, py0, px1, py1 = max(0, x0 - ring), max(0, y0 - ring), min(W, x1 + ring), min(H, y1 + ring)
    n_ring = _mask(gray.crop((px0, py0, px1, py1))).histogram()[255] - n_in
    return {"n_in": n_in, "n_ring": n_ring, "ext": ext, "w": x1 - x0, "h": y1 - y0}


def _check_ink(gray, fields, tag, ring=4, ring_ratio=0.08, tight=True):
    bad = []
    for f in fields:
        r = _ink_report(gray, f["bbox"], ring)
        name = f["name"]
        if r["n_in"] < 15:
            bad.append((tag, name, "no ink inside bbox", r["n_in"]))
            continue
        if r["n_ring"] > ring_ratio * r["n_in"]:
            bad.append((tag, name, "ink leaks outside bbox", r["n_ring"], r["n_in"]))
        if tight and f["field_type"] not in ("photo", "marker"):
            ex = r["ext"]
            gap_l, gap_r = ex[0], r["w"] - ex[2]          # px between ink and box edge
            cover_h = (ex[3] - ex[1]) / r["h"]
            # Text boxes are the string's advance width + 1pt padding, so a trailing "1"
            # (large right side-bearing in Helvetica) leaves up to ~3.6pt (10px @200dpi) blank.
            max_gap = 4 if f["field_type"] == "signature" else 10
            need_h = 0.85 if f["field_type"] == "signature" else 0.45
            if gap_l > max_gap or gap_r > max_gap or cover_h < need_h:
                bad.append((tag, name, "bbox much larger than ink", gap_l, gap_r, round(cover_h, 2)))
    return bad


def test_bbox_ink_on_originals(run_a, manifest):
    by = docs_by_id(manifest)
    bad = []
    for doc_id in BASE_IDS:
        d = by[doc_id]
        gray = (Image.open(run_a / d["file"]) if d["format"] == "png" else rasterize_pdf(run_a / d["file"])).convert("L")
        bad += _check_ink(gray, d["fields"], doc_id)
    assert not bad, bad


@pytest.mark.parametrize("doc_id", BASE_IDS)
def test_scan_bboxes_after_deskew(run_a, manifest, doc_id):
    """Rotate the scan back by its recorded angle: ORIGINAL bboxes must fit it again.

    This validates the rotation maths end-to-end against real pixels (sign included).
    """
    by = docs_by_id(manifest)
    scan, orig = by[f"{doc_id}_scan"], by[doc_id]
    gray = Image.open(run_a / scan["file"]).convert("L")
    deskew = gray.rotate(-scan["scan"]["rotation_deg"], resample=Image.Resampling.BICUBIC, fillcolor=255)
    bad = _check_ink(deskew, orig["fields"], f"{doc_id}_deskewed", ring=5, ring_ratio=0.12)
    assert not bad, bad


@pytest.mark.parametrize("doc_id", BASE_IDS)
def test_scan_bboxes_on_raw_scan(run_a, manifest, doc_id):
    """On the raw (rotated) scan, the enclosing bboxes must contain the ink."""
    scan = docs_by_id(manifest)[f"{doc_id}_scan"]
    gray = Image.open(run_a / scan["file"]).convert("L")
    bad = _check_ink(gray, scan["fields"], f"{doc_id}_scan", ring=4, ring_ratio=0.12, tight=False)
    assert not bad, bad


def test_scans_are_visibly_scanned(run_a, manifest):
    """Noise + compression + shading really happened (not just a copy of the original)."""
    by = docs_by_id(manifest)
    for doc_id in BASE_IDS:
        s = Image.open(run_a / by[f"{doc_id}_scan"]["file"])
        assert s.format == "JPEG"
        gray = s.convert("L")
        # a clean page background is a single grey level; a scan has spread
        crop = gray.crop((int(s.width * .40), int(s.height * .94), int(s.width * .60), int(s.height * .985))) \
            if not doc_id.startswith("id_card") else gray.crop((800, 480, 960, 600))
        lo, hi = crop.getextrema()
        assert hi - lo >= 8, f"{doc_id}: background too clean ({lo}..{hi})"


# ------------------------------------------------------------------------ OCR cross-check
def _norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[^0-9a-z ]", "", s.lower().replace("\n", " "))).strip()


@pytest.mark.skipif(shutil.which("tesseract") is None, reason="tesseract binary not installed")
def test_ocr_reads_each_bbox(run_a, manifest):
    """Crop every text bbox from the files and OCR it - the real Person 3 use case."""
    import pytesseract
    by = docs_by_id(manifest)
    results = {}
    for doc_id in OCR_IDS:
        d = by[doc_id]
        p = run_a / d["file"]
        img = rasterize_pdf(p) if d["format"] == "pdf" else Image.open(p).convert("RGB")
        W, H = img.size
        scores = []
        for f in d["fields"]:
            if not f["text"] or f["field_type"] == "marker":
                continue
            x0, y0, x1, y1 = f["bbox"]
            pad = 8
            crop = img.crop((max(0, int(x0 * W) - pad), max(0, int(y0 * H) - pad),
                             min(W, int(x1 * W) + pad), min(H, int(y1 * H) + pad))).convert("L")
            crop = crop.resize((crop.width * 2, crop.height * 2), Image.Resampling.LANCZOS)
            psm = 6 if "\n" in f["text"] else 7
            got = pytesseract.image_to_string(crop, config=f"--psm {psm}")
            scores.append((SequenceMatcher(None, _norm(got), _norm(f["text"])).ratio(), f["name"], got.strip()))
        results[doc_id] = scores
    summary = {}
    for doc_id, sc in results.items():
        ok = sum(1 for r, *_ in sc if r >= 0.85)
        summary[doc_id] = (ok, len(sc), min(r for r, *_ in sc))
    print("\nOCR bbox cross-check (fields >=0.85 similarity / total, worst):")
    for k, v in summary.items():
        print(f"  {k:<30} {v[0]}/{v[1]}  worst={v[2]:.2f}")
    for doc_id, sc in results.items():
        floor = 0.9 if not doc_id.endswith("_scan") else 0.85
        frac = sum(1 for r, *_ in sc if r >= 0.85) / len(sc)
        worst = sorted(sc)[:3]
        assert frac >= floor, (doc_id, frac, worst)


# ----------------------------------------------------------------- D1 additions (sets, labels, variants)
def test_two_sets_with_distinct_people(persons_by_set, manifest):
    a, b = persons_by_set["001"], persons_by_set["002"]
    pa, pb = {p["person_id"] for p in a["persons"]}, {p["person_id"] for p in b["persons"]}
    assert pa == {"P001", "P002"} and pb == {"P003", "P004"}
    names = {p["full_name"] for ps in (a, b) for p in ps["persons"]}
    assert len(names) == 4
    assert a["bank_account"]["account_number"] != b["bank_account"]["account_number"]
    for sid in SET_IDS:
        info = manifest["sets"][sid]
        assert info["persons_file"] == PERSONS_FILES[sid]
        assert {d["doc_id"] for d in manifest["documents"] if d["set"] == sid} == set(info["doc_ids"])


def test_second_set_needs_no_faker():
    """persons_002.json comes from stdlib-only pools, so it cannot change with the Faker version."""
    code = ("import sys; sys.modules['faker'] = None; sys.path.insert(0, %r);"
            "from samples.generator.persons_builtin import build_persons_builtin as b;"
            "import json; print(json.dumps(b(20260102) == b(20260102)))" % str(REPO))
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert r.returncode == 0 and r.stdout.strip() == "true", r.stderr


KNOWN_SEMANTICS = {"marker", "photo", "signature", "full_name", "dob", "id_number", "address_permanent",
                   "address_current", "document_issue_date", "document_expiry_date", "application_number",
                   "document_date", "requested_amount", "loan_term_months", "loan_purpose",
                   "guarantor_relationship", "signature_date", "account_number", "statement_period",
                   "account_balance", "statement_total", "transaction_date", "transaction_description",
                   "transaction_debit", "transaction_credit", "running_balance"}


def test_every_field_has_semantic_type_region_and_ground_truth_person(manifest):
    from samples.generator.bbox import xywh_to_xyxy
    for d in manifest["documents"]:
        for f in d["fields"]:
            assert f["semantic_type"] in KNOWN_SEMANTICS, (d["doc_id"], f["name"])
            r = f["region"]
            assert r["docId"] == d["doc_id"] and r["page"] == 1 and r["label"] == f["name"]
            x, y, w, h = r["bbox"]
            assert w > 0 and h > 0 and x + w <= 1 + 1e-6 and y + h <= 1 + 1e-6
            assert all(abs(a - b) < 2e-6 for a, b in zip(xywh_to_xyxy(r["bbox"]), f["bbox"]))
            if f["name"].startswith("guarantor_"):
                assert f["true_entity_role"] == "guarantor" and f["true_person_id"] in {"P002", "P004"}
    by = docs_by_id(manifest)
    idc = {f["name"]: f for f in by["id_card_001"]["fields"]}
    assert idc["date_of_birth"]["semantic_type"] == "dob" and idc["id_number"]["true_entity_role"] == "applicant"
    st = {f["name"]: f for f in by["bank_statement_002"]["fields"]}
    assert st["account_holder"]["true_entity_role"] == "account_holder" and st["account_holder"]["true_person_id"] == "P003"
    assert st["closing_balance"]["semantic_detail"] == "closing" and st["opening_balance"]["semantic_detail"] == "opening"


def test_bbox_converters_round_trip():
    from samples.generator.bbox import to_region, xyxy_to_xywh, xywh_to_xyxy
    b = [0.1, 0.2, 0.35, 0.3]
    assert xyxy_to_xywh(b) == [0.1, 0.2, 0.25, 0.1]
    assert xywh_to_xyxy(xyxy_to_xywh(b)) == b
    assert to_region("D-01", 1, b, "dob") == {"docId": "D-01", "page": 1, "bbox": [0.1, 0.2, 0.25, 0.1], "label": "dob"}


@pytest.mark.parametrize("doc_id", [f"bank_statement_{s}{x}" for s in SET_IDS for x in SUFFIXES])
def test_statement_table_entry(manifest, persons_by_set, doc_id):
    d = docs_by_id(manifest)[doc_id]
    n = len(persons_by_set[d["set"]]["bank_account"]["transactions"])
    (t,) = d["tables"]
    fields = {f["name"]: f for f in d["fields"]}
    assert t["columns"] == ["date", "description", "debit", "credit", "balance"] and len(t["rows"]) == n
    tx0, ty0, tx1, ty1 = t["bbox"]
    for row in t["rows"]:
        assert {"date", "description", "balance"} <= set(row["cells"]) and ("debit" in row["cells"]) != ("credit" in row["cells"])
        x0, y0, x1, y1 = row["bbox"]
        for name in row["cells"].values():
            c = fields[name]["bbox"]
            assert x0 <= c[0] and y0 <= c[1] and c[2] <= x1 and c[3] <= y1
        assert tx0 <= x0 and ty0 <= y0 and x1 <= tx1 and y1 <= ty1
    assert t["rows"][0]["bbox"][1] < t["rows"][-1]["bbox"][1] < t["totals_row"]["bbox"][1] + 0.05
    assert set(t["totals_row"]["cells"].values()) <= set(fields)
    assert "tables" not in docs_by_id(manifest)[f"id_card_{d['set']}"]


def test_legitimate_differences_are_recorded_and_real(manifest):
    for sid in SET_IDS:
        lds = manifest["sets"][sid]["legitimate_differences"]
        assert {x["rule_type"] for x in lds} == {"MAY_DIFFER", "NOT_COMPARABLE"} and len(lds) >= 5
        by = docs_by_id(manifest)
        for x in lds:
            assert x["expected_finding"] is False and x["left"]["value"] != x["right"]["value"]
            for side in ("left", "right"):
                f = {f["name"]: f for f in by[x[side]["doc_id"]]["fields"]}[x[side]["field"]]
                assert f["value"] == x[side]["value"]
        concepts = {x["concept"] for x in lds}
        assert {"address_permanent vs address_current", "requested_amount vs account_balance"} <= concepts


@pytest.mark.parametrize("doc_id", BASE_IDS)
def test_hard_scan_bboxes_after_deskew(run_a, manifest, doc_id):
    by = docs_by_id(manifest)
    scan, orig = by[f"{doc_id}_scan_hard"], by[doc_id]
    gray = Image.open(run_a / scan["file"]).convert("L")
    deskew = gray.rotate(-scan["scan"]["rotation_deg"], resample=Image.Resampling.BICUBIC, fillcolor=255)
    bad = _check_ink(deskew, orig["fields"], f"{doc_id}_hard_deskewed", ring=6, ring_ratio=0.2, tight=False)
    assert not bad, bad
    # it must really be harder than the normal scan: smaller file (stronger compression)
    assert scan["bytes"] < by[f"{doc_id}_scan"]["bytes"]


@pytest.mark.parametrize("doc_id", BASE_IDS)
def test_recompressed_control_changes_nothing_but_compression(run_a, manifest, doc_id):
    from PIL import ImageChops, ImageStat
    by = docs_by_id(manifest)
    rc, orig = by[f"{doc_id}_recompressed"], by[doc_id]
    assert [f["bbox"] for f in rc["fields"]] == [f["bbox"] for f in orig["fields"]]   # no geometry change
    img = Image.open(run_a / rc["file"]).convert("L")
    ref = (Image.open(run_a / orig["file"]) if orig["format"] == "png" else rasterize_pdf(run_a / orig["file"])).convert("L")
    assert img.size == ref.size
    assert sum(ImageStat.Stat(ImageChops.difference(img, ref)).mean) < 3.0   # only JPEG noise
