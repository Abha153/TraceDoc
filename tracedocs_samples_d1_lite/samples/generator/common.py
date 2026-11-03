"""Shared helpers for the D1-lite sample generator (samples/ only)."""
from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from pathlib import Path

SEED = 20260101  # default fixed seed -> reproducible output

# Fixed dates so nothing depends on the wall clock.
APPLICATION_DATE = "2026-03-14"
STATEMENT_START = "2026-02-01"
STATEMENT_END = "2026-02-28"

SAMPLES_DIR = Path(__file__).resolve().parents[1]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path: Path, obj) -> None:
    Path(path).write_text(
        json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def money(d) -> str:
    """Machine value for money: plain decimal string, 2dp."""
    return f"{Decimal(d):.2f}"


def money_text(d) -> str:
    """Printed form: thousands separators, 2dp."""
    return f"{Decimal(d):,.2f}"


def fmt_address(a: dict) -> str:
    return f"{a['street']}, {a['city']}, {a['state']} {a['postcode']}"


def norm_bbox(box, w: float, h: float):
    """(x0,y0,x1,y1) in render units, top-left origin -> normalised 0-1 list."""
    x0, y0, x1, y1 = box

    def clamp(v):
        return min(1.0, max(0.0, v))

    return [round(clamp(x0 / w), 6), round(clamp(y0 / h), 6),
            round(clamp(x1 / w), 6), round(clamp(y1 / h), 6)]


def field(name, field_type, text, value, bbox, page=1):
    """Internal field record. bbox is in render units (px or pt), top-left origin."""
    return {"name": name, "field_type": field_type, "text": text,
            "value": value, "page": page, "bbox": tuple(bbox)}
