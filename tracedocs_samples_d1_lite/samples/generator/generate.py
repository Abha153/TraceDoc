"""D1-lite generator: 3 genuine fictional documents + 3 scan-like versions.

    python samples/generator/generate.py                # writes into samples/
    python samples/generator/generate.py --out /tmp/x   # elsewhere (used by tests)

Flow: build persons.json (Faker, fixed seed) -> RE-READ it from disk -> render every
document from that file -> write samples/manifest.json.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):  # allow `python samples/generator/generate.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = "samples.generator"

from PIL import Image

from .common import SAMPLES_DIR, SEED, field, norm_bbox, sha256_file, write_json  # noqa: F401
from .persons import build_persons
from .render_id import render_id
from .render_pdf import render_application, render_statement
from .scan import make_scan, rasterize_pdf, rotate_bbox

MANIFEST_VERSION = "d1-lite-1"
COORDS = {
    "bbox_format": "[x_min, y_min, x_max, y_max]",
    "bbox_space": "normalised 0-1 fraction of the page/image width and height",
    "origin": "top-left, y increases downward",
    "scan_bbox_note": "In scan files bboxes are the axis-aligned box enclosing the rotated "
                      "field rectangle (rotation_deg is given in `scan`).",
}


def _entry(doc_id, doc_type, variant, rel, path, fields, size, person_ids, *,
           derived_from=None, scan=None, pdf_pts=None, text_layer=False):
    e = {
        "doc_id": doc_id, "doc_type": doc_type, "variant": variant, "role": "genuine",
        "file": rel, "format": Path(rel).suffix.lstrip(".").lower(),
        "sha256": sha256_file(path), "bytes": Path(path).stat().st_size,
        "person_ids": person_ids, "derived_from": derived_from,
        "has_text_layer": text_layer,
    }
    if pdf_pts:
        e["pages"] = [{"page": 1, "width_pt": pdf_pts[0], "height_pt": pdf_pts[1]}]
    else:
        e["size_px"] = {"width": size[0], "height": size[1]}
    if scan:
        e["scan"] = scan
    e["fields"] = fields
    return e


def _norm_fields(raw, w, h):
    return [{"name": f["name"], "field_type": f["field_type"], "text": f["text"],
             "value": f["value"], "page": f["page"], "bbox": norm_bbox(f["bbox"], w, h)}
            for f in raw]


def _scan_fields(norm_fields, size, angle):
    out = []
    for f in norm_fields:
        g = dict(f)
        g["bbox"] = rotate_bbox(f["bbox"], size, angle)
        out.append(g)
    return out


def generate(out_dir: Path, seed: int = SEED) -> dict:
    out_dir = Path(out_dir)
    gdir = out_dir / "genuine"
    gdir.mkdir(parents=True, exist_ok=True)

    # 1. persons.json is the single source of truth
    persons_path = out_dir / "persons.json"
    write_json(persons_path, build_persons(seed))
    persons = json.loads(persons_path.read_text(encoding="utf-8"))
    by_id = {p["person_id"]: p for p in persons["persons"]}
    applicant = by_id[persons["loan_application"]["applicant_id"]]
    pids_app = ["P001", "P002"]

    docs = []

    # 2. originals
    id_png = gdir / "id_card_001.png"
    f, size = render_id(applicant, id_png)
    id_fields = _norm_fields(f, *size)
    docs.append(_entry("id_card_001", "id_card", "original", "genuine/id_card_001.png", id_png,
                       id_fields, size, ["P001"]))
    scans = [("id_card_001", "id_card", Image.open(id_png).convert("RGB"), id_fields, size, ["P001"],
              "genuine/id_card_001_scan.jpg", 1)]

    for doc_id, doc_type, render, pids in (
            ("loan_application_001", "loan_application", render_application, pids_app),
            ("bank_statement_001", "bank_statement", render_statement, ["P001"])):
        pdf = gdir / f"{doc_id}.pdf"
        f, (wpt, hpt) = render(persons, pdf)
        nf = _norm_fields(f, wpt, hpt)
        docs.append(_entry(doc_id, doc_type, "original", f"genuine/{doc_id}.pdf", pdf, nf,
                           None, pids, pdf_pts=(wpt, hpt), text_layer=True))
        raster = rasterize_pdf(pdf)
        scans.append((doc_id, doc_type, raster, nf, raster.size, pids,
                      f"genuine/{doc_id}_scan.jpg", len(scans) + 1))

    # 3. scan-like versions
    for doc_id, doc_type, img, nf, size, pids, rel, k in scans:
        path = out_dir / rel
        params = make_scan(img, seed + k, path)
        with Image.open(path) as im:
            ssize = im.size
        assert ssize == tuple(size), "scan must keep the source pixel size"
        docs.append(_entry(f"{doc_id}_scan", doc_type, "scan", rel, path,
                           _scan_fields(nf, ssize, params["rotation_deg"]), ssize, pids,
                           derived_from=doc_id, scan=params))

    # keep each original directly followed by its scan
    originals = [d for d in docs if d["variant"] == "original"]
    scans_by_src = {d["derived_from"]: d for d in docs if d["variant"] == "scan"}
    docs = [x for o in originals for x in (o, scans_by_src[o["doc_id"]])]

    manifest = {
        "manifest_version": MANIFEST_VERSION,
        "note": "D1-lite local manifest owned by samples/. Field set is specific to these "
                "documents; it is NOT a shared contract schema.",
        "fictional": True,
        "seed": seed,
        "persons_file": "persons.json",
        "coordinate_system": COORDS,
        "documents": docs,
    }
    write_json(out_dir / "manifest.json", manifest)
    return manifest


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=SAMPLES_DIR, help="output samples dir (default: samples/)")
    ap.add_argument("--seed", type=int, default=SEED)
    args = ap.parse_args(argv)
    m = generate(args.out, args.seed)
    for d in m["documents"]:
        print(f"{d['file']:<44} {d['bytes']:>8} B  {d['sha256'][:12]}  {len(d['fields'])} fields")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
