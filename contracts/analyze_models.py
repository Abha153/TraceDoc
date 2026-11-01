"""Pydantic mirror of contracts/types.ts and contracts/ocr.ts (Python analysis service side).

Field names are identical to the TypeScript contracts (camelCase). Do not rename or add fields here
without changing contracts/types.ts and regenerating the schemas in the same commit.
Import with contracts/ on PYTHONPATH:  from analyze_models import AnalyzeResponse
"""
from __future__ import annotations

from typing import Dict, List, Literal, Optional, Tuple, Union

from pydantic import BaseModel, ConfigDict, Field

AnalyzerStatus = Literal["AVAILABLE", "UNAVAILABLE", "ERROR", "NOT_APPLICABLE"]
DocType = Literal["id_card", "application_form", "bank_statement", "other", "UNKNOWN", "AMBIGUOUS"]
BBox = Tuple[float, float, float, float]  # x, y, w, h normalized 0..1 to the canonical render
Scalar = Union[float, int, str]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Region(_Model):
    docId: str
    page: int = Field(ge=1)
    bbox: BBox
    label: Optional[str] = None


class Provenance(_Model):
    analyzer: str
    analyzerVersion: str
    modelVersion: Optional[str] = None
    config: Dict[str, Scalar]
    inputSha256: str
    processedAt: str
    status: AnalyzerStatus


class PageRecord(_Model):
    docId: str
    page: int = Field(ge=1)
    renderPath: str
    renderDpi: float
    rotationDeg: float
    deskewDeg: float
    docType: DocType
    docTypeConfidence: float
    docTypeOverriddenBy: Optional[str] = None


class ExtractedField(_Model):
    fieldId: str
    docId: str
    name: str
    rawValue: str
    normalizedValue: Optional[str]
    ocrConfidence: float = Field(ge=0, le=1)
    extractionConfidence: float = Field(ge=0, le=1)
    validationStatus: Literal["VALID", "INVALID_FORMAT", "NOT_CHECKED"]
    region: Region
    source: Literal["ocr", "pdf_text_layer"]


class ForensicSignal(_Model):
    signalId: str
    detector: str
    type: str
    regions: List[Region]
    confidence: float = Field(ge=0, le=1)
    measurements: Dict[str, Scalar]
    provenance: Provenance


class AnalyzeResponse(_Model):
    docId: str
    pipelineVersion: str
    pages: List[PageRecord]
    fields: List[ExtractedField]
    signals: List[ForensicSignal]
    analyzerStatuses: Dict[str, AnalyzerStatus]
    provenance: List[Provenance]


class OcrWord(_Model):
    text: str
    bbox: BBox
    ocrConfidence: float = Field(ge=0, le=1)
    lineIndex: int


class OcrLine(_Model):
    text: str
    bbox: BBox
    ocrConfidence: float = Field(ge=0, le=1)
    wordIndices: List[int]


class OcrPage(_Model):
    docId: str
    page: int = Field(ge=1)
    widthPx: int
    heightPx: int
    renderDpi: float
    engine: str
    engineVersion: str
    words: List[OcrWord]
    lines: List[OcrLine]
