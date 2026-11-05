"""D3: complete fictional cases (documents + expected findings + expected non-findings).

Eight patterns x two variants = 16 cases. Variant ``a`` goes to ``samples/dev/`` (used while building and
tuning); variant ``b`` goes to ``samples/test/`` (held out, never used to tune thresholds). The two
variants use different people, values and (where a pattern allows) a different edit, and the people are
drawn from disjoint name pools so no person or source document can appear in both splits (D4 verifies it).

Case folder layout::

    <split>/<caseId>_<pattern>/
        id_card_<caseId>.png|jpg, loan_application_<caseId>.pdf|jpg, bank_statement_<caseId>.pdf|jpg
        [id_card_guarantor_<caseId>.png]      S4 only
        _genuine_source/                      the unedited originals of any edited document (tampered cases only)
        case.json                             people, documents (with fields and regions), tamper ground truth
        expected_findings.json
        expected_non_findings.json

Vocabulary comes from the repository contracts and engine config: finding ``type``/``category``/
``observationStatus``/``severity`` as in ``contracts/fixtures/expected_findings.json`` and ``ruleId``
from ``backend/config/comparability.json``. All boxes are ``[x, y, w, h]`` (contract ``Region``).
Expected findings are observations a machine should surface for review, never verdicts.

CLI: ``python samples/generator/scenarios.py`` writes ``samples/dev`` and ``samples/test``.
"""
from __future__ import annotations

import argparse
import copy
import json
import random
import re
import shutil
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = "samples.generator"

from PIL import Image

from . import tamper as T
from .common import SAMPLES_DIR, money, write_json
from .generate import _entry, _norm_fields, _scan_fields, _statement_tables
from .persons import assemble
from .persons_builtin import FIRST, LAST, BuiltinFake
from .render_id import render_id
from .render_pdf import compute_statement, render_application, render_statement
from .scan import make_recompressed, make_scan, rasterize_pdf

SCHEMA = "tracedocs-scenario-1"
BASE_SEED = 20260500
SPLITS = {"a": "dev", "b": "test"}
PATTERNS = (
    ("S1", "clean_legitimate_differences"),
    ("S2", "clean_name_transcription"),
    ("S3", "dob_contradiction"),
    ("S4", "similar_names_different_people"),
    ("S5", "tampered_with_inconsistency"),
    ("S6", "tampered_without_inconsistency"),
    ("S7", "statement_arithmetic_error"),
    ("S8", "recompressed_controls"),
)
FORENSIC_TYPES = ["REGION_EVENT", "TEXT_LAYER_MISMATCH"]
CROSS_DOC_TYPES = ["DOB_CONFLICT", "NAME_CONFLICT", "NAME_VARIANT_SPELLING", "ADDRESS_CONFLICT",
                   "ID_NUMBER_CONFLICT", "STATEMENT_TOTAL_MISMATCH"]
RULE_FOR_CONCEPT = {
    "address_permanent vs address_current": "R-ADDR-MAY-DIFFER",
    "requested_amount vs account_balance": "R-AMOUNT-NOT-COMPARABLE",
}
# What a detector class is expected to report for each edit (author's assessment, not a guarantee).
EXPECTED_FOR_TAMPER = {
    "pdf_value_replaced": ("REGION_EVENT", "pdf_structure", ["pdf.fonts", "pdf.textlayer"], "limited"),
    "pdf_font_changed": ("REGION_EVENT", "pdf_structure", ["pdf.fonts"], "core"),
    "scan_digits_painted_over": ("REGION_EVENT", "visual", ["image.ela", "image.noise"], "core"),
    "copy_move_region": ("REGION_EVENT", "visual", ["image.copymove"], "core"),
    "signature_replaced": ("REGION_EVENT", "visual", ["signature", "image.ela"], "limited"),
    "photo_swapped": ("REGION_EVENT", "visual", [], "unsupported"),
    "pdf_incremental_save": ("REGION_EVENT", "pdf_structure", ["pdf.fonts"], "core"),
    "pdf_hidden_text": ("TEXT_LAYER_MISMATCH", "pdf_structure", ["pdf.textlayer"], "core"),
}


