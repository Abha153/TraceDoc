"""D2: controlled edits of the genuine fictional documents, with ground truth.

Every function takes a genuine file (plus its manifest entry ``doc``) and writes a modified copy,
then returns ONE ground-truth entry. Nothing here is a detector: the entries say exactly what was
changed and where, so detectors and the reasoning engine can be scored against them.

Coordinates
-----------
Ground-truth ``bbox`` and ``region.bbox`` are the contract ``Region`` form ``[x, y, w, h]``, fractions
(0-1) of the page/image, origin top-left. The D1 manifest keeps ``[x_min, y_min, x_max, y_max]`` for
its own ``bbox``; ``bbox.py`` converts. The two are never mixed inside one structure: this module reads
manifest boxes through ``xyxy_to_xywh`` and writes only ``xywh``.

Wording: these are synthetic *test edits*. Entries describe what was changed, never a motive.

CLI: ``python samples/generator/tamper.py`` writes ``samples/tampered/``, ``samples/controls/`` and
``samples/tampered/ground_truth.json`` from the committed D1 files.
"""
from __future__ import annotations

import io
import json
import random
import statistics
import sys
import zlib
from pathlib import Path

if __package__ in (None, ""):  # allow `python samples/generator/tamper.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = "samples.generator"

import pikepdf
from PIL import Image, ImageDraw, ImageFilter
from reportlab.pdfbase import pdfmetrics

from .bbox import xyxy_to_xywh
from .common import SAMPLES_DIR, sha256_file, write_json
from .render_id import _font
from .signature import place, signature_strokes

GT_SCHEMA = "tracedocs-tamper-ground-truth-1"
BBOX_FORMAT = "xywh"  # [x, y, w, h], 0-1 fractions of the page, origin top-left (contract Region)

TAMPER_TYPES = (
    "pdf_value_replaced", "pdf_font_changed", "scan_digits_painted_over", "copy_move_region",
    "signature_replaced", "photo_swapped", "pdf_incremental_save", "pdf_hidden_text",
)
CONTROL_TYPES = ("recompressed_only", "pdf_resaved_only", "legit_bold_value", "legit_highlight")


# ----------------------------------------------------------------------------- helpers
def load_manifest(root: Path = SAMPLES_DIR) -> dict:
    return json.loads((Path(root) / "manifest.json").read_text(encoding="utf-8"))


def doc_entry(manifest: dict, doc_id: str) -> dict:
    for d in manifest["documents"]:
        if d["doc_id"] == doc_id:
            return d
    raise KeyError(doc_id)


def field_of(doc: dict, name: str) -> dict:
    for f in doc["fields"]:
        if f["name"] == name:
            return f
    raise KeyError(f"{doc['doc_id']}: no field {name!r}")


def _rel(p: Path, base: Path) -> str:
    return Path(p).resolve().relative_to(Path(base).resolve()).as_posix()


def alter_digits(text: str) -> str:
    """Deterministic, same-length change of a number: first non-zero digit + 3 (mod 10, never 0)."""
    out, done = [], False
    for ch in text:
        if ch.isdigit() and ch != "0" and not done:
            nd = (int(ch) + 3) % 10 or 1
            out.append(str(nd))
            done = True
        else:
            out.append(ch)
    if not done:
        raise ValueError(f"no digit to alter in {text!r}")
    return "".join(out)


def _union_xyxy(a, b):
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def _clamp_xyxy(b):
    return [min(1.0, max(0.0, v)) for v in b]


def _entry(*, type_: str, role: str, dst: Path, base: Path, src: Path, doc: dict, page: int, xyxy,
           field: str | None, description: str, modality: str, expected_finding: bool, **extra) -> dict:
    xyxy = [round(v, 6) for v in _clamp_xyxy(xyxy)]
    docid = Path(dst).stem
    bbox = xyxy_to_xywh(xyxy)
    e = {
        "type": type_,
        "role": role,                       # "tampered" | "control"
        "file": _rel(dst, base),
        "doc_id": docid,
        "page": page,
        "bbox": bbox,
        "bbox_format": BBOX_FORMAT,
        "region": {"docId": docid, "page": page, "bbox": bbox, "label": field or type_},
        "field": field,
        "description": description,
        "modality": modality,               # digital_pdf | scan_image | id_image
        "expected_finding": expected_finding,
        "source_doc_id": doc["doc_id"],
        "source_file": doc["file"],
        "sha256": sha256_file(dst),
        "source_sha256": sha256_file(src),
        "fictional": True,
    }
    e.update(extra)
    return e


