"""Fictional SAMPLE ID card (PNG). Invented design - does not imitate any real ID."""
from __future__ import annotations

import math
import os
from datetime import date
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .common import field, fmt_address
from .signature import place, signature_strokes

W, H = 1011, 638  # CR80 aspect at ~300 dpi
# Liberation Sans/Mono (metric-compatible with Arial/Courier, SIL OFL 1.1), bundled in generator/fonts/ so the output is
# the same on Linux, macOS and Windows. Search order: TRACEDOCS_FONT_DIR (explicit override), the bundled folder, then
# common system folders as a last resort.
BUNDLED_FONT_DIR = Path(__file__).resolve().parent / "fonts"
SYSTEM_FONT_DIRS = (Path("/usr/share/fonts/truetype/liberation"), Path("/usr/share/fonts/liberation"),
                    Path("/usr/share/fonts/liberation-fonts"), Path("/Library/Fonts"))


def font_dirs() -> list[Path]:
    override = os.environ.get("TRACEDOCS_FONT_DIR")
    return ([Path(override)] if override else []) + [BUNDLED_FONT_DIR, *SYSTEM_FONT_DIRS]

NAVY = (20, 40, 80)
INK = (15, 15, 15)
GREY = (90, 100, 110)
RED = (170, 25, 25)
BAND = (214, 230, 242)
SIG_INK = (20, 30, 120)


def find_font(name: str) -> Path:
    for d in font_dirs():
        if (d / name).is_file():
            return d / name
    raise FileNotFoundError(f"Font {name} not found in: " + ", ".join(str(d) for d in font_dirs())
                            + ". It should be in samples/generator/fonts/; or set TRACEDOCS_FONT_DIR.")


def _font(name: str, size: int):
    return ImageFont.truetype(str(find_font(name)), size)


def _fmt_date(iso: str) -> str:
    return f"{date.fromisoformat(iso):%d %b %Y}".upper()


