"""Checks that the pydantic mirror accepts the shared samples and rejects bad data."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from pydantic import ValidationError  # noqa: E402

from analyze_models import AnalyzeResponse, OcrPage  # noqa: E402

here = pathlib.Path(__file__).parent
analyze = json.loads((here / "examples/analyze-response.sample.json").read_text())
ocr = json.loads((here / "examples/ocr-page.sample.json").read_text())

parsed = AnalyzeResponse.model_validate(analyze)
assert parsed.analyzerStatuses["pdf.fonts"] == "NOT_APPLICABLE"
assert json.loads(parsed.model_dump_json(exclude_none=True)) == analyze, "round trip must be lossless"
OcrPage.model_validate(ocr)


def rejected(mutate, model=AnalyzeResponse, data=analyze):
    bad = json.loads(json.dumps(data))
    mutate(bad)
    try:
        model.model_validate(bad)
    except ValidationError:
        return True
    return False


assert rejected(lambda d: d["fields"][0].update(extra=1)), "unknown field must be rejected"
assert rejected(lambda d: d["analyzerStatuses"].update(ocr="CLEAN")), "CLEAN is not an analyzer status"
assert rejected(lambda d: d["fields"][0]["region"].update(bbox=[0.1, 0.2, 0.3])), "bbox needs 4 numbers"
assert rejected(lambda d: d["pages"][0].update(docType="passport")), "unknown docType must be rejected"
print("pydantic mirror: all checks passed")