# ----------------------------------------------------------------------------- PDF editing
class _PdfEdit:
    """Open a one-page reportlab PDF and edit its (single) content stream operator by operator."""

    def __init__(self, src: Path):
        self.pdf = pikepdf.open(src)
        self.page = self.pdf.pages[0]
        self.W = float(self.page.MediaBox[2])
        self.H = float(self.page.MediaBox[3])
        self.page.contents_coalesce()
        self.ops = list(pikepdf.parse_content_stream(self.page))

    def locate(self, text: str, box_xyxy) -> dict:
        """The Tj showing ``text`` whose position is closest to the manifest box."""
        want = text.encode("latin-1")
        ex, ey = box_xyxy[0] * self.W, box_xyxy[3] * self.H
        font = size = tm = bt = None
        best = None
        for i, op in enumerate(self.ops):
            o = str(op.operator)
            if o == "Tf":
                font, size = str(op.operands[0]), float(op.operands[1])
            elif o == "BT":
                bt = i
            elif o == "Tm":
                tm = [float(x) for x in op.operands]
            elif o == "Tj" and bytes(op.operands[0]) == want and tm is not None:
                d = abs(tm[4] - ex) + abs((self.H - tm[5]) - ey)
                if best is None or d < best["dist"]:
                    et = next(j for j in range(i, len(self.ops)) if str(self.ops[j].operator) == "ET")
                    best = {"dist": d, "bt": bt, "tj": i, "et": et, "tm": tm, "font": font, "size": size}
        if best is None or best["dist"] > 6:
            raise LookupError(f"text {text!r} not found near its manifest box")
        base = str(self.page.Resources.Font[best["font"]].BaseFont).lstrip("/")
        best["basefont"] = base
        return best

    def width(self, text: str, basefont: str, size: float) -> float:
        return pdfmetrics.stringWidth(text, basefont, size)

    def add_font(self, key: str, basefont: str):
        self.page.Resources.Font[f"/{key}"] = self.pdf.make_indirect(
            pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1,
                               BaseFont=pikepdf.Name(f"/{basefont}")))

    @staticmethod
    def op(operator: str, *operands):
        return pikepdf.ContentStreamInstruction(list(operands), pikepdf.Operator(operator))

    def stream_bytes(self) -> bytes:
        return pikepdf.unparse_content_stream(self.ops)

    def set_stream(self):
        self.page.Contents = self.pdf.make_stream(self.stream_bytes())

    def save(self, dst: Path):
        self.set_stream()
        Path(dst).parent.mkdir(parents=True, exist_ok=True)
        self.pdf.save(dst, static_id=True, compress_streams=True,
                      object_stream_mode=pikepdf.ObjectStreamMode.disable)


def _s(text: str):
    return pikepdf.String(text)


def _replace_text_ops(ed: _PdfEdit, loc: dict, new_text: str, *, font_key: str | None = None,
                      size: float | None = None, new_x: float | None = None):
    """Swap the string (and optionally font/size/x) of the located Tj, wrapped in q..Q so no other
    value inherits the change."""
    tm = list(loc["tm"])
    if new_x is not None:
        tm[4] = new_x
    seg = ed.ops[loc["bt"]:loc["et"] + 1]
    # keep every operator of the original BT..ET block, but rewrite Tm and Tj
    new_seg = []
    for op in seg:
        o = str(op.operator)
        if o == "Tm":
            new_seg.append(_PdfEdit.op("Tm", *[float(v) for v in tm]))
        elif o == "Tj":
            new_seg.append(_PdfEdit.op("Tj", _s(new_text)))
        else:
            new_seg.append(op)
    wrapper = [_PdfEdit.op("q")]
    if font_key:
        wrapper.append(_PdfEdit.op("Tf", pikepdf.Name(f"/{font_key}"), size or loc["size"]))
    ed.ops[loc["bt"]:loc["et"] + 1] = wrapper + new_seg + [_PdfEdit.op("Q")]