# ----------------------------------------------------------------------------- name helpers
def token_sort_ratio(a: str, b: str) -> float:
    """Python port of backend/src/engine/nameSimilarity.ts (Indel ratio of the sorted tokens)."""
    def norm(s):
        return " ".join(sorted(re.sub(r"[^\w]+", " ", s.lower()).split()))
    sa, sb = norm(a), norm(b)
    prev = [0] * (len(sb) + 1)
    for i in range(1, len(sa) + 1):
        cur = [0] * (len(sb) + 1)
        for j in range(1, len(sb) + 1):
            cur[j] = prev[j - 1] + 1 if sa[i - 1] == sb[j - 1] else max(prev[j], cur[j - 1])
        prev = cur
    return 100 * 2 * prev[-1] / (len(sa) + len(sb))


def _edit_word(word: str, rng: random.Random, n_edits: int) -> str:
    """n typo-like edits: drop a letter, substitute a vowel, or double a letter."""
    w = word
    for _ in range(n_edits):
        i = rng.randrange(1, max(2, len(w) - 1))
        kind = rng.choice(("drop", "vowel", "double"))
        if kind == "drop" and len(w) > 4:
            w = w[:i] + w[i + 1:]
        elif kind == "vowel":
            vs = [k for k, c in enumerate(w) if c.lower() in "aeiou" and k > 0]
            if vs:
                k = rng.choice(vs)
                w = w[:k] + rng.choice([v for v in "aeiouy" if v != w[k].lower()]) + w[k + 1:]
        else:
            w = w[:i] + w[i] + w[i:]
    return w[0].upper() + w[1:]


def name_variant(given: str, surname: str, seed: int, lo: float, hi: float, *, both: bool) -> tuple[str, str, float]:
    """A deterministic respelling whose token-sort ratio to the original lies in [lo, hi)."""
    rng = random.Random(seed)
    for attempt in range(2000):
        n = 1 + attempt // 200
        g = _edit_word(given, rng, n) if both else given
        s = _edit_word(surname, rng, n)
        r = token_sort_ratio(f"{given} {surname}", f"{g} {s}")
        if (g, s) != (given, surname) and lo <= r < hi:
            return g, s, r
    raise RuntimeError("no name variant found")


def _bump_year(text: str, delta: int) -> str:
    m = re.search(r"(19|20)\d{2}", text)
    return text[:m.start()] + str(int(m.group()) + delta) + text[m.end():]


def _alt_dob(iso: str, variant: str) -> str:
    d = date.fromisoformat(iso)
    if variant == "a":      # year differs
        return d.replace(year=d.year + 3).isoformat()
    return d.replace(year=d.year - 2, month=(d.month + 3 - 1) % 12 + 1, day=min(d.day, 28)).isoformat()


# ----------------------------------------------------------------------------- people
class _PoolFake(BuiltinFake):
    def __init__(self, seed, firsts, lasts):
        super().__init__(seed)
        self._f, self._l = firsts, lasts

    def first_name(self):
        return self.r.choice(self._f)

    def last_name(self):
        return self.r.choice(self._l)


def _pools(variant: str):
    k = 0 if variant == "a" else 1
    return FIRST[k::2], LAST[k::2]      # disjoint name pools per split


def make_persons(case_no: int, variant: str, used: set) -> dict:
    firsts, lasts = _pools(variant)
    ids = (f"PS{case_no:02d}{variant.upper()}1", f"PS{case_no:02d}{variant.upper()}2")
    seed0 = BASE_SEED + case_no * 10 + (0 if variant == "a" else 5)
    for k in range(500):
        seed = seed0 + k * 7919
        fake = _PoolFake(seed, firsts, lasts)
        p = assemble(fake, random.Random(seed), seed, ids, "samples/generator/scenarios.py")
        a, g = p["persons"]
        key = {a["full_name"].lower(), g["full_name"].lower(), a["id_number"], g["id_number"]}
        if a["surname"] != g["surname"] and a["given_name"] != g["given_name"] and not (key & used) \
                and token_sort_ratio(a["full_name"], g["full_name"]) < 60:
            used |= key
            return p
    raise RuntimeError("could not draw unique people")


