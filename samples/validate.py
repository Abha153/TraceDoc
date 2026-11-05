"""D4 validator for the whole sample set.  Run from anywhere:  python samples/validate.py

Exit code 0 = valid. Checks (every failure is listed, nothing stops at the first):
  * D1 manifest: files exist, sha256 match, every field box and region lies inside its page
  * D2 ground truth: files exist, sha256 match, boxes inside the page, controls never expect a finding
  * D3/D4 cases: required keys, documents exist and hash, field regions inside the page,
    every expectation points at a real document, field and (for edits) a real ground-truth entry,
    every file in a case folder is referenced, ids unique, dev/test hold one variant of every pattern
  * leakage between dev and test: file paths, file contents (sha256), person ids, names, surnames,
    id numbers, account numbers and application numbers must all be disjoint
  * hold-out guard: nothing under backend/config refers to samples/test
  * ground-truth.md is up to date with the case files

Only the standard library is used here (ground_truth_doc imports nothing else either).
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

PATTERNS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]
SPLIT_VARIANT = {"dev": "a", "test": "b"}
CASE_KEYS = {"schema", "caseId", "pattern", "patternName", "variant", "split", "fictional", "bbox_format",
             "persons", "documents", "genuine_sources", "tamper_ground_truth", "legitimate_differences"}
DOC_KEYS = {"doc_id", "doc_type", "variant", "role", "file", "format", "sha256", "bytes", "set", "person_ids", "fields"}
FIELD_KEYS = {"name", "semantic_type", "text", "value", "page", "bbox", "region"}
FINDING_KEYS = {"expectedId", "type", "category", "observationStatus", "severity", "documents"}
NON_KEYS = {"nonFindingId", "description", "documents", "fields", "forbiddenTypes", "reason"}
GT_KEYS = {"id", "type", "role", "file", "page", "bbox", "bbox_format", "region", "description",
           "expected_finding", "sha256", "source_file", "source_sha256"}
OBS = {"OBSERVED", "INCONSISTENT", "POTENTIAL_ANOMALY", "INCONCLUSIVE"}
SEV = {"info", "low", "medium", "high"}
CAT = {"extraction", "visual", "pdf_structure", "context", "cross_document"}


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def load(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def box_ok(b, n=4) -> bool:
    return isinstance(b, list) and len(b) == n and all(isinstance(v, (int, float)) for v in b)


def xywh_inside(b) -> bool:
    return box_ok(b) and b[0] >= 0 and b[1] >= 0 and b[2] > 0 and b[3] > 0 and b[0] + b[2] <= 1 + 1e-6 and b[1] + b[3] <= 1 + 1e-6


def xyxy_inside(b) -> bool:
    return box_ok(b) and 0 <= b[0] < b[2] <= 1 + 1e-6 and 0 <= b[1] < b[3] <= 1 + 1e-6


class Report:
    def __init__(self):
        self.errors: list[str] = []

    def err(self, where: str, msg: str):
        self.errors.append(f"{where}: {msg}")

    def need(self, obj: dict, keys: set, where: str):
        miss = keys - set(obj)
        if miss:
            self.err(where, f"missing keys {sorted(miss)}")
        return not miss


# ----------------------------------------------------------------------------- D1 / D2
def check_d1(root: Path, r: Report):
    m = load(root / "manifest.json")
    for d in m["documents"]:
        w = f"manifest {d['doc_id']}"
        p = root / d["file"]
        if not p.is_file():
            r.err(w, f"missing file {d['file']}")
            continue
        if sha(p) != d["sha256"]:
            r.err(w, "sha256 mismatch")
        for f in d["fields"]:
            if not xyxy_inside(f["bbox"]):
                r.err(w, f"field {f['name']} bbox outside page {f['bbox']}")
            if not xywh_inside(f["region"]["bbox"]):
                r.err(w, f"field {f['name']} region outside page")
            x0, y0, x1, y1 = f["bbox"]
            if any(abs(a - b) > 1e-5 for a, b in zip(f["region"]["bbox"], (x0, y0, x1 - x0, y1 - y0))):
                r.err(w, f"field {f['name']}: bbox (xyxy) and region.bbox (xywh) disagree")


def check_gt(root: Path, r: Report, gt_path: Path, base: Path, label: str):
    gt = load(gt_path)
    ids = set()
    for e in gt["entries"]:
        w = f"{label} {e.get('id')}"
        if not r.need(e, GT_KEYS, w):
            continue
        if e["id"] in ids:
            r.err(w, "duplicate id")
        ids.add(e["id"])
        if e["bbox_format"] != "xywh" or not xywh_inside(e["bbox"]):
            r.err(w, f"bbox not a valid xywh inside the page: {e['bbox']}")
        if e["region"]["bbox"] != e["bbox"]:
            r.err(w, "region.bbox differs from bbox")
        if e["role"] not in ("tampered", "control"):
            r.err(w, f"unknown role {e['role']}")
        if e["expected_finding"] != (e["role"] == "tampered"):
            r.err(w, "expected_finding must be true for edits and false for controls")
        p = base / e["file"]
        if not p.is_file():
            r.err(w, f"missing file {e['file']}")
        elif sha(p) != e["sha256"]:
            r.err(w, "sha256 mismatch")
        sp = base / e["source_file"] if label.startswith("case") else root / e["source_file"]
        if not sp.is_file():
            r.err(w, f"missing source {e['source_file']}")


# ----------------------------------------------------------------------------- cases
def check_case(d: Path, split: str, r: Report) -> dict:
    w = f"case {d.name}"
    info = {"files": {}, "persons": [], "accounts": set(), "apps": set(), "docids": set()}
    for n in ("case.json", "expected_findings.json", "expected_non_findings.json"):
        if not (d / n).is_file():
            r.err(w, f"missing {n}")
            return info
    case = load(d / "case.json")
    if not r.need(case, CASE_KEYS, w):
        return info
    if case["split"] != split or SPLIT_VARIANT[split] != case["variant"]:
        r.err(w, f"case says split={case['split']} variant={case['variant']} but lives in {split}")
    if case["fictional"] is not True or case["bbox_format"] != "xywh":
        r.err(w, "must be fictional with bbox_format xywh")
    docs = {}
    for doc in case["documents"]:
        dw = f"{w} {doc.get('doc_id')}"
        if not r.need(doc, DOC_KEYS, dw):
            continue
        docs[doc["doc_id"]] = doc
        info["docids"].add(doc["doc_id"])
        p = d / doc["file"]
        if not p.is_file():
            r.err(dw, f"missing file {doc['file']}")
        elif sha(p) != doc["sha256"]:
            r.err(dw, "sha256 mismatch")
        names = set()
        for f in doc["fields"]:
            if not r.need(f, FIELD_KEYS, f"{dw} field"):
                continue
            names.add(f["name"])
            if not xywh_inside(f["region"]["bbox"]) or f["region"]["docId"] != doc["doc_id"]:
                r.err(dw, f"field {f['name']} region invalid or outside page")
            if f["name"] == "account_number":
                info["accounts"].add(f["value"])
            if f["name"] == "application_number":
                info["apps"].add(f["value"])
        if "sample_marker" not in names:
            r.err(dw, "no SAMPLE marker field")
    gts = {g["id"]: g for g in case["tamper_ground_truth"]}
    for g in case["tamper_ground_truth"]:
        if not r.need(g, GT_KEYS, f"{w} {g.get('id')}"):
            continue
        if not xywh_inside(g["bbox"]):
            r.err(f"{w} {g['id']}", "bbox outside page")
        if g["doc_id"] not in docs:
            r.err(f"{w} {g['id']}", "edited document is not a case document")
    sources = case.get("genuine_sources", [])
    for sr in sources:
        sp = d / sr["file"]
        if not sp.is_file():
            r.err(w, f"genuine source {sr['file']} missing")
        elif sha(sp) != sr["sha256"]:
            r.err(w, f"genuine source {sr['file']} sha256 mismatch")
    listed = ({doc["file"] for doc in docs.values()} | {g["file"] for g in gts.values()}
              | {g["source_file"] for g in gts.values()} | {sr["file"] for sr in sources})
    for p in d.rglob("*"):
        if p.is_file():
            rel = p.relative_to(d).as_posix()
            info["files"][rel] = sha(p)
            if not rel.endswith(".json") and rel not in listed:
                r.err(w, f"file {rel} is not referenced by case.json")

    def evidence(ev, where):
        doc = docs.get(ev.get("docId"))
        if doc is None:
            return r.err(where, f"evidence document {ev.get('docId')} not in case")
        f = next((x for x in doc["fields"] if x["name"] == ev.get("field")), None)
        if f is None:
            return r.err(where, f"no field {ev.get('field')} in {ev['docId']}")
        if f["region"] != ev["region"] or f["text"] != ev["text"]:
            r.err(where, f"evidence for {ev['field']} does not match the document")

    seen = set()
    ef = load(d / "expected_findings.json")["findings"]
    for f in ef:
        fw = f"{w} {f.get('expectedId')}"
        if not r.need(f, FINDING_KEYS, fw):
            continue
        if f["expectedId"] in seen:
            r.err(fw, "duplicate id")
        seen.add(f["expectedId"])
        if f["observationStatus"] not in OBS or f["severity"] not in SEV or f["category"] not in CAT:
            r.err(fw, "status, severity or category outside the contract enums")
        for did in f["documents"]:
            if did not in docs:
                r.err(fw, f"unknown document {did}")
        for ev in f.get("evidence", []):
            evidence(ev, fw)
        if "tamperRef" in f:
            g = gts.get(f["tamperRef"])
            if g is None:
                r.err(fw, f"unknown tamperRef {f['tamperRef']}")
            elif g["region"] != f.get("region"):
                r.err(fw, "region differs from the ground-truth entry")
        for rel in f.get("relatedFindings", []):
            if rel not in {x["expectedId"] for x in ef}:
                r.err(fw, f"relatedFindings {rel} not found")
    for n in load(d / "expected_non_findings.json")["non_findings"]:
        nw = f"{w} {n.get('nonFindingId')}"
        if not r.need(n, NON_KEYS, nw):
            continue
        if n["nonFindingId"] in seen:
            r.err(nw, "duplicate id")
        seen.add(n["nonFindingId"])
        for did in n["documents"]:
            if did not in docs:
                r.err(nw, f"unknown document {did}")
        for ev in n["fields"]:
            evidence(ev, nw)
    info["persons"] = case["persons"]
    return info


def check_cases(root: Path, r: Report):
    idx = load(root / "scenarios_index.json")
    per_split = {"dev": [], "test": []}
    infos = {"dev": [], "test": []}
    for c in idx["cases"]:
        d = root / c["split"] / Path(c["dir"]).name
        if not d.is_dir():
            r.err(f"case {c['caseId']}", f"folder {d} missing")
            continue
        per_split[c["split"]].append(c["pattern"])
        infos[c["split"]].append(check_case(d, c["split"], r))
    for split, pats in per_split.items():
        if sorted(pats) != PATTERNS:
            r.err(f"split {split}", f"must hold exactly one case per pattern S1..S8, has {sorted(pats)}")
        on_disk = {p.name for p in (root / split).iterdir() if p.is_dir()} if (root / split).is_dir() else set()
        listed = {Path(c["dir"]).name for c in idx["cases"] if c["split"] == split}
        if on_disk != listed:
            r.err(f"split {split}", f"folders on disk and in scenarios_index.json differ: {sorted(on_disk ^ listed)}")
    leakage(infos, r)


def leakage(infos: dict, r: Report):
    def collect(split):
        s = {"files": set(), "docid": set(), "hashes": set(), "pid": set(), "name": set(), "surname": set(), "idnum": set(),
             "acct": set(), "app": set(), "dob_name": set()}
        for i in infos[split]:
            for rel, h in i["files"].items():
                s["hashes"].add(h)
                if not rel.endswith(".json"):
                    s["files"].add(Path(rel).name)       # document file names carry the case id
            for p in i["persons"]:
                s["pid"].add(p["person_id"])
                s["name"].add(p["full_name"].lower())
                s["surname"].add(p["full_name"].split()[-1].lower())
                s["idnum"].add(p["id_number"])
                s["dob_name"].add((p["full_name"].lower(), p["date_of_birth"]))
            s["docid"] |= i["docids"]
            s["acct"] |= i["accounts"]
            s["app"] |= i["apps"]
        return s
    d, t = collect("dev"), collect("test")
    labels = {"files": "document file name", "docid": "document id", "hashes": "file content", "pid": "person id", "name": "person name",
              "surname": "surname", "idnum": "id number", "acct": "account number", "app": "application number",
              "dob_name": "person (name+DOB)"}
    for k, lab in labels.items():
        both = d[k] & t[k]
        if both:
            r.err("leakage", f"{lab} appears in both dev and test: {sorted(map(str, both))[:5]}")


# ----------------------------------------------------------------------------- guards
def check_holdout(repo: Path, r: Report):
    cfg = repo / "backend" / "config"
    if cfg.is_dir():
        for p in cfg.rglob("*"):
            if p.is_file() and "samples/test" in p.read_text(encoding="utf-8", errors="ignore").replace("\\", "/"):
                r.err("hold-out", f"{p.relative_to(repo)} refers to samples/test; tune on samples/dev only")


def check_markdown(root: Path, r: Report):
    from samples.generator.ground_truth_doc import render_markdown
    p = root / "ground-truth.md"
    if not p.is_file():
        return r.err("ground-truth.md", "missing")
    try:
        fresh = render_markdown(root)
    except (OSError, KeyError, ValueError) as ex:   # a broken case folder is reported above; do not crash here
        return r.err("ground-truth.md", f"cannot be regenerated to compare ({type(ex).__name__}: {ex})")
    if p.read_text(encoding="utf-8") != fresh:
        r.err("ground-truth.md", "stale: run python samples/generator/ground_truth_doc.py")


def validate(root: Path = HERE) -> list[str]:
    root = Path(root)
    r = Report()
    check_d1(root, r)
    check_gt(root, r, root / "tampered" / "ground_truth.json", root, "d2")
    check_cases(root, r)
    check_holdout(root.parent, r)
    check_markdown(root, r)
    return r.errors


def main(argv=None) -> int:
    root = Path(argv[0]) if argv else HERE
    errs = validate(root)
    if errs:
        print(f"INVALID: {len(errs)} problem(s)")
        for e in errs:
            print("  -", e)
        return 1
    print("VALID: D1 manifest, D2 ground truth, 16 cases (dev/test), no leakage, ground-truth.md current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