def _text_box_xyxy(ed: _PdfEdit, x_pt: float, text: str, basefont: str, size: float, y_range):
    w = ed.width(text, basefont, size)
    return [(x_pt - 0.5) / ed.W, y_range[0], (x_pt + w + 1.0) / ed.W, y_range[1]]


# ----------------------------------------------------------------------------- tamper 1
def tamper_replace_pdf_value(src: Path, dst: Path, doc: dict, field: str, *, base: Path,
                             new_text: str | None = None) -> dict:
    """1. Replace a field value in a digital PDF (same font, same position)."""
    f = field_of(doc, field)
    new_text = new_text or alter_digits(f["text"])
    ed = _PdfEdit(src)
    loc = ed.locate(f["text"], f["bbox"])
    _replace_text_ops(ed, loc, new_text)
    ed.save(dst)
    box = _union_xyxy(f["bbox"], _text_box_xyxy(ed, loc["tm"][4], new_text, loc["basefont"],
                                                loc["size"], (f["bbox"][1], f["bbox"][3])))
    return _entry(type_="pdf_value_replaced", role="tampered", dst=dst, base=base, src=src, doc=doc,
                  page=1, xyxy=box, field=field, modality="digital_pdf", expected_finding=True,
                  description=f"Printed value of '{field}' changed from {f['text']!r} to {new_text!r} by "
                              "rewriting the page content stream; font, size and position unchanged.",
                  original_value=f["text"], edited_value=new_text)


# ----------------------------------------------------------------------------- tamper 2
def tamper_change_pdf_font(src: Path, dst: Path, doc: dict, field: str, *, base: Path,
                           basefont: str = "Times-Roman", size_delta: float = 1.0,
                           align: str = "right") -> dict:
    """2. Change the font and size of a single value in a PDF; the text itself is unchanged."""
    f = field_of(doc, field)
    ed = _PdfEdit(src)
    loc = ed.locate(f["text"], f["bbox"])
    new_size = loc["size"] + size_delta
    ed.add_font("F9", basefont)
    old_w = ed.width(f["text"], loc["basefont"], loc["size"])
    new_w = ed.width(f["text"], basefont, new_size)
    new_x = loc["tm"][4] + (old_w - new_w if align == "right" else 0.0)
    _replace_text_ops(ed, loc, f["text"], font_key="F9", size=new_size, new_x=new_x)
    ed.save(dst)
    box = _union_xyxy(f["bbox"], _text_box_xyxy(ed, new_x, f["text"], basefont, new_size,
                                                (f["bbox"][1] - 0.002, f["bbox"][3] + 0.002)))
    return _entry(type_="pdf_font_changed", role="tampered", dst=dst, base=base, src=src, doc=doc,
                  page=1, xyxy=box, field=field, modality="digital_pdf", expected_finding=True,
                  description=f"Single value '{field}' re-set from {loc['basefont']} {loc['size']:g} pt to "
                              f"{basefont} {new_size:g} pt; every other value keeps the original font.",
                  original_font=f"{loc['basefont']} {loc['size']:g}", edited_font=f"{basefont} {new_size:g}")


# ----------------------------------------------------------------------------- image helpers
def _px(box_xyxy, size):
    w, h = size
    return (round(box_xyxy[0] * w), round(box_xyxy[1] * h), round(box_xyxy[2] * w), round(box_xyxy[3] * h))