def _set_name(persons: dict, pid: str, given: str, surname: str) -> dict:
    out = copy.deepcopy(persons)
    for p in out["persons"]:
        if p["person_id"] == pid:
            p["given_name"], p["surname"], p["full_name"] = given, surname, f"{given} {surname}"
    return out


# ----------------------------------------------------------------------------- rendering
class Case:
    """Renders into one case folder and collects document entries."""

    def __init__(self, folder: Path, case_id: str, persons: dict):
        self.dir, self.id, self.persons = folder, case_id, persons
        self.app = persons["loan_application"]
        self.ids = (self.app["applicant_id"], self.app["guarantor_id"])
        self.by_id = {p["person_id"]: p for p in persons["persons"]}
        self.docs: dict[str, dict] = {}       # doc_id -> entry
        self.tamper_gt: list[dict] = []
        folder.mkdir(parents=True, exist_ok=True)

    def path(self, name: str, source: bool = False) -> Path:
        p = self.dir / ("_genuine_source" if source else "") / name
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def rel(self, p: Path) -> str:
        return p.relative_to(self.dir).as_posix()

    def add(self, entry: dict, role: str) -> dict:
        entry["role"] = role
        self.docs[entry["doc_id"]] = entry
        return entry

    # genuine renders (ext decided by caller via `source`) --------------------------------
    def id_card(self, who: str = "applicant", source: bool = False, persons: dict | None = None):
        persons = persons or self.persons
        by_id = {p["person_id"]: p for p in persons["persons"]}
        pid = self.ids[0] if who == "applicant" else self.ids[1]
        stem = "id_card" if who == "applicant" else "id_card_guarantor"
        doc_id = f"{stem}_{self.id}"
        path = self.path(f"{doc_id}.png", source)
        raw, size = render_id(by_id[pid], path)
        nf = _norm_fields(raw, *size, "id_card", *self.ids)
        if who == "guarantor":
            for f in nf:
                if f.get("true_person_id"):
                    f["true_person_id"], f["true_entity_role"] = pid, "guarantor"
        e = _entry(doc_id, "id_card", "original", self.rel(path), path, nf, size, [pid], set_id=self.id)
        return e, path

    def application(self, source: bool = False, persons: dict | None = None):
        doc_id = f"loan_application_{self.id}"
        path = self.path(f"{doc_id}.pdf", source)
        raw, (w, h) = render_application(persons or self.persons, path)
        nf = _norm_fields(raw, w, h, "loan_application", *self.ids)
        e = _entry(doc_id, "loan_application", "original", self.rel(path), path, nf, None, list(self.ids),
                   set_id=self.id, pdf_pts=(w, h), text_layer=True)
        return e, path

    def statement(self, source: bool = False, persons: dict | None = None, printed: dict | None = None):
        doc_id = f"bank_statement_{self.id}"
        path = self.path(f"{doc_id}.pdf", source)
        raw, (w, h) = render_statement(persons or self.persons, path, printed)
        nf = _norm_fields(raw, w, h, "bank_statement", *self.ids)
        e = _entry(doc_id, "bank_statement", "original", self.rel(path), path, nf, None, [self.ids[0]],
                   set_id=self.id, pdf_pts=(w, h), text_layer=True, tables=_statement_tables(nf))
        return e, path

    # derived raster versions -------------------------------------------------------------
    def scan_of(self, e: dict, path: Path, seed: int, final_name: str, source: bool = False):
        img = Image.open(path).convert("RGB") if path.suffix == ".png" else rasterize_pdf(path)
        out = self.path(final_name, source)
        params = make_scan(img, seed, out)
        with Image.open(out) as im:
            size = im.size
        sf = _scan_fields(e["fields"], size, params["rotation_deg"])
        tables = _statement_tables(sf) if e["doc_type"] == "bank_statement" else None
        s = _entry(e["doc_id"], e["doc_type"], "scan", self.rel(out), out, sf, size, e["person_ids"],
                   set_id=self.id, derived_from=e["doc_id"], scan=params, tables=tables)
        return s, out

    def recompressed_of(self, e: dict, path: Path, quality: int):
        img = Image.open(path).convert("RGB") if path.suffix == ".png" else rasterize_pdf(path)
        out = self.path(f"{e['doc_id']}.jpg")
        params = make_recompressed(img, out, quality)
        tables = _statement_tables(e["fields"]) if e["doc_type"] == "bank_statement" else None
        r = _entry(e["doc_id"], e["doc_type"], "recompressed", self.rel(out), out, e["fields"], img.size,
                   e["person_ids"], set_id=self.id, derived_from=e["doc_id"], scan=params,
                   control="recompressed_only", tables=tables)
        return r


