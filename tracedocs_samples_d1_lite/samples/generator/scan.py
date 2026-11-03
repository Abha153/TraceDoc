"""Scan-like raster versions: slight rotation, shading, blur, noise, JPEG compression.

Everything is seeded and uses only Pillow + the stdlib, so output is reproducible.
Bounding boxes are carried through the rotation exactly (see rotate_bbox).
"""
from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageEnhance, ImageFilter

PAPER_TINT = (247, 245, 240)   # off-white paper
BED = (236, 236, 234)          # scanner bed visible in rotated corners
BLUR = 0.6
NOISE_AMP = 0.10               # triangular noise, roughly +/-13 grey levels
CONTRAST = 0.93
JPEG_QUALITY = 72
SCAN_DPI = 200


def rasterize_pdf(pdf_path: Path, dpi: int = SCAN_DPI) -> Image.Image:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        return doc[0].render(scale=dpi / 72).to_pil().convert("RGB")
    finally:
        doc.close()


def _noise(size, rng: random.Random, amp: float) -> Image.Image:
    n = size[0] * size[1]
    a = Image.frombytes("L", size, rng.randbytes(n))
    b = Image.frombytes("L", size, rng.randbytes(n))
    t = ImageChops.add(a, b, scale=2.0)                       # triangular, mean ~127.5
    t = t.point([max(0, min(255, int(round(128 + (v - 127.5) * amp)))) for v in range(256)])
    return Image.merge("RGB", (t, t, t))


def make_scan(img: Image.Image, seed: int, out_path: Path):
    """Write a scan-like JPEG of `img`. Returns the scan parameters (for the manifest)."""
    rng = random.Random(seed)
    angle = round(rng.choice([-1, 1]) * rng.uniform(0.5, 1.2), 2)   # degrees, CCW positive
    shade_turns = rng.choice([0, 1, 2, 3])

    img = img.convert("RGB")
    img = ImageChops.multiply(img, Image.new("RGB", img.size, PAPER_TINT))

    grad = Image.linear_gradient("L")            # 256x256 square, so 90-degree turns are safe
    for _ in range(shade_turns):
        grad = grad.transpose(Image.Transpose.ROTATE_90)
    grad = grad.resize(img.size)
    shade = grad.point([232 + v * 23 // 255 for v in range(256)])
    img = ImageChops.multiply(img, Image.merge("RGB", (shade, shade, shade)))

    img = img.rotate(angle, resample=Image.Resampling.BICUBIC, fillcolor=BED)
    img = img.filter(ImageFilter.GaussianBlur(BLUR))
    img = ImageChops.add(img, _noise(img.size, rng, NOISE_AMP), scale=1.0, offset=-128)
    img = ImageEnhance.Contrast(img).enhance(CONTRAST)
    img.save(out_path, format="JPEG", quality=JPEG_QUALITY, dpi=(SCAN_DPI, SCAN_DPI))
    return {"rotation_deg": angle, "rotation_direction": "counter-clockwise for positive values",
            "blur_radius": BLUR, "noise_amplitude": NOISE_AMP, "contrast": CONTRAST,
            "jpeg_quality": JPEG_QUALITY, "dpi": SCAN_DPI, "seed": seed}


def rotate_bbox(box_norm, size, angle_deg):
    """Normalised bbox -> axis-aligned bbox enclosing it after PIL's rotate(angle).

    PIL rotates counter-clockwise (visually) about the image centre, with y down.
    """
    w, h = size
    cx, cy = w / 2, h / 2
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    x0, y0, x1, y1 = box_norm[0] * w, box_norm[1] * h, box_norm[2] * w, box_norm[3] * h
    xs, ys = [], []
    for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        dx, dy = x - cx, y - cy
        xs.append(cx + dx * ca + dy * sa)
        ys.append(cy - dx * sa + dy * ca)
    clamp = lambda v: min(1.0, max(0.0, v))  # noqa: E731
    return [round(clamp(min(xs) / w), 6), round(clamp(min(ys) / h), 6),
            round(clamp(max(xs) / w), 6), round(clamp(max(ys) / h), 6)]