def _background(img: Image.Image, box_px, band: int = 3):
    """Median colour of two thin strips just above and below the box (paper colour + shading)."""
    x0, y0, x1, y1 = box_px
    W, H = img.size
    strips = []
    for sy0, sy1 in ((max(0, y0 - band - 2), max(0, y0 - 2)), (min(H, y1 + 2), min(H, y1 + band + 2))):
        if sy1 > sy0:
            raw = img.crop((max(0, x0), sy0, min(W, x1), sy1)).tobytes()
            strips += [tuple(raw[i:i + 3]) for i in range(0, len(raw), 3)]
    if not strips:
        return (245, 245, 245)
    return tuple(int(statistics.median(p[c] for p in strips)) for c in range(3))


def _save_image(img: Image.Image, dst: Path, like: Path, quality: int):
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    if Path(dst).suffix.lower() in (".jpg", ".jpeg"):
        img.save(dst, "JPEG", quality=quality)
    else:
        img.save(dst, "PNG")


# ----------------------------------------------------------------------------- tamper 3
def tamper_paint_retype_scan(src: Path, dst: Path, doc: dict, field: str, *, base: Path,
                             new_text: str | None = None, quality: int = 72,
                             font_file: str = "LiberationSans-Regular.ttf") -> dict:
    """3. Paint over a value in a scanned image with the local paper colour and type new digits."""
    f = field_of(doc, field)
    new_text = new_text or alter_digits(f["text"])
    img = Image.open(src).convert("RGB")
    box = _px(f["bbox"], img.size)
    pad = 2
    area = (box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad)
    d = ImageDraw.Draw(img)
    d.rectangle(area, fill=_background(img, area))
    h = box[3] - box[1]
    font = _font(font_file, max(8, round(h * 0.80)))
    base_y = box[3] - round(h * 0.22)
    d.text((box[0], base_y), new_text, font=font, fill=(24, 24, 28), anchor="ls")
    right = max(box[2], box[0] + round(d.textlength(new_text, font=font)))
    _save_image(img, dst, src, quality)
    new_box = [area[0] / img.size[0], area[1] / img.size[1], (right + pad) / img.size[0], area[3] / img.size[1]]
    return _entry(type_="scan_digits_painted_over", role="tampered", dst=dst, base=base, src=src, doc=doc,
                  page=1, xyxy=_union_xyxy(f["bbox"], new_box), field=field, modality="scan_image",
                  expected_finding=True,
                  description=f"Value of '{field}' covered with the local paper colour and retyped as "
                              f"{new_text!r} (was {f['text']!r}); the new digits are crisper than the scan.",
                  original_value=f["text"], edited_value=new_text)


# ----------------------------------------------------------------------------- tamper 4
def tamper_copy_move(src: Path, dst: Path, doc: dict, source_xyxy, dest_xyxy, *, base: Path,
                     quality: int = 72, label: str = "copy_move") -> dict:
    """4. Copy a region of an image onto another place in the same image (exact pixels)."""
    img = Image.open(src).convert("RGB")
    s = _px(source_xyxy, img.size)
    w, h = s[2] - s[0], s[3] - s[1]
    d0 = _px(dest_xyxy, img.size)
    dx, dy = d0[0], d0[1]
    img.paste(img.crop(s), (dx, dy))
    _save_image(img, dst, src, quality)
    W, H = img.size
    dest = [dx / W, dy / H, (dx + w) / W, (dy + h) / H]
    return _entry(type_="copy_move_region", role="tampered", dst=dst, base=base, src=src, doc=doc, page=1,
                  xyxy=dest, field=None, modality="scan_image", expected_finding=True,
                  description="A region was copied from the source box and pasted unchanged at the "
                              "destination box in the same image; the destination bbox is the affected region.",
                  source_region={"docId": Path(dst).stem, "page": 1,
                                 "bbox": xyxy_to_xywh([round(v, 6) for v in source_xyxy]), "label": label})