def _apply_edit(entry: dict, field: str, new_text: str, new_value: str | None):
    f = T.field_of(entry, field)
    f["genuine_text"], f["genuine_value"] = f["text"], f["value"]
    f["text"], f["value"] = new_text, new_value if new_value is not None else f["value"]
    f["edited"] = True          # the region is unchanged: the edit happens in place


def _doc_from_tamper(case: Case, genuine_entry: dict, gt: dict, new_path: Path, *, variant: str):
    """The case's document entry for a tampered file: same fields as the genuine one, new file/hash."""
    e = copy.deepcopy(genuine_entry)
    e["file"], e["sha256"], e["bytes"] = case.rel(new_path), T.sha256_file(new_path), new_path.stat().st_size
    e["variant"] = variant
    e["derived_from"] = None
    e["source_file"] = genuine_entry["file"]
    e["format"] = new_path.suffix.lstrip(".").lower()
    return case.add(e, "tampered")


# ----------------------------------------------------------------------------- expectation builders
def _ev(doc: dict, field: str) -> dict:
    f = T.field_of(doc, field)
    return {"docId": doc["doc_id"], "field": field, "semanticType": f["semantic_type"], "text": f["text"],
            "value": f["value"], "region": f["region"]}


def _legit_nonfindings(case: Case, start: int = 1) -> list[dict]:
    from .generate import _legit_differences
    fake = [{**d, "variant": "original"} for d in case.docs.values()]
    out = []
    for n, ld in enumerate(_legit_differences(case.id, case.persons, fake), start):
        L, R = case.docs[ld["left"]["doc_id"]], case.docs[ld["right"]["doc_id"]]
        concept = ld["concept"]
        if concept == "applicant vs guarantor identity":
            rule = "R-DOB-MUST-AGREE" if "birth" in ld["left"]["field"] else "R-NAME-MUST-AGREE"
            reason = "Applicant and guarantor are different people; their identity fields are not compared."
        else:
            rule, reason = RULE_FOR_CONCEPT[concept], f"{ld['rule_type']}: {ld['description']}"
        out.append({"nonFindingId": f"NF-{n:03d}", "description": ld["description"],
                    "documents": sorted({L["doc_id"], R["doc_id"]}),
                    "fields": [_ev(L, ld["left"]["field"]), _ev(R, ld["right"]["field"])],
                    "forbiddenTypes": ["*"], "ruleId": rule, "reason": reason, "legitimateDifferenceId": ld["id"]})
    return out


def _forensic_nonfindings(case: Case, skip: set, reason: str, start: int = 101) -> list[dict]:
    out = []
    for n, d in enumerate((d for d in case.docs.values() if d["doc_id"] not in skip), start):
        out.append({"nonFindingId": f"NF-{n:03d}", "description": f"No forensic signal on {d['doc_id']}",
                    "documents": [d["doc_id"]], "fields": [], "forbiddenTypes": FORENSIC_TYPES,
                    "ruleId": None, "reason": reason})
    return out


