"""Build "perfect OCR" engine inputs from the ground-truth manifests of samples/dev and samples/test.

Each case becomes ``<out>/<caseId>.json`` = ``{caseId, documents: AnalyzeResponse[]}`` (contracts/types.ts), the exact
input of ``runReasoning`` in backend/src/engine. Extraction is assumed perfect (values come from the manifests) and no
forensic analyzer ran (``signals`` is empty and their status is UNAVAILABLE, never "clean"), so this checks the
cross-document REASONING only: entity resolution, comparability rules, arithmetic.

Field names are mapped to names the engine's alias table accepts (backend/src/engine/assertions.ts), the way a faithful
extractor would. Names with no alias (e.g. debit rows) pass through unchanged and are ignored by the rules.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

SAMPLES = Path(__file__).resolve().parents[1]
DOC_TYPE = {"id_card": "id_card", "loan_application": "application_form", "bank_statement": "bank_statement"}
SKIP = {"marker", "photo", "signature", "signature_date", "application_number", "loan_term_months", "loan_purpose",
        "guarantor_relationship", "transaction_date", "transaction_description", "running_balance", "statement_period"}
ANALYZERS = ("pdf.textlayer", "pdf.fonts", "image.ela", "image.noise", "image.copymove", "signature")


def engine_name(field_name: str) -> str:
    if field_name.startswith("transaction_") and field_name.endswith("_credit"):
        return "txn_amount"
    if field_name.startswith("transaction_") and field_name.endswith("_debit"):
        return "transaction_debit"          # no engine alias yet: not compared
    if field_name == "account_holder_address":
        return "address_current"
    return field_name


def analyze_response(doc: dict) -> dict:
    fields = []
    for f in doc["fields"]:
        if f["semantic_type"] in SKIP or f["name"].startswith("table_"):
            continue
        fields.append({
            "fieldId": f"{doc['doc_id']}-F{len(fields) + 1:03d}", "docId": doc["doc_id"], "name": engine_name(f["name"]),
            "rawValue": f["text"], "normalizedValue": f["value"], "ocrConfidence": 0.99, "extractionConfidence": 0.99,
            "validationStatus": "VALID", "region": f["region"], "source": "ocr"})
    return {
        "docId": doc["doc_id"], "pipelineVersion": "ground-truth-0",
        "pages": [{"docId": doc["doc_id"], "page": 1, "renderPath": doc["file"], "renderDpi": 150, "rotationDeg": 0,
                   "deskewDeg": 0.0, "docType": DOC_TYPE[doc["doc_type"]], "docTypeConfidence": 1.0}],
        "fields": fields, "signals": [],
        "analyzerStatuses": {"ocr": "AVAILABLE", **{a: "UNAVAILABLE" for a in ANALYZERS}},
        "provenance": [{"analyzer": "ocr", "analyzerVersion": "ground-truth", "modelVersion": "manifest", "config": {},
                        "inputSha256": doc["sha256"], "processedAt": "2026-11-05T00:00:00Z", "status": "AVAILABLE"}]}


def build_inputs(samples: Path = SAMPLES, out: Path | None = None) -> dict[str, dict]:
    result = {}
    for split in ("dev", "test"):
        for d in sorted((Path(samples) / split).iterdir()):
            case = json.loads((d / "case.json").read_text(encoding="utf-8"))
            result[case["caseId"]] = {"caseId": case["caseId"], "documents": [analyze_response(x) for x in case["documents"]]}
    if out:
        Path(out).mkdir(parents=True, exist_ok=True)
        for cid, payload in result.items():
            (Path(out) / f"{cid}.json").write_text(json.dumps(payload), encoding="utf-8")
    return result


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("engine_inputs")
    print(f"wrote {len(build_inputs(out=target))} cases to {target}")