def render_id(person: dict, out_path: Path):
    """Draw the card. Returns (fields, (W, H)); bboxes are pixels, top-left origin."""
    img = Image.new("RGB", (W, H), (240, 244, 249))
    d = ImageDraw.Draw(img)
    fields: list = []

    # faint guilloche-style background waves (decorative, low contrast)
    for k in range(120, H - 30, 14):
        pts = [(x, k + 6 * math.sin(x / 40 + k / 10)) for x in range(0, W, 8)]
        d.line(pts, fill=(222, 232, 242), width=2)

    # header band + footer strip
    d.rectangle((0, 0, W, 100), fill=BAND)
    d.rectangle((0, 612, W, H), fill=BAND)
    d.rectangle((0, 0, W - 1, H - 1), outline=NAVY, width=4)
    d.text((40, 52), "REPUBLIC OF SAMPLIA", font=_font("LiberationSans-Bold.ttf", 34), fill=NAVY, anchor="ls")
    d.text((40, 86), "NATIONAL SAMPLE ID CARD", font=_font("LiberationSans-Regular.ttf", 20), fill=NAVY, anchor="ls")
    d.text((40, 632), "SAMPLE ID - FICTIONAL - NOT VALID FOR IDENTIFICATION",
           font=_font("LiberationSans-Regular.ttf", 16), fill=GREY, anchor="ls")

    # SAMPLE stamp (marker field = the stamp rectangle)
    stamp = (760, 22, 971, 78)
    d.rectangle(stamp, outline=RED, width=4)
    d.text(((stamp[0] + stamp[2]) / 2, 64), "SAMPLE", font=_font("LiberationSans-Bold.ttf", 36), fill=RED, anchor="ms")
    fields.append(field("sample_marker", "marker", "SAMPLE", "SAMPLE",
                        (stamp[0] - 2, stamp[1] - 2, stamp[2] + 2, stamp[3] + 2)))

    # photo placeholder
    photo = (40, 140, 290, 440)
    d.rectangle(photo, fill=(205, 210, 216), outline=(90, 90, 90), width=3)
    d.ellipse((117, 207, 213, 303), fill=(150, 158, 168))
    d.ellipse((95, 320, 235, 440), fill=(150, 158, 168))
    d.text((165, 172), "PHOTO PLACEHOLDER", font=_font("LiberationSans-Regular.ttf", 16), fill=(70, 70, 70), anchor="ms")
    fields.append(field("photo", "photo", None, None, (photo[0] - 1, photo[1] - 1, photo[2] + 1, photo[3] + 1)))

    lab = _font("LiberationSans-Regular.ttf", 18)
    val = _font("LiberationSans-Bold.ttf", 34)
    addr_f = _font("LiberationSans-Bold.ttf", 30)
    mono = _font("LiberationMono-Bold.ttf", 34)
    small = _font("LiberationSans-Bold.ttf", 28)

    def put(name, ftype, x, base, text, font, value, pad=2):
        d.text((x, base), text, font=font, fill=INK, anchor="ls")
        l, t, r, b = d.textbbox((x, base), text, font=font, anchor="ls")
        fields.append(field(name, ftype, text, value, (l - pad, t - pad, r + pad, b + pad)))
        return (l, t, r, b)

    X = 330
    d.text((X, 150), "NAME", font=lab, fill=GREY, anchor="ls")
    put("full_name", "text", X, 190, person["full_name"].upper(), val, person["full_name"])

    d.text((X, 228), "DATE OF BIRTH", font=lab, fill=GREY, anchor="ls")
    put("date_of_birth", "date", X, 268, _fmt_date(person["date_of_birth"]), val, person["date_of_birth"])
    d.text((720, 228), "ISSUED", font=lab, fill=GREY, anchor="ls")
    put("issue_date", "date", 720, 268, _fmt_date(person["id_issue_date"]), small, person["id_issue_date"])

    # address on two lines: street / city, state zip
    a = person["permanent_address"]
    line1, line2 = a["street"].upper(), f"{a['city']}, {a['state']} {a['postcode']}".upper()
    d.text((X, 306), "ADDRESS", font=lab, fill=GREY, anchor="ls")
    d.text((X, 342), line1, font=addr_f, fill=INK, anchor="ls")
    d.text((X, 378), line2, font=addr_f, fill=INK, anchor="ls")
    b1 = d.textbbox((X, 342), line1, font=addr_f, anchor="ls")
    b2 = d.textbbox((X, 378), line2, font=addr_f, anchor="ls")
    fields.append(field("permanent_address", "text", line1 + "\n" + line2, fmt_address(a),
                        (min(b1[0], b2[0]) - 2, b1[1] - 2, max(b1[2], b2[2]) + 2, b2[3] + 2)))

    d.text((X, 416), "ID NUMBER", font=lab, fill=GREY, anchor="ls")
    put("id_number", "identifier", X, 456, person["id_number"], mono, person["id_number"])
    d.text((720, 416), "EXPIRES", font=lab, fill=GREY, anchor="ls")
    put("expiry_date", "date", 720, 456, _fmt_date(person["id_expiry_date"]), small, person["id_expiry_date"])

    # signature
    rect = (350, 490, 660, 575)
    lw = 3
    for stroke in place(signature_strokes(person["signature_seed"]), rect):
        d.line(stroke, fill=SIG_INK, width=lw, joint="curve")
    d.line((330, 588, 700, 588), fill=GREY, width=2)
    d.text((330, 606), "HOLDER'S SIGNATURE", font=_font("LiberationSans-Regular.ttf", 16), fill=GREY, anchor="ls")
    fields.append(field("signature", "signature", None, None,
                        (rect[0] - 2, rect[1] - 2, rect[2] + 2, rect[3] + 2)))

    img.save(out_path, format="PNG", dpi=(300, 300), optimize=False)
    return fields, (W, H)