def _tamper_finding(case: Case, gt: dict, eid: str, doc: dict, related: list[str] | None = None) -> dict:
    ftype, cat, analyzers, detect = EXPECTED_FOR_TAMPER[gt["type"]]
    return {"expectedId": eid, "type": ftype, "category": cat, "observationStatus": "POTENTIAL_ANOMALY",
            "severity": "medium", "documents": [doc["doc_id"]], "tamperRef": gt["id"],
            "region": gt["region"], "expectedAnalyzers": analyzers, "detectability": detect,
            "scoring": "optional" if detect == "unsupported" else "required",
            "relatedFindings": related or [],
            "notes": f"{gt['description']} (detectability: {detect}; author's assessment, not a guarantee)"}


def _gt_in_case(case: Case, gt: dict, idx: int) -> dict:
    g = {**gt, "id": f"T-{idx:02d}"}
    case.tamper_gt.append(g)
    return g


# ----------------------------------------------------------------------------- patterns
def build_s1(case: Case, v: str):
    for e, _ in (case.id_card(), case.application(), case.statement()):
        case.add(e, "genuine")
    return [], _legit_nonfindings(case) + _forensic_nonfindings(case, set(), "Genuine, unedited document (ground truth).")


def build_s2(case: Case, v: str):
    a = case.by_id[case.ids[0]]
    g, s, ratio = name_variant(a["given_name"], a["surname"], 4000 + (0 if v == "a" else 17), 76, 91, both=True)
    alt = _set_name(case.persons, case.ids[0], g, s)
    e, _ = case.id_card()
    case.add(e, "genuine")
    if v == "a":   # respelled on the application form
        ea, _ = case.application(persons=alt)
        case.add(ea, "genuine")
        eb, _ = case.statement()
        case.add(eb, "genuine")
        other, field_o = ea, "full_name"
        note = "The name on the form is a respelling of the ID card name (no id_number on the form to link them)."
    else:           # respelled on the bank statement (account holder)
        ea, _ = case.application()
        case.add(ea, "genuine")
        eb, _ = case.statement(persons=alt)
        case.add(eb, "genuine")
        other, field_o = eb, "account_holder"
        note = ("The account holder on the statement is a respelling of the ID card name; the link to the applicant "
                "may only be SUGGESTED, in which case confidence is capped.")
    finding = {
        "expectedId": "EF-001", "type": "NAME_VARIANT_SPELLING", "category": "cross_document",
        "observationStatus": "INCONSISTENT", "severity": "low",
        "documents": [e["doc_id"], other["doc_id"]], "ruleId": "R-NAME-MUST-AGREE",
        "evidence": [_ev(e, "full_name"), _ev(other, field_o)],
        "tokenSortRatio": round(ratio, 1), "scoring": "required",
        "notes": f"Spelling variant, token-sort ratio {ratio:.1f} (variant band 75-92). {note} "
                 "Not a tampering signal: no forensic finding is expected."}
    nf = _legit_nonfindings(case) + _forensic_nonfindings(case, set(), "Genuine, unedited document (ground truth).")
    return [finding], nf


def build_s3(case: Case, v: str):
    dob = case.by_id[case.ids[0]]["date_of_birth"]
    alt_dob = _alt_dob(dob, v)
    alt = copy.deepcopy(case.persons)
    alt["persons"][0]["date_of_birth"] = alt_dob
    e, _ = case.id_card()
    case.add(e, "genuine")
    ea, _ = case.application(persons=alt)
    case.add(ea, "genuine")
    eb, _ = case.statement()
    case.add(eb, "genuine")
    finding = {
        "expectedId": "EF-001", "type": "DOB_CONFLICT", "category": "cross_document",
        "observationStatus": "INCONSISTENT", "severity": "high", "documents": [e["doc_id"], ea["doc_id"]],
        "ruleId": "R-DOB-MUST-AGREE", "evidence": [_ev(e, "date_of_birth"), _ev(ea, "date_of_birth")],
        "scoring": "required",
        "notes": f"Applicant date of birth is {dob} on the ID card and {alt_dob} on the application form. "
                 "Both documents are rendered files with no edit; the difference is in the content, not the pixels."}
    nf = _legit_nonfindings(case) + _forensic_nonfindings(case, set(), "Genuine, unedited document (ground truth).")
    return [finding], nf


