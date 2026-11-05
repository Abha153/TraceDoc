"""D1-lite generator: 3 genuine fictional documents + 3 scan-like versions.

    python samples/generator/generate.py                # writes into samples/
    python samples/generator/generate.py --out /tmp/x   # elsewhere (used by tests)

Flow: build persons.json (Faker, fixed seed) -> RE-READ it from disk -> render every
document from that file -> write samples/manifest.json.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

if __package__ in (None, ""):  # allow `python samples/generator/generate.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = "samples.generator"

from PIL import Image

from .common import COMMITTED_PERSONS, SAMPLES_DIR, SEED, field, norm_bbox, sha256_file, write_json  # noqa: F401
from .persons import build_persons
from .persons_builtin import build_persons_builtin
from .render_id import render_id
from .render_pdf import render_application, render_statement
from .scan import HARD, make_recompressed, make_scan, rasterize_pdf, rotate_bbox
from .bbox import to_region
from .semantics import annotate

MANIFEST_VERSION = "d1-lite-2"
SET_IDS = ("001", "002")
PERSONS_FILES = {"001": "persons.json", "002": "persons_002.json"}
COORDS = {
    "bbox_format": "[x_min, y_min, x_max, y_max]",
    "bbox_space": "normalised 0-1 fraction of the page/image width and height",
    "origin": "top-left, y increases downward",
    "scan_bbox_note": "In scan files bboxes are the axis-aligned box enclosing the rotated "
                      "field rectangle (rotation_deg is given in `scan`).",
}


def _entry(doc_id, doc_type, variant, rel, path, fields, size, person_ids, *,
           set_id="001", derived_from=None, scan=None, pdf_pts=None, text_layer=False, tables=None,
           control=None):
    e = {
        "doc_id": doc_id, "doc_type": doc_type, "variant": variant, "role": "genuine",
        "file": rel, "format": Path(rel).suffix.lstrip(".").lower(),
        "sha256": sha256_file(path), "bytes": Path(path).stat().st_size,
        "set": set_id, "person_ids": person_ids, "derived_from": derived_from,
        "has_text_layer": text_layer,
    }
    if pdf_pts:
        e["pages"] = [{"page": 1, "width_pt": pdf_pts[0], "height_pt": pdf_pts[1]}]
    else:
        e["size_px"] = {"width": size[0], "height": size[1]}
    if scan:
        e["scan"] = scan
    e["fields"] = [{**f, "region": to_region(doc_id, f["page"], f["bbox"], f["name"])} for f in fields]
    if control:
        e["control"] = control          # genuine content that detectors must NOT flag
    if tables:
        e["tables"] = tables
    return e


def _norm_fields(raw, w, h, doc_type, applicant_id, guarantor_id):
    return [{"name": f["name"], "field_type": f["field_type"],
             **annotate(doc_type, f["name"], applicant_id, guarantor_id),
             "text": f["text"], "value": f["value"], "page": f["page"],
             "bbox": norm_bbox(f["bbox"], w, h)}
            for f in raw]


def _scan_fields(norm_fields, size, angle):
    out = []
    for f in norm_fields:
        g = dict(f)
        g["bbox"] = rotate_bbox(f["bbox"], size, angle)
        out.append(g)
    return out


_TABLE_COLS = ("date", "description", "debit", "credit", "balance")


def _union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


def _statement_tables(fields):
    """Describe the transactions table: rows -> cell field names, plus the totals row.
    Boxes are derived from the field boxes passed in (so scans get their rotated boxes)."""
    by = {f["name"]: f for f in fields}
    rows = []
    n = 1
    while f"transaction_{n:02d}_date" in by:
        cells = {c: f"transaction_{n:02d}_{c}" for c in _TABLE_COLS if f"transaction_{n:02d}_{c}" in by}
        rows.append({"row": n, "cells": cells, "bbox": _union([by[v]["bbox"] for v in cells.values()])})
        n += 1
    totals = {"debit": "table_total_debits", "credit": "table_total_credits",
              "balance": "table_closing_balance"}
    return [{"name": "transactions", "page": 1, "columns": list(_TABLE_COLS), "rows": rows,
             "totals_row": {"cells": totals, "bbox": _union([by[v]["bbox"] for v in totals.values()])},
             "bbox": _union([r["bbox"] for r in rows] + [by[v]["bbox"] for v in totals.values()])}]


def _render_set(out_dir: Path, persons: dict, set_id: str, scan_seed: int) -> list:
    """Render the ID card, application form and statement of one persons file, plus scans."""
    gdir = out_dir / "genuine"
    app = persons["loan_application"]
    by_id = {p["person_id"]: p for p in persons["persons"]}
    applicant = by_id[app["applicant_id"]]
    pids_app = [app["applicant_id"], app["guarantor_id"]]
    pids_one = [app["applicant_id"]]
    docs = []

    id_doc = f"id_card_{set_id}"
    id_png = gdir / f"{id_doc}.png"
    f, size = render_id(applicant, id_png)
    ids = (app["applicant_id"], app["guarantor_id"])
    id_fields = _norm_fields(f, *size, "id_card", *ids)
    docs.append(_entry(id_doc, "id_card", "original", f"genuine/{id_doc}.png", id_png,
                       id_fields, size, pids_one, set_id=set_id))
    scans = [(id_doc, "id_card", Image.open(id_png).convert("RGB"), id_fields, size, pids_one,
              f"genuine/{id_doc}_scan.jpg", 1)]

    for stem, doc_type, render, pids in (
            ("loan_application", "loan_application", render_application, pids_app),
            ("bank_statement", "bank_statement", render_statement, pids_one)):
        doc_id = f"{stem}_{set_id}"
        pdf = gdir / f"{doc_id}.pdf"
        f, (wpt, hpt) = render(persons, pdf)
        nf = _norm_fields(f, wpt, hpt, doc_type, *ids)
        tables = _statement_tables(nf) if doc_type == "bank_statement" else None
        docs.append(_entry(doc_id, doc_type, "original", f"genuine/{doc_id}.pdf", pdf, nf,
                           None, pids, set_id=set_id, pdf_pts=(wpt, hpt), text_layer=True, tables=tables))
        raster = rasterize_pdf(pdf)
        scans.append((doc_id, doc_type, raster, nf, raster.size, pids,
                      f"genuine/{doc_id}_scan.jpg", len(scans) + 1))

    for doc_id, doc_type, img, nf, size, pids, rel, k in scans:
        path = out_dir / rel
        params = make_scan(img, scan_seed + k, path)
        with Image.open(path) as im:
            ssize = im.size
        assert ssize == tuple(size), "scan must keep the source pixel size"
        sf = _scan_fields(nf, ssize, params["rotation_deg"])
        docs.append(_entry(f"{doc_id}_scan", doc_type, "scan", rel, path, sf, ssize, pids,
                           set_id=set_id, derived_from=doc_id, scan=params,
                           tables=_statement_tables(sf) if doc_type == "bank_statement" else None))

        # harder scan (OCR robustness) and a recompressed-only control (false-positive check)
        hrel = rel.replace("_scan.jpg", "_scan_hard.jpg")
        hparams = make_scan(img, scan_seed + 50 + k, out_dir / hrel, **HARD)
        hf = _scan_fields(nf, ssize, hparams["rotation_deg"])
        docs.append(_entry(f"{doc_id}_scan_hard", doc_type, "scan_hard", hrel, out_dir / hrel, hf,
                           ssize, pids, set_id=set_id, derived_from=doc_id, scan=hparams,
                           tables=_statement_tables(hf) if doc_type == "bank_statement" else None))
        rrel = rel.replace("_scan.jpg", "_recompressed.jpg")
        rparams = make_recompressed(img, out_dir / rrel)
        docs.append(_entry(f"{doc_id}_recompressed", doc_type, "recompressed", rrel, out_dir / rrel, nf,
                           size, pids, set_id=set_id, derived_from=doc_id, scan=rparams,
                           control="recompressed_only",
                           tables=_statement_tables(nf) if doc_type == "bank_statement" else None))

    order = {"original": 0, "scan": 1, "scan_hard": 2, "recompressed": 3}
    src = lambda d: d["derived_from"] or d["doc_id"]  # noqa: E731
    first = {src(d): i for i, d in reversed(list(enumerate(docs))) if d["variant"] == "original"}
    return sorted(docs, key=lambda d: (first[src(d)], order[d["variant"]]))


def _legit_differences(sid: str, persons: dict, docs: list) -> list:
    """Values that differ ON PURPOSE in a genuine set. A correct reasoner must NOT report them.
    Derived from the rendered manifest and asserted to really differ, so they cannot go stale."""
    orig = {d["doc_id"]: {f["name"]: f["value"] for f in d["fields"]}
            for d in docs if d["variant"] == "original"}
    idc, app, st = (orig[f"{n}_{sid}"] for n in ("id_card", "loan_application", "bank_statement"))
    pairs = [
        ("address_permanent vs address_current", "MAY_DIFFER",
         "Permanent address on the ID card differs from the current address on the bank statement.",
         ("id_card", "permanent_address", idc), ("bank_statement", "account_holder_address", st)),
        ("address_permanent vs address_current", "MAY_DIFFER",
         "Permanent and current address on the same application form are different on purpose.",
         ("loan_application", "permanent_address", app), ("loan_application", "current_address", app)),
        ("requested_amount vs account_balance", "NOT_COMPARABLE",
         "Requested loan amount is not a balance; the two are different concepts.",
         ("loan_application", "requested_loan_amount", app), ("bank_statement", "closing_balance", st)),
        ("applicant vs guarantor identity", "MAY_DIFFER",
         "The guarantor is a different person; name and date of birth must not be compared to the applicant's.",
         ("loan_application", "full_name", app), ("loan_application", "guarantor_full_name", app)),
        ("applicant vs guarantor identity", "MAY_DIFFER",
         "Guarantor date of birth differs from the applicant's.",
         ("loan_application", "date_of_birth", app), ("loan_application", "guarantor_date_of_birth", app)),
    ]
    out = []
    for n, (concept, rule, why, (ld, lf, lv), (rd, rf, rv)) in enumerate(pairs, 1):
        assert lv[lf] != rv[rf], f"set {sid}: {lf} and {rf} should differ"
        out.append({"id": f"LD-{sid}-{n}", "concept": concept, "rule_type": rule, "description": why,
                    "left": {"doc_id": f"{ld}_{sid}", "field": lf, "value": lv[lf]},
                    "right": {"doc_id": f"{rd}_{sid}", "field": rf, "value": rv[rf]},
                    "expected_finding": False})
    return out


def generate(out_dir: Path, seed: int = SEED, persons_file: Path | None = None,
             rebuild_persons: bool = False) -> dict:
    out_dir = Path(out_dir)
    (out_dir / "genuine").mkdir(parents=True, exist_ok=True)

    # 1. persons files are the single source of truth; documents are rendered from the files
    #    re-read from disk. Set 001: the committed persons.json (Faker is only used to rebuild
    #    it). Set 002: built from persons_builtin (stdlib only), always reproducible.
    persons_path = out_dir / PERSONS_FILES["001"]
    src = persons_file
    if src is None and not rebuild_persons and seed == SEED and COMMITTED_PERSONS.exists():
        src = COMMITTED_PERSONS
    if src is None:
        write_json(persons_path, build_persons(seed))
    elif Path(src).resolve() != persons_path.resolve():
        shutil.copyfile(src, persons_path)
    write_json(out_dir / PERSONS_FILES["002"], build_persons_builtin(seed + 1))
    persons_by_set = {sid: json.loads((out_dir / PERSONS_FILES[sid]).read_text(encoding="utf-8"))
                      for sid in SET_IDS}

    # 2. render every set
    docs = []
    for k, sid in enumerate(SET_IDS):
        docs += _render_set(out_dir, persons_by_set[sid], sid, seed + 100 * k)

    manifest = {
        "manifest_version": MANIFEST_VERSION,
        "note": "D1 local manifest owned by samples/. Field set is specific to these "
                "documents; it is NOT a shared contract schema.",
        "fictional": True,
        "seed": seed,
        "persons_file": PERSONS_FILES["001"],
        "persons_files": PERSONS_FILES,
        "coordinate_system": COORDS,
        "sets": {sid: {
            "persons_file": PERSONS_FILES[sid],
            "applicant_id": persons_by_set[sid]["loan_application"]["applicant_id"],
            "guarantor_id": persons_by_set[sid]["loan_application"]["guarantor_id"],
            "doc_ids": [d["doc_id"] for d in docs if d["set"] == sid],
            "legitimate_differences": _legit_differences(sid, persons_by_set[sid],
                                                         [d for d in docs if d["set"] == sid]),
        } for sid in SET_IDS},
        "documents": docs,
    }
    write_json(out_dir / "manifest.json", manifest)
    return manifest


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=SAMPLES_DIR, help="output samples dir (default: samples/)")
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--persons", type=Path, default=None, help="render from this persons.json")
    ap.add_argument("--rebuild-persons", action="store_true",
                    help="rebuild persons.json with Faker (needs Faker; output depends on its version)")
    args = ap.parse_args(argv)
    m = generate(args.out, args.seed, args.persons, args.rebuild_persons)
    for d in m["documents"]:
        print(f"{d['file']:<44} {d['bytes']:>8} B  {d['sha256'][:12]}  {len(d['fields'])} fields")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