# ----------------------------------------------------------------------------- tamper 5
def _draw_signature(img: Image.Image, box_px, seed: int, ink=(20, 30, 120)):
    x0, y0, x1, y1 = box_px
    w, h = x1 - x0, y1 - y0
    k = 3
    layer = Image.new("RGBA", (w * k, h * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    inset = 3 * k
    rect = (inset, inset, w * k - inset, h * k - inset)
    lw = max(2, round(min(w, h) * k * 0.035))
    for stroke in place(signature_strokes(seed), rect):
        d.line(stroke, fill=ink + (255,), width=lw, joint="curve")
    layer = layer.resize((w, h), Image.LANCZOS)
    img.paste(layer, (x0, y0), layer)


def tamper_paste_signature(src: Path, dst: Path, doc: dict, field: str, *, base: Path, seed: int,
                           quality: int = 72) -> dict:
    """5. Replace a signature with a different fictional one (same box, different strokes)."""
    f = field_of(doc, field)
    img = Image.open(src).convert("RGB")
    box = _px(f["bbox"], img.size)
    pad = 3
    area = (box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad)
    ImageDraw.Draw(img).rectangle(area, fill=_background(img, area))
    _draw_signature(img, box, seed)
    _save_image(img, dst, src, quality)
    return _entry(type_="signature_replaced", role="tampered", dst=dst, base=base, src=src, doc=doc, page=1,
                  xyxy=f["bbox"], field=field, modality="scan_image", expected_finding=True,
                  description=f"The signature in '{field}' was erased and a different fictional signature "
                              f"(stroke seed {seed}) was drawn in the same box.", replacement_signature_seed=seed)


# ----------------------------------------------------------------------------- tamper 6
def _alt_photo(size, seed: int) -> Image.Image:
    rng = random.Random(seed)
    w, h = size
    bg = (rng.randint(170, 215), rng.randint(185, 225), rng.randint(190, 235))
    ink = (rng.randint(70, 120), rng.randint(60, 110), rng.randint(60, 100))
    im = Image.new("RGB", size, bg)
    d = ImageDraw.Draw(im)
    d.rectangle((0, h * 0.55, w, h), fill=(rng.randint(40, 90), rng.randint(50, 100), rng.randint(70, 130)))
    d.ellipse((w * 0.30, h * 0.14, w * 0.70, h * 0.58), fill=ink)
    d.pieslice((w * 0.26, h * 0.08, w * 0.74, h * 0.40), 180, 360, fill=(30, 25, 22))
    d.ellipse((w * 0.08, h * 0.62, w * 0.92, h * 1.25), fill=ink)
    return im.filter(ImageFilter.GaussianBlur(0.8))


def tamper_swap_photo(src: Path, dst: Path, doc: dict, field: str = "photo", *, base: Path,
                      seed: int = 91, quality: int = 90) -> dict:
    """6. Swap the portrait on an ID image for a different one."""
    f = field_of(doc, field)
    img = Image.open(src).convert("RGB")
    box = _px(f["bbox"], img.size)
    inner = (box[0] + 3, box[1] + 3, box[2] - 3, box[3] - 3)
    size = (inner[2] - inner[0], inner[3] - inner[1])
    img.paste(_alt_photo(size, seed), (inner[0], inner[1]))
    _save_image(img, dst, src, quality)
    return _entry(type_="photo_swapped", role="tampered", dst=dst, base=base, src=src, doc=doc, page=1,
                  xyxy=f["bbox"], field=field, modality="id_image", expected_finding=True,
                  description="The portrait area of the ID image was replaced with a different synthetic "
                              "portrait (different colours and shapes); the frame and the rest of the card are unchanged.",
                  replacement_photo_seed=seed)


# ----------------------------------------------------------------------------- tamper 7
def tamper_incremental_edit(src: Path, dst: Path, doc: dict, field: str, *, base: Path,
                            new_text: str | None = None) -> dict:
    """7. Edit a PDF with an incremental save: the original bytes stay, a new revision is appended."""
    f = field_of(doc, field)
    new_text = new_text or alter_digits(f["text"])
    ed = _PdfEdit(src)
    loc = ed.locate(f["text"], f["bbox"])
    _replace_text_ops(ed, loc, new_text)
    new_stream = ed.stream_bytes()
    pdf0 = pikepdf.open(src)
    objnum = pdf0.pages[0].Contents.objgen[0]

    data = Path(src).read_bytes()
    if not data.endswith(b"%%EOF\n") and not data.endswith(b"%%EOF"):
        raise ValueError("unexpected PDF tail")
    tail = data[data.rfind(b"startxref"):]
    prev = int(tail.split()[1])
    trailer = data[data.rfind(b"trailer"):data.rfind(b"startxref")]
    size = int(pdf0.trailer.Size)
    body = zlib.compress(new_stream, 9)
    obj = (f"{objnum} 0 obj\n<< /Filter /FlateDecode /Length {len(body)} >>\nstream\n").encode() \
        + body + b"\nendstream\nendobj\n"
    out = bytearray(data if data.endswith(b"\n") else data + b"\n")
    obj_off = len(out)
    out += obj
    xref_off = len(out)
    out += f"xref\n{objnum} 1\n{obj_off:010d} 00000 n \n".encode()
    root_ref, info_ref = pdf0.trailer.Root.objgen[0], pdf0.trailer.Info.objgen[0]
    pid = pdf0.trailer.get("/ID")
    id_part = ""
    if pid is not None:
        id_part = " /ID [<" + bytes(pid[0]).hex() + "><" + bytes(pid[1]).hex() + ">]"
    out += (f"trailer\n<< /Size {size} /Root {root_ref} 0 R /Info {info_ref} 0 R /Prev {prev}{id_part} >>\n"
            f"startxref\n{xref_off}\n%%EOF\n").encode()
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    Path(dst).write_bytes(bytes(out))
    return _entry(type_="pdf_incremental_save", role="tampered", dst=dst, base=base, src=src, doc=doc, page=1,
                  xyxy=f["bbox"], field=field, modality="digital_pdf", expected_finding=True,
                  description=f"Value of '{field}' changed from {f['text']!r} to {new_text!r} in an appended "
                              "revision (incremental update); the original revision is still present in the file.",
                  original_value=f["text"], edited_value=new_text, revisions=2)


# ----------------------------------------------------------------------------- tamper 8
def tamper_hidden_text(src: Path, dst: Path, doc: dict, field: str, *, base: Path,
                       hidden_text: str | None = None, method: str = "white_on_white",
                       gap_pt: float = 8.0) -> dict:
    """8. Add text that is not visible (white on white, or render mode 3) next to a value; it is part of
    the text layer and differs from what is visible."""
    if method not in ("white_on_white", "invisible_render_mode"):
        raise ValueError(method)
    f = field_of(doc, field)
    hidden_text = hidden_text or alter_digits(f["text"])
    ed = _PdfEdit(src)
    loc = ed.locate(f["text"], f["bbox"])
    vis_w = ed.width(f["text"], loc["basefont"], loc["size"])
    x = loc["tm"][4] + vis_w + gap_pt
    tm = list(loc["tm"])
    tm[4] = x
    extra = [_PdfEdit.op("q"), _PdfEdit.op("BT"), _PdfEdit.op("Tf", pikepdf.Name(loc["font"]), loc["size"])]
    if method == "white_on_white":
        extra.append(_PdfEdit.op("rg", 1.0, 1.0, 1.0))
    else:
        extra.append(_PdfEdit.op("Tr", 3))
    extra += [_PdfEdit.op("Tm", *[float(v) for v in tm]), _PdfEdit.op("Tj", _s(hidden_text)),
              _PdfEdit.op("ET"), _PdfEdit.op("Q")]
    ed.ops[loc["et"] + 1:loc["et"] + 1] = extra
    ed.save(dst)
    box = _text_box_xyxy(ed, x, hidden_text, loc["basefont"], loc["size"], (f["bbox"][1], f["bbox"][3]))
    return _entry(type_="pdf_hidden_text", role="tampered", dst=dst, base=base, src=src, doc=doc, page=1,
                  xyxy=box, field=field, modality="digital_pdf", expected_finding=True,
                  description=f"Text {hidden_text!r} was added right of the visible value {f['text']!r} "
                              f"({method.replace('_', ' ')}); it appears in the text layer but not on the rendered page.",
                  visible_value=f["text"], hidden_value=hidden_text, method=method)


# ----------------------------------------------------------------------------- controls
def control_recompress(src: Path, dst: Path, doc: dict, *, base: Path, quality: int = 85) -> dict:
    """Control: re-save a genuine image as JPEG; no content change."""
    img = Image.open(src).convert("RGB")
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, "JPEG", quality=quality)
    return _entry(type_="recompressed_only", role="control", dst=dst, base=base, src=src, doc=doc, page=1,
                  xyxy=[0, 0, 1, 1], field=None, modality="scan_image", expected_finding=False,
                  description=f"Genuine image only re-saved as JPEG quality {quality}; content unchanged. "
                              "Detectors should not report an edit.", jpeg_quality=quality)


def control_resave_pdf(src: Path, dst: Path, doc: dict, *, base: Path) -> dict:
    """Control: re-save a genuine PDF through a PDF library with no change to the page content."""
    with pikepdf.open(src) as pdf:
        Path(dst).parent.mkdir(parents=True, exist_ok=True)
        pdf.save(dst, static_id=True, compress_streams=True,
                 object_stream_mode=pikepdf.ObjectStreamMode.disable)
    return _entry(type_="pdf_resaved_only", role="control", dst=dst, base=base, src=src, doc=doc, page=1,
                  xyxy=[0, 0, 1, 1], field=None, modality="digital_pdf", expected_finding=False,
                  description="Genuine PDF re-saved by a PDF library; page content unchanged. "
                              "Detectors should not report an edit.")


def control_bold_value(src: Path, dst: Path, doc: dict, field: str, *, base: Path) -> dict:
    """Control: a value legitimately set in bold in an otherwise regular line."""
    f = field_of(doc, field)
    ed = _PdfEdit(src)
    loc = ed.locate(f["text"], f["bbox"])
    ed.add_font("F9", "Helvetica-Bold")
    _replace_text_ops(ed, loc, f["text"], font_key="F9", size=loc["size"])
    ed.save(dst)
    box = _union_xyxy(f["bbox"], _text_box_xyxy(ed, loc["tm"][4], f["text"], "Helvetica-Bold", loc["size"],
                                                (f["bbox"][1], f["bbox"][3])))
    return _entry(type_="legit_bold_value", role="control", dst=dst, base=base, src=src, doc=doc, page=1,
                  xyxy=box, field=field, modality="digital_pdf", expected_finding=False,
                  description=f"Value '{field}' set in bold for emphasis; the text is unchanged. "
                              "Legitimate formatting, not an edit of the content.")


def control_highlight_value(src: Path, dst: Path, doc: dict, field: str, *, base: Path) -> dict:
    """Control: a value legitimately highlighted (a filled rectangle behind unchanged text)."""
    f = field_of(doc, field)
    ed = _PdfEdit(src)
    loc = ed.locate(f["text"], f["bbox"])
    x0, y0, x1, y1 = (f["bbox"][0] * ed.W - 2, (1 - f["bbox"][3]) * ed.H - 1.5,
                      f["bbox"][2] * ed.W + 2, (1 - f["bbox"][1]) * ed.H + 1.5)
    rect = [_PdfEdit.op("q"), _PdfEdit.op("rg", 1.0, 0.95, 0.45),
            _PdfEdit.op("re", x0, y0, x1 - x0, y1 - y0), _PdfEdit.op("f"), _PdfEdit.op("Q")]
    ed.ops[loc["bt"]:loc["bt"]] = rect
    ed.save(dst)
    box = [x0 / ed.W, 1 - y1 / ed.H, x1 / ed.W, 1 - y0 / ed.H]
    return _entry(type_="legit_highlight", role="control", dst=dst, base=base, src=src, doc=doc, page=1,
                  xyxy=box, field=field, modality="digital_pdf", expected_finding=False,
                  description=f"Value '{field}' highlighted with a filled rectangle behind unchanged text. "
                              "Legitimate markup, not an edit of the content.")


# ----------------------------------------------------------------------------- batch
def build_all(root: Path = SAMPLES_DIR, out: Path | None = None) -> dict:
    """Create every D2 sample from the D1 files under ``root`` into ``out`` (default: ``root``)."""
    root = Path(root)
    out = Path(out) if out else root
    m = load_manifest(root)
    D = lambda i: doc_entry(m, i)  # noqa: E731
    P = lambda rel: root / rel     # noqa: E731
    T = lambda name: out / "tampered" / name  # noqa: E731
    C = lambda name: out / "controls" / name  # noqa: E731
    entries = []

    app, bank = D("loan_application_001"), D("bank_statement_001")
    app_scan, bank_scan = D("loan_application_001_scan"), D("bank_statement_001_scan")
    idc = D("id_card_001")

    entries.append(tamper_replace_pdf_value(P(app["file"]), T("loan_application_001__value_replaced.pdf"),
                                            app, "requested_loan_amount", base=out))
    entries.append(tamper_change_pdf_font(P(bank["file"]), T("bank_statement_001__font_changed.pdf"),
                                          bank, "transaction_05_balance", base=out))
    entries.append(tamper_paint_retype_scan(P(app_scan["file"]), T("loan_application_001_scan__digits_retyped.jpg"),
                                            app_scan, "requested_loan_amount", base=out))
    rows = bank_scan["tables"][0]["rows"]
    s, d = rows[1]["bbox"], rows[8]["bbox"]
    entries.append(tamper_copy_move(P(bank_scan["file"]), T("bank_statement_001_scan__copy_move.jpg"), bank_scan,
                                    s, d, base=out, label="transaction_row_02_to_09"))
    entries.append(tamper_paste_signature(P(app_scan["file"]), T("loan_application_001_scan__signature_replaced.jpg"),
                                          app_scan, "applicant_signature", base=out, seed=424242))
    entries.append(tamper_swap_photo(P(idc["file"]), T("id_card_001__photo_swapped.png"), idc, base=out))
    entries.append(tamper_incremental_edit(P(bank["file"]), T("bank_statement_001__incremental_edit.pdf"), bank,
                                           "closing_balance", base=out))
    app2 = D("loan_application_002")
    entries.append(tamper_hidden_text(P(app2["file"]), T("loan_application_002__hidden_white_text.pdf"), app2,
                                      "requested_loan_amount", base=out))
    entries.append(tamper_hidden_text(P(app2["file"]), T("loan_application_002__hidden_invisible_text.pdf"), app2,
                                      "date_of_birth", base=out, method="invisible_render_mode",
                                      hidden_text="1969-12-31"))

    controls = [
        control_recompress(P(app_scan["file"]), C("loan_application_001_scan__recompressed.jpg"), app_scan, base=out),
        control_resave_pdf(P(bank["file"]), C("bank_statement_001__resaved.pdf"), bank, base=out),
        control_bold_value(P(app["file"]), C("loan_application_001__bold_value.pdf"), app, "full_name", base=out),
        control_highlight_value(P(app["file"]), C("loan_application_001__highlighted_value.pdf"), app,
                                "requested_loan_amount", base=out),
    ]
    entries = [{"id": f"T-{i:02d}", **e} for i, e in enumerate(entries, 1)] + \
              [{"id": f"C-{i:02d}", **e} for i, e in enumerate(controls, 1)]
    gt = {
        "schema": GT_SCHEMA,
        "fictional": True,
        "note": "Synthetic test edits of fictional documents. 'tampered' = an edit was applied for testing; "
                "'control' = a genuine file that must NOT be reported as edited. No intent is implied.",
        "bbox_format": BBOX_FORMAT,
        "bbox_note": "bbox and region.bbox are [x, y, w, h], 0-1 fractions of the page, origin top-left.",
        "entries": entries,
    }
    write_json(out / "tampered" / "ground_truth.json", gt)
    return gt


if __name__ == "__main__":
    g = build_all()
    for e in g["entries"]:
        print(f"{e['id']}  {e['role']:<8} {e['type']:<26} {e['file']}")