def build_s4(case: Case, v: str):
    a = case.by_id[case.ids[0]]
    gname = name_variant(a["given_name"], a["surname"], 5000 + (0 if v == "a" else 23), 80, 97, both=False)
    case.persons = _set_name(case.persons, case.ids[1], a["given_name"], gname[1])
    case.by_id = {p["person_id"]: p for p in case.persons["persons"]}
    ratio = token_sort_ratio(a["full_name"], case.by_id[case.ids[1]]["full_name"])
    e, _ = case.id_card()
    eg, _ = case.id_card("guarantor")
    ea, _ = case.application()
    eb, _ = case.statement()
    for d in (e, eg, ea, eb):
        case.add(d, "genuine")
    nf = _legit_nonfindings(case)
    nf.append({
        "nonFindingId": "NF-050",
        "description": "Applicant and guarantor have similar names but are different people "
                       f"(token-sort ratio {ratio:.1f}; different id_number and date of birth).",
        "documents": [e["doc_id"], eg["doc_id"], ea["doc_id"]],
        "fields": [_ev(e, "full_name"), _ev(eg, "full_name"), _ev(ea, "full_name"), _ev(ea, "guarantor_full_name"),
                   _ev(e, "id_number"), _ev(eg, "id_number")],
        "forbiddenTypes": ["*"], "ruleId": "R-NAME-MUST-AGREE",
        "reason": "Different id_number: the two must stay two separate entities and must not be merged or "
                  "reported as a name conflict.",
        "entityExpectations": [{"role": "applicant", "personId": case.ids[0]},
                               {"role": "guarantor", "personId": case.ids[1], "mustNotMergeWith": case.ids[0]}]})
    nf += _forensic_nonfindings(case, set(), "Genuine, unedited document (ground truth).")
    return [], nf


def build_s5(case: Case, v: str):
    dob = case.by_id[case.ids[0]]["date_of_birth"]
    shift = 3 if v == "a" else -2
    ei, pi = case.id_card(source=(v == "b"))
    ea, pa = case.application(source=(v == "a"))
    eb, pb = case.statement()
    case.add(eb, "genuine")
    if v == "a":   # digital PDF: the form DOB is changed in an appended revision
        case.add(ei, "genuine")
        new = _bump_year(T.field_of(ea, "date_of_birth")["text"], shift)
        dst = case.path(f"{ea['doc_id']}.pdf")
        gt = T.tamper_incremental_edit(pa, dst, ea, "date_of_birth", base=case.dir, new_text=new)
        gt = _gt_in_case(case, gt, 1)
        doc = _doc_from_tamper(case, ea, gt, dst, variant="original")
        _apply_edit(doc, "date_of_birth", new, new)
    else:          # scanned ID: the DOB digits are painted over and retyped
        case.add(ea, "genuine")
        scan_e, scan_p = case.scan_of(ei, pi, BASE_SEED + 777, f"_scan_{ei['doc_id']}.jpg", source=True)
        dst = case.path(f"{ei['doc_id']}.jpg")
        new = _bump_year(T.field_of(scan_e, "date_of_birth")["text"], shift)
        gt = T.tamper_paint_retype_scan(scan_p, dst, scan_e, "date_of_birth", base=case.dir, new_text=new,
                                        font_file="LiberationSans-Bold.ttf")
        gt = _gt_in_case(case, gt, 1)
        doc = _doc_from_tamper(case, scan_e, gt, dst, variant="scan")
        new_iso = _bump_year(T.field_of(ei, "date_of_birth")["value"], shift)
        _apply_edit(doc, "date_of_birth", new, new_iso)
    dob_f = {"expectedId": "EF-001", "type": "DOB_CONFLICT", "category": "cross_document",
             "observationStatus": "INCONSISTENT", "severity": "high",
             "documents": [case.docs[ei["doc_id"]]["doc_id"], case.docs[ea["doc_id"]]["doc_id"]],
             "ruleId": "R-DOB-MUST-AGREE",
             "evidence": [_ev(case.docs[ei["doc_id"]], "date_of_birth"), _ev(case.docs[ea["doc_id"]], "date_of_birth")],
             "scoring": "required", "relatedFindings": ["EF-002"],
             "notes": f"Applicant date of birth reads {dob} on one document and a different year on the other; "
                      "the differing value sits in the edited region (see EF-002)."}
    tamper_f = _tamper_finding(case, gt, "EF-002", doc, related=["EF-001"])
    nf = _legit_nonfindings(case) + _forensic_nonfindings(
        case, {doc["doc_id"]}, "Genuine, unedited document (ground truth).")
    return [dob_f, tamper_f], nf


