"""Box conversions between the manifest ([x_min, y_min, x_max, y_max]) and the contract
Region.bbox ([x, y, w, h]); both are 0-1 fractions of the page/image, origin top-left."""
from __future__ import annotations


def xyxy_to_xywh(b) -> list:
    x0, y0, x1, y1 = b
    return [round(x0, 6), round(y0, 6), round(x1 - x0, 6), round(y1 - y0, 6)]


def xywh_to_xyxy(b) -> list:
    x, y, w, h = b
    return [round(x, 6), round(y, 6), round(x + w, 6), round(y + h, 6)]


def to_region(doc_id: str, page: int, bbox_xyxy, label: str | None = None) -> dict:
    """A contracts/types.ts `Region` ({docId, page, bbox: [x, y, w, h], label?})."""
    r = {"docId": doc_id, "page": page, "bbox": xyxy_to_xywh(bbox_xyxy)}
    if label:
        r["label"] = label
    return r
