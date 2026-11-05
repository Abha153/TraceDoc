"""D2 verification: every tampering operation, every control, and the ground truth.

Run from the repo root:  python -m pytest samples/tests/test_d2_tamper.py -v

Checks are made on the produced files themselves (text layer, pixels, PDF structure), not on the
generator's own bookkeeping.
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
from pathlib import Path

import pdfplumber
import pikepdf
import pypdfium2 as pdfium
import pytest
from PIL import Image, ImageChops, ImageStat

REPO = Path(__file__).resolve().parents[2]
SAMPLES = REPO / "samples"
sys.path.insert(0, str(REPO))

from samples.generator import tamper as T  # noqa: E402

REQUIRED = {"id", "type", "role", "file", "page", "bbox", "bbox_format", "region", "description",
            "expected_finding", "sha256", "source_file", "source_sha256"}


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    out = tmp_path_factory.mktemp("d2")
    gt = T.build_all(SAMPLES, out)
    return out, gt, {e["id"]: e for e in gt["entries"]}


def render(path: Path, scale: float = 200 / 72) -> Image.Image:
    return pdfium.PdfDocument(str(path))[0].render(scale=scale).to_pil().convert("RGB")


def words_text(path: Path) -> str:
    with pdfplumber.open(path) as p:
        return p.pages[0].extract_text() or ""


def px_box(e, size):
    x, y, w, h = e["bbox"]
    return (round(x * size[0]), round(y * size[1]), round((x + w) * size[0]), round((y + h) * size[1]))


def mean_diff(a: Image.Image, b: Image.Image, box=None, outside=False) -> float:
    d = ImageChops.difference(a.convert("L"), b.convert("L"))
    if box and outside:
        from PIL import ImageDraw
        ImageDraw.Draw(d).rectangle(box, fill=0)
        return ImageStat.Stat(d).mean[0] * d.size[0] * d.size[1] / max(1, d.size[0] * d.size[1] - (box[2] - box[0]) * (box[3] - box[1]))
    if box:
        d = d.crop(box)
    return ImageStat.Stat(d).mean[0]


# ------------------------------------------------------------------ helpers
def test_alter_digits_is_deterministic_and_same_length():
    assert T.alter_digits("USD 21,500.00") == "USD 51,500.00"
    assert T.alter_digits("6,143.36") == "9,143.36"
    assert T.alter_digits("1969") == T.alter_digits("1969") and len(T.alter_digits("1969")) == 4
    assert T.alter_digits("7") != "7"
    assert T.alter_digits("9") == "2"
    with pytest.raises(ValueError):
        T.alter_digits("no digits")


# ------------------------------------------------------------------ ground truth as a whole
def test_all_operations_and_controls_present(built):
    _, gt, by = built
    types = {e["type"] for e in gt["entries"] if e["role"] == "tampered"}
    assert types == set(T.TAMPER_TYPES), "all eight operations must be represented"
    ctypes = {e["type"] for e in gt["entries"] if e["role"] == "control"}
    assert ctypes == set(T.CONTROL_TYPES)
    assert len(by) == len(gt["entries"]), "ids are unique"


def test_entry_shape_and_labels(built):
    out, gt, _ = built
    assert gt["schema"] == T.GT_SCHEMA and gt["bbox_format"] == "xywh" and gt["fictional"] is True
    for e in gt["entries"]:
        assert REQUIRED <= set(e), e["id"]
        assert e["role"] in ("tampered", "control")
        assert e["expected_finding"] is (e["role"] == "tampered"), "controls must never expect a finding"
        assert e["bbox_format"] == "xywh"
        assert e["region"]["bbox"] == e["bbox"] and e["region"]["docId"] == e["doc_id"]
        if e["role"] == "control":
            assert e["id"].startswith("C-") and e["type"] in T.CONTROL_TYPES
        else:
            assert e["id"].startswith("T-") and e["type"] in T.TAMPER_TYPES


def test_files_exist_open_and_match_hash(built):
    out, gt, _ = built
    for e in gt["entries"]:
        p = out / e["file"]
        assert p.is_file(), e["file"]
        assert T.sha256_file(p) == e["sha256"]
        assert (SAMPLES / e["source_file"]).is_file()
        assert T.sha256_file(SAMPLES / e["source_file"]) == e["source_sha256"], "source must be the committed D1 file"
        if e["role"] == "tampered":
            assert p.read_bytes() != (SAMPLES / e["source_file"]).read_bytes()
        if p.suffix == ".pdf":
            with pikepdf.open(p) as pdf:
                assert len(pdf.pages) == 1
            assert render(p).size[0] > 100
        else:
            with Image.open(p) as im:
                im.load()


def test_bboxes_inside_page(built):
    out, gt, _ = built
    for e in gt["entries"]:
        x, y, w, h = e["bbox"]
        assert 0 <= x and 0 <= y and w > 0 and h > 0, e["id"]
        assert x + w <= 1 + 1e-6 and y + h <= 1 + 1e-6, f"{e['id']} bbox leaves the page"
        if "source_region" in e:
            sx, sy, sw, sh = e["source_region"]["bbox"]
            assert sx >= 0 and sy >= 0 and sx + sw <= 1 + 1e-6 and sy + sh <= 1 + 1e-6


def test_no_intent_language(built):
    _, gt, _ = built
    banned = re.compile(r"fraud|forg|intention|deliberate|malicious|\bcheat", re.I)
    blob = json.dumps(gt)
    assert not banned.search(blob), banned.search(blob)


def test_build_is_deterministic(built, tmp_path):
    _, gt1, _ = built
    gt2 = T.build_all(SAMPLES, tmp_path)
    assert [e["sha256"] for e in gt1["entries"]] == [e["sha256"] for e in gt2["entries"]]
    assert gt1 == gt2


def test_committed_ground_truth_matches_fresh_build(built):
    _, gt, _ = built
    committed = json.loads((SAMPLES / "tampered" / "ground_truth.json").read_text(encoding="utf-8"))
    strict = os.environ.get("TRACEDOCS_STRICT_BYTES") == "1"

    def norm(g):
        return [{k: v for k, v in e.items() if strict or k != "sha256"} for e in g["entries"]]
    assert norm(committed) == norm(gt)


# ------------------------------------------------------------------ 1. replace a value in a digital PDF
def test_t1_value_replaced_in_text_layer(built):
    out, _, by = built
    e = by["T-01"]
    txt = words_text(out / e["file"])
    assert e["edited_value"] in txt and e["original_value"] not in txt
    src = words_text(SAMPLES / e["source_file"])
    assert e["original_value"] in src
    # everything else on the page is unchanged
    assert txt.replace(e["edited_value"], e["original_value"]) == src


# ------------------------------------------------------------------ 2. font / size of one value
def test_t2_single_value_font_changed(built):
    out, _, by = built
    e = by["T-02"]
    assert words_text(out / e["file"]) == words_text(SAMPLES / e["source_file"]), "text itself unchanged"
    with pdfplumber.open(out / e["file"]) as p:
        chars = p.pages[0].chars
    fonts = {(c["fontname"].split("+")[-1], round(c["size"], 1)) for c in chars}
    assert ("Times-Roman", 9.5) in fonts
    odd = [c for c in chars if c["fontname"].endswith("Times-Roman")]
    assert "".join(c["text"] for c in odd) == "7,269.27", "exactly one value changed font"


# ------------------------------------------------------------------ 3. paint over + retype (scan)
def test_t3_scan_digits_retyped(built):
    out, _, by = built
    e = by["T-03"]
    a, b = Image.open(SAMPLES / e["source_file"]).convert("RGB"), Image.open(out / e["file"]).convert("RGB")
    assert a.size == b.size
    box = px_box(e, b.size)
    assert mean_diff(a, b, box) > 4, "changed inside the box"
    assert mean_diff(a, b, box, outside=True) < 2.5, "unchanged elsewhere (JPEG noise only)"
    assert e["edited_value"] != e["original_value"]


# ------------------------------------------------------------------ 4. copy-move
def test_t4_copy_move_duplicates_pixels(built):
    out, _, by = built
    e = by["T-04"]
    b = Image.open(out / e["file"]).convert("RGB")
    W, H = b.size
    d = px_box(e, b.size)
    sx, sy, sw, sh = e["source_region"]["bbox"]
    s = (round(sx * W), round(sy * H), round((sx + sw) * W), round((sy + sh) * H))
    assert (d[2] - d[0], d[3] - d[1]) == (s[2] - s[0], s[3] - s[1])
    assert mean_diff(b.crop(d), b.crop(s)) < 3, "destination repeats the source pixels"
    a = Image.open(SAMPLES / e["source_file"]).convert("RGB")
    assert mean_diff(a, b, d) > 4, "destination differs from the genuine file"
    assert d != s


# ------------------------------------------------------------------ 5. different signature
def test_t5_signature_replaced(built):
    out, _, by = built
    e = by["T-05"]
    a, b = Image.open(SAMPLES / e["source_file"]).convert("RGB"), Image.open(out / e["file"]).convert("RGB")
    box = px_box(e, b.size)
    assert mean_diff(a, b, box) > 3
    assert mean_diff(a, b, box, outside=True) < 2.5
    # still blue ink in the box
    raw = b.crop(box).tobytes()
    ink = [i for i in range(0, len(raw), 3) if raw[i + 2] > raw[i] + 40]
    assert len(ink) > 200


# ------------------------------------------------------------------ 6. photo swap
def test_t6_photo_swapped_png(built):
    out, _, by = built
    e = by["T-06"]
    a, b = Image.open(SAMPLES / e["source_file"]).convert("RGB"), Image.open(out / e["file"]).convert("RGB")
    assert a.size == b.size
    box = px_box(e, b.size)
    assert mean_diff(a, b, box) > 15
    diff = ImageChops.difference(a, b).getbbox()
    assert diff is not None
    assert diff[0] >= box[0] and diff[1] >= box[1] and diff[2] <= box[2] and diff[3] <= box[3], \
        "pixels change only inside the portrait box"


# ------------------------------------------------------------------ 7. incremental save
def test_t7_incremental_revision(built):
    out, _, by = built
    e = by["T-07"]
    new, old = (out / e["file"]).read_bytes(), (SAMPLES / e["source_file"]).read_bytes()
    assert new.startswith(old.rstrip(b"\n")), "original bytes are kept verbatim"
    assert new.count(b"%%EOF") == 2 and b"/Prev" in new[len(old):]
    assert e["revisions"] == 2
    with pikepdf.open(out / e["file"]) as pdf:           # opens cleanly and sees the newest revision
        assert len(pdf.pages) == 1
    txt = words_text(out / e["file"])
    src_txt = words_text(SAMPLES / e["source_file"])
    # the value is printed in several places on a statement: exactly ONE occurrence was edited
    assert txt.count(e["edited_value"]) == src_txt.count(e["edited_value"]) + 1
    assert txt.count(e["original_value"]) == src_txt.count(e["original_value"]) - 1


# ------------------------------------------------------------------ 8. hidden text
@pytest.mark.parametrize("tid,method", [("T-08", "white_on_white"), ("T-09", "invisible_render_mode")])
def test_t8_hidden_text_in_layer_not_on_page(built, tid, method):
    out, _, by = built
    e = by[tid]
    assert e["method"] == method
    p, src = out / e["file"], SAMPLES / e["source_file"]
    assert e["hidden_value"] in words_text(p) and e["hidden_value"] not in words_text(src)
    assert ImageChops.difference(render(p), render(src)).getbbox() is None, "page looks identical"
    assert e["hidden_value"] != e["visible_value"]


# ------------------------------------------------------------------ controls
def test_c1_recompressed_only(built):
    out, _, by = built
    e = by["C-01"]
    a, b = Image.open(SAMPLES / e["source_file"]).convert("RGB"), Image.open(out / e["file"]).convert("RGB")
    assert a.size == b.size and mean_diff(a, b) < 2.0
    assert e["expected_finding"] is False and e["bbox"] == [0, 0, 1, 1]


def test_c2_pdf_resaved_only(built):
    out, _, by = built
    e = by["C-02"]
    p, src = out / e["file"], SAMPLES / e["source_file"]
    assert words_text(p) == words_text(src)
    assert ImageChops.difference(render(p), render(src)).getbbox() is None
    assert (out / e["file"]).read_bytes().count(b"%%EOF") == 1


def test_c3_bold_value_text_unchanged(built):
    out, _, by = built
    e = by["C-03"]
    p, src = out / e["file"], SAMPLES / e["source_file"]
    assert words_text(p) == words_text(src)
    def bold_text(path):
        with pdfplumber.open(path) as pl:
            return "".join(c["text"] for c in pl.pages[0].chars if c["fontname"].endswith("Bold"))
    assert "BradleyEvans" in bold_text(p).replace(" ", "")
    assert "BradleyEvans" not in bold_text(src).replace(" ", ""), "genuine file has it regular"
    assert e["expected_finding"] is False and e["role"] == "control"


def test_c4_highlight_text_unchanged_and_yellow(built):
    out, _, by = built
    e = by["C-04"]
    p, src = out / e["file"], SAMPLES / e["source_file"]
    assert words_text(p) == words_text(src)
    im = render(p)
    box = px_box(e, im.size)
    raw = im.crop(box).tobytes()
    yellow = [i for i in range(0, len(raw), 3) if raw[i] > 240 and raw[i + 1] > 220 and raw[i + 2] < 140]
    assert len(yellow) > 200
    assert e["expected_finding"] is False


def test_controls_never_share_a_file_with_a_tamper(built):
    _, gt, _ = built
    t = {e["file"] for e in gt["entries"] if e["role"] == "tampered"}
    c = {e["file"] for e in gt["entries"] if e["role"] == "control"}
    assert not (t & c)


# ------------------------------------------------------------------ single functions on other documents
def test_functions_work_on_any_manifest_document(tmp_path):
    """The operations are generic: they accept any manifest entry, not just the ones used in build_all."""
    m = T.load_manifest(SAMPLES)
    doc = T.doc_entry(m, "loan_application_002")
    e = T.tamper_replace_pdf_value(SAMPLES / doc["file"], tmp_path / "x.pdf", doc, "loan_term_months", base=tmp_path)
    assert e["file"] == "x.pdf" and e["original_value"] != e["edited_value"]
    with pytest.raises(KeyError):
        T.tamper_replace_pdf_value(SAMPLES / doc["file"], tmp_path / "y.pdf", doc, "no_such_field", base=tmp_path)
    with pytest.raises(ValueError):
        T.tamper_hidden_text(SAMPLES / doc["file"], tmp_path / "z.pdf", doc, "requested_loan_amount",
                             base=tmp_path, method="bogus")