def build_s6(case: Case, v: str):
    ei, _ = case.id_card()
    case.add(ei, "genuine")
    if v == "a":   # a single value re-set in another font on the statement; the text itself is unchanged
        ea, _ = case.application()
        case.add(ea, "genuine")
        eb, pb = case.statement(source=True)
        dst = case.path(f"{eb['doc_id']}.pdf")
        gt = T.tamper_change_pdf_font(pb, dst, eb, "transaction_05_balance", base=case.dir)
        gt = _gt_in_case(case, gt, 1)
        doc = _doc_from_tamper(case, eb, gt, dst, variant="original")
        field = "transaction_05_balance"
    else:          # a different signature on the scanned application form
        ea, pa = case.application(source=True)
        eb, _ = case.statement()
        case.add(eb, "genuine")
        scan_e, scan_p = case.scan_of(ea, pa, BASE_SEED + 888, f"_scan_{ea['doc_id']}.jpg", source=True)
        dst = case.path(f"{ea['doc_id']}.jpg")
        gt = T.tamper_paste_signature(scan_p, dst, scan_e, "applicant_signature", base=case.dir, seed=737373)
        gt = _gt_in_case(case, gt, 1)
        doc = _doc_from_tamper(case, scan_e, gt, dst, variant="scan")
        field = "applicant_signature"
    tamper_f = _tamper_finding(case, gt, "EF-001", doc)
    nf = _legit_nonfindings(case)
    nf.append({"nonFindingId": "NF-060",
               "description": f"The edit to '{field}' creates no comparable contradiction with another document.",
               "documents": [doc["doc_id"]], "fields": [_ev(doc, field)],
               "forbiddenTypes": CROSS_DOC_TYPES, "ruleId": None,
               "reason": "No cross-document inconsistency is present; the finding is a forensic observation only."})
    nf += _forensic_nonfindings(case, {doc["doc_id"]}, "Genuine, unedited document (ground truth).")
    return [tamper_f], nf


def build_s7(case: Case, v: str):
    st = compute_statement(case.persons["bank_account"])
    if v == "a":
        key, delta, label, kind = "total_debits", Decimal("100.00"), "debits", "table_total_debits"
    else:
        key, delta, label, kind = "total_credits", Decimal("-75.50"), "credits", "table_total_credits"
    printed_val = st[key] + delta
    ei, _ = case.id_card()
    ea, _ = case.application()
    eb, _ = case.statement(printed={key: printed_val})
    for d in (ei, ea, eb):
        case.add(d, "genuine")
    finding = {
        "expectedId": "EF-001", "type": "STATEMENT_TOTAL_MISMATCH", "category": "context",
        "observationStatus": "INCONSISTENT", "severity": "medium", "documents": [eb["doc_id"]],
        "ruleId": "R-STMT-TOTAL-ARITH",
        "evidence": [_ev(eb, f"total_{label}"), _ev(eb, kind)],
        "listedSum": money(st[key]), "printedTotal": money(printed_val), "scoring": "required",
        "notes": f"Printed total {label} {money(printed_val)} but the listed transactions sum to {money(st[key])} "
                 f"(difference {money(delta)}). The statement file is otherwise unedited: it is an arithmetic "
                 "inconsistency in the content, not a pixel-level or structural edit."}
    nf = _legit_nonfindings(case) + _forensic_nonfindings(case, set(), "Genuine, unedited document (ground truth).")
    return [finding], nf


def build_s8(case: Case, v: str):
    q = 85 if v == "a" else 70
    ei, pi = case.id_card(source=True)
    ea, pa = case.application(source=True)
    eb, pb = case.statement(source=True)
    for e, p in ((ei, pi), (ea, pa), (eb, pb)):
        case.add(case.recompressed_of(e, p, q), "control")
    reason = f"Control: genuine content only recompressed as JPEG quality {q}; no edit was made."
    return [], _legit_nonfindings(case) + _forensic_nonfindings(case, set(), reason)


BUILDERS = {"S1": build_s1, "S2": build_s2, "S3": build_s3, "S4": build_s4,
            "S5": build_s5, "S6": build_s6, "S7": build_s7, "S8": build_s8}


# ----------------------------------------------------------------------------- driver
def build_case(pattern: str, name: str, variant: str, folder: Path, case_no: int, used: set) -> dict:
    case_id = f"{pattern}{variant}"
    persons = make_persons(case_no, variant, used)
    case = Case(folder, case_id, persons)
    findings, non_findings = BUILDERS[pattern](case, variant)
    src_dir = folder / "_genuine_source"
    sources = [{"file": f.relative_to(folder).as_posix(), "sha256": T.sha256_file(f),
                "note": "unedited original from which a case document was derived"}
               for f in sorted(src_dir.rglob("*"))] if src_dir.is_dir() else []
    people = [{k: p[k] for k in ("person_id", "role", "full_name", "date_of_birth", "id_number")}
              for p in case.persons["persons"]]
    meta = {"schema": SCHEMA, "caseId": case_id, "pattern": pattern, "patternName": name, "variant": variant,
            "split": SPLITS[variant], "fictional": True, "bbox_format": "xywh",
            "persons": people, "documents": list(case.docs.values()), "genuine_sources": sources,
            "tamper_ground_truth": case.tamper_gt,
            "legitimate_differences": [n["legitimateDifferenceId"] for n in non_findings
                                       if "legitimateDifferenceId" in n]}
    write_json(folder / "case.json", meta)
    write_json(folder / "expected_findings.json", {"schema": SCHEMA, "caseId": case_id, "bbox_format": "xywh",
                                                   "findings": findings})
    write_json(folder / "expected_non_findings.json", {"schema": SCHEMA, "caseId": case_id, "bbox_format": "xywh",
                                                       "non_findings": non_findings})
    return meta


def build_all(out: Path = SAMPLES_DIR, flat: bool = False) -> dict:
    """Build all 16 cases. ``flat=True`` puts every case directly under ``out`` (used by tests)."""
    out = Path(out)
    used = set()
    for sub in ("dev", "test"):
        if not flat and (out / sub).exists():
            shutil.rmtree(out / sub)
    index = []
    for variant in ("a", "b"):
        for no, (pat, name) in enumerate(PATTERNS, 1):
            folder = out / f"{pat}{variant}_{name}" if flat else out / SPLITS[variant] / f"{pat}{variant}_{name}"
            meta = build_case(pat, name, variant, folder, no, used)
            index.append({"caseId": meta["caseId"], "pattern": pat, "patternName": name, "variant": variant,
                          "split": SPLITS[variant], "dir": folder.relative_to(out).as_posix(),
                          "persons": [p["person_id"] for p in meta["persons"]]})
    idx = {"schema": SCHEMA, "note": "dev = variant a (used while building and tuning); "
                                     "test = variant b (held out, never used to tune thresholds).",
           "cases": index}
    write_json(out / "scenarios_index.json", idx)
    return idx


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=SAMPLES_DIR)
    ap.add_argument("--flat", action="store_true")
    args = ap.parse_args(argv)
    idx = build_all(args.out, args.flat)
    for c in idx["cases"]:
        print(f"{c['split']:<5} {c['caseId']:<4} {c['dir']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
