from __future__ import annotations

import json
import math
import random
import unicodedata
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

from faker import Faker
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas


SEED = 714203
PAGE_WIDTH = 1240
PAGE_HEIGHT = 1754
DPI = 150
FIELD_NAMES = {
    "full_name",
    "dob",
    "id_number",
    "address_permanent",
    "address_current",
    "requested_amount",
    "account_number",
    "account_balance",
    "statement_total",
    "txn_amount",
    "guarantor_full_name",
    "guarantor_id_number",
}


def _ascii(value: str) -> str:
    return unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")


def _json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        (r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\arial.ttf")
        if bold
        else (r"C:\Windows\Fonts\arial.ttf",)
    )
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default(size=size)


def _make_persons() -> dict[str, Any]:
    fake = Faker("en_US")
    fake.seed_instance(SEED)
    applicant_name = _ascii(fake.name())
    guarantor_name = _ascii(fake.name())
    applicant_dob = fake.date_between_dates(date(1980, 1, 1), date(1998, 12, 31))
    guarantor_dob = fake.date_between_dates(date(1970, 1, 1), date(1995, 12, 31))

    return {
        "seed": SEED,
        "applicant": {
            "full_name": applicant_name,
            "dob": applicant_dob.isoformat(),
            "id_number": "TDX-APP-7316-KR",
            "address_permanent": "17 Example Lane, Demo District, Sample City, ZZ 00000",
            "address_current": "44 Placeholder Road, Fictional Quarter, Sample City, ZZ 00000",
        },
        "guarantor": {
            "full_name": guarantor_name,
            "dob": guarantor_dob.isoformat(),
            "id_number": "TDX-GUA-2845-MQ",
            "address_permanent": "8 Fiction Street, Imaginary Ward, Sample City, ZZ 00000",
        },
    }


def _new_page() -> tuple[Image.Image, ImageDraw.ImageDraw, list[dict[str, Any]]]:
    image = Image.new("RGB", (PAGE_WIDTH, PAGE_HEIGHT), "#fbfcfe")
    return image, ImageDraw.Draw(image), []


def _text(
    draw: ImageDraw.ImageDraw,
    runs: list[dict[str, Any]],
    x: int,
    y: int,
    text: str,
    size: int = 28,
    color: str = "#172b4d",
    bold: bool = False,
) -> tuple[int, int, int, int]:
    text = _ascii(text)
    font = _font(size, bold)
    draw.text((x, y), text, font=font, fill=color)
    bbox = draw.textbbox((x, y), text, font=font)
    runs.append({"x": x, "y": y, "size": size, "text": text})
    return bbox


def _field(
    draw: ImageDraw.ImageDraw,
    runs: list[dict[str, Any]],
    fields: list[dict[str, Any]],
    name: str,
    value: str,
    x: int,
    y: int,
    size: int = 31,
) -> None:
    _text(draw, runs, x, y - 34, name.replace("_", " ").title(), 21, "#52647b", True)
    bbox = _text(draw, runs, x, y, value, size, "#132238")
    fields.append(
        {
            "name": name,
            "value": value,
            "bbox": _normalized_bbox(bbox),
        }
    )


def _normalized_bbox(box: tuple[int, int, int, int]) -> list[float]:
    left, top, right, bottom = box
    left = max(0, left)
    top = max(0, top)
    right = min(PAGE_WIDTH, right)
    bottom = min(PAGE_HEIGHT, bottom)
    return [
        round(left / PAGE_WIDTH, 6),
        round(top / PAGE_HEIGHT, 6),
        round((right - left) / PAGE_WIDTH, 6),
        round((bottom - top) / PAGE_HEIGHT, 6),
    ]


def _draw_id_card(person: dict[str, Any]) -> tuple[Image.Image, list[dict[str, Any]], list[dict[str, Any]]]:
    image, draw, runs = _new_page()
    fields: list[dict[str, Any]] = []
    draw.rounded_rectangle((105, 175, 1135, 1510), radius=42, fill="#ffffff", outline="#184a73", width=5)
    draw.rounded_rectangle((105, 175, 1135, 340), radius=40, fill="#17496f")
    draw.rectangle((105, 285, 1135, 340), fill="#17496f")
    _text(draw, runs, 160, 215, "SAMPLE IDENTIFICATION CARD", 44, "#ffffff", True)
    _text(draw, runs, 161, 293, "FICTIONAL TRAINING DOCUMENT - NOT AN OFFICIAL ID", 22, "#dceaf5", True)

    draw.rounded_rectangle((155, 415, 460, 890), radius=18, fill="#e7edf3", outline="#7f93a8", width=3)
    draw.ellipse((250, 500, 365, 615), fill="#9aabba")
    draw.rounded_rectangle((215, 645, 400, 835), radius=80, fill="#9aabba")
    _text(draw, runs, 191, 848, "PHOTO PLACEHOLDER", 20, "#314b63", True)

    _field(draw, runs, fields, "full_name", person["full_name"], 520, 465, 37)
    _field(draw, runs, fields, "dob", person["dob"], 520, 625, 34)
    _field(draw, runs, fields, "id_number", person["id_number"], 520, 785, 34)
    _field(draw, runs, fields, "address_permanent", person["address_permanent"], 520, 945, 18)

    _text(draw, runs, 520, 1115, "SAMPLE SIGNATURE IMAGE", 21, "#52647b", True)
    draw.arc((520, 1170, 840, 1295), start=190, end=350, fill="#1e334b", width=6)
    draw.line((548, 1260, 603, 1206, 641, 1268, 697, 1196, 749, 1253, 812, 1218), fill="#1e334b", width=6)
    draw.line((520, 1320, 850, 1320), fill="#9ba9b7", width=2)
    draw.rounded_rectangle((155, 1400, 1085, 1470), radius=16, fill="#fff2d6")
    _text(draw, runs, 190, 1418, "SAMPLE ONLY - ALL PERSON AND IDENTIFIER DATA IS FICTIONAL", 22, "#875b12", True)
    return image, fields, runs


def _draw_application(
    applicant: dict[str, Any],
    guarantor: dict[str, Any],
    requested_amount: Decimal,
) -> tuple[Image.Image, list[dict[str, Any]], list[dict[str, Any]]]:
    image, draw, runs = _new_page()
    fields: list[dict[str, Any]] = []
    _text(draw, runs, 140, 105, "SAMPLE LOAN APPLICATION", 46, "#17496f", True)
    _text(draw, runs, 142, 172, "FICTIONAL TRAINING RECORD - NOT FOR SUBMISSION", 22, "#68798d", True)
    draw.line((140, 225, 1100, 225), fill="#17496f", width=4)

    _text(draw, runs, 145, 270, "APPLICANT", 26, "#17496f", True)
    _field(draw, runs, fields, "full_name", applicant["full_name"], 155, 350, 34)
    _field(draw, runs, fields, "dob", applicant["dob"], 155, 470, 31)
    _field(draw, runs, fields, "id_number", applicant["id_number"], 650, 470, 31)
    _field(draw, runs, fields, "address_permanent", applicant["address_permanent"], 155, 590, 27)
    _field(draw, runs, fields, "address_current", applicant["address_current"], 155, 700, 27)
    _field(draw, runs, fields, "requested_amount", f"SC {requested_amount:,.2f}", 155, 820, 34)

    draw.line((140, 900, 1100, 900), fill="#c6d0da", width=2)
    _text(draw, runs, 145, 940, "GUARANTOR", 26, "#17496f", True)
    _field(draw, runs, fields, "guarantor_full_name", guarantor["full_name"], 155, 1020, 34)
    _field(draw, runs, fields, "guarantor_id_number", guarantor["id_number"], 650, 1020, 31)

    _text(draw, runs, 155, 1160, "Applicant signature (sample placeholder)", 22, "#52647b")
    draw.line((155, 1265, 620, 1265), fill="#8292a3", width=2)
    _text(draw, runs, 155, 1310, "SAMPLE SIGNATURE - NOT VALID", 18, "#7b8795", True)
    draw.rounded_rectangle((140, 1450, 1100, 1530), radius=14, fill="#fff2d6")
    _text(draw, runs, 175, 1472, "SAMPLE ONLY - ALL PERSON AND FINANCIAL DATA IS FICTIONAL", 22, "#875b12", True)
    return image, fields, runs


def _make_transactions(seed: int) -> list[dict[str, Any]]:
    fake = Faker("en_US")
    fake.seed_instance(seed + 11)
    descriptions = [_ascii(fake.bs().title()) for _ in range(8)]
    amounts = [
        ("credit", Decimal("4200.00")),
        ("debit", Decimal("125.35")),
        ("debit", Decimal("82.40")),
        ("credit", Decimal("650.25")),
        ("debit", Decimal("305.50")),
        ("credit", Decimal("1175.00")),
        ("debit", Decimal("44.80")),
        ("credit", Decimal("900.00")),
    ]
    opening = Decimal("12500.00")
    balance = opening
    transactions = []
    first_date = date(2026, 10, 1)
    for index, (kind, amount) in enumerate(amounts):
        debit = amount if kind == "debit" else Decimal("0.00")
        credit = amount if kind == "credit" else Decimal("0.00")
        balance += credit - debit
        transactions.append(
            {
                "date": (first_date + timedelta(days=index * 3)).isoformat(),
                "description": descriptions[index],
                "debit": debit,
                "credit": credit,
                "balance": balance,
            }
        )
    return transactions


def _draw_statement(
    applicant: dict[str, Any],
    transactions: list[dict[str, Any]],
    opening: Decimal,
) -> tuple[Image.Image, list[dict[str, Any]], list[dict[str, Any]]]:
    image, draw, runs = _new_page()
    fields: list[dict[str, Any]] = []
    total_debits = sum((txn["debit"] for txn in transactions), Decimal("0.00"))
    total_credits = sum((txn["credit"] for txn in transactions), Decimal("0.00"))
    closing = opening + total_credits - total_debits

    _text(draw, runs, 125, 95, "SAMPLE FINANCIAL STATEMENT", 43, "#17496f", True)
    _text(draw, runs, 128, 158, "FICTIONAL INSTITUTION - SAMPLE CREDITS (SC)", 23, "#68798d", True)
    draw.line((125, 205, 1115, 205), fill="#17496f", width=4)
    _field(draw, runs, fields, "full_name", applicant["full_name"], 145, 275, 31)
    _field(draw, runs, fields, "account_number", "ACCT-SAMPLE-71Q4-0029", 145, 390, 30)
    _text(draw, runs, 665, 357, "STATEMENT PERIOD", 21, "#52647b", True)
    _text(draw, runs, 665, 390, "2026-10-01 to 2026-10-31", 27, "#132238")

    _text(draw, runs, 145, 465, "OPENING BALANCE (SC)", 21, "#52647b", True)
    _text(draw, runs, 145, 500, f"{opening:,.2f}", 30, "#132238", True)
    _text(draw, runs, 665, 465, "TOTAL CREDITS (SC)", 21, "#52647b", True)
    total_bbox = _text(draw, runs, 665, 500, f"{total_credits:,.2f}", 30, "#132238", True)
    fields.append(
        {
            "name": "statement_total",
            "value": f"{total_credits:,.2f}",
            "bbox": _normalized_bbox(total_bbox),
        }
    )

    headers = [("DATE", 145), ("DESCRIPTION", 315), ("DEBIT", 700), ("CREDIT", 850), ("BALANCE", 1000)]
    draw.rounded_rectangle((125, 570, 1115, 625), radius=9, fill="#17496f")
    for label, x in headers:
        _text(draw, runs, x, 585, label, 19, "#ffffff", True)

    for index, txn in enumerate(transactions):
        y = 638 + index * 62
        if index % 2 == 0:
            draw.rectangle((125, y - 5, 1115, y + 48), fill="#eef3f7")
        _text(draw, runs, 145, y, txn["date"], 17, "#26384c")
        _text(draw, runs, 315, y, txn["description"][:25], 17, "#26384c")
        debit_text = f"{txn['debit']:,.2f}" if txn["debit"] else "-"
        credit_text = f"{txn['credit']:,.2f}" if txn["credit"] else "-"
        _text(draw, runs, 700, y, debit_text, 17, "#26384c")
        _text(draw, runs, 850, y, credit_text, 17, "#26384c")
        _text(draw, runs, 1000, y, f"{txn['balance']:,.2f}", 17, "#26384c")
        amount_x = 700 if txn["debit"] else 850
        amount_value = f"{txn['debit']:,.2f}" if txn["debit"] else f"{txn['credit']:,.2f}"
        amount_bbox = draw.textbbox((amount_x, y), amount_value, font=_font(17))
        fields.append(
            {
                "name": "txn_amount",
                "value": amount_value,
                "bbox": _normalized_bbox(amount_bbox),
            }
        )

    _text(draw, runs, 145, 1170, "TOTAL DEBITS (SC)", 21, "#52647b", True)
    _text(draw, runs, 145, 1205, f"{total_debits:,.2f}", 30, "#132238", True)
    _text(draw, runs, 665, 1170, "CLOSING BALANCE (SC)", 21, "#52647b", True)
    closing_bbox = _text(draw, runs, 665, 1205, f"{closing:,.2f}", 30, "#132238", True)
    fields.append(
        {
            "name": "account_balance",
            "value": f"{closing:,.2f}",
            "bbox": _normalized_bbox(closing_bbox),
        }
    )
    _text(draw, runs, 145, 1305, "STATEMENT TOTAL IS THE SUM OF LISTED CREDITS.", 19, "#52647b")
    draw.rounded_rectangle((125, 1455, 1115, 1535), radius=14, fill="#fff2d6")
    _text(draw, runs, 160, 1480, "SAMPLE ONLY - NO REAL ACCOUNT OR FINANCIAL DATA", 22, "#875b12", True)
    return image, fields, runs


def _write_pdf(path: Path, image: Image.Image, runs: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    scale = 72 / DPI
    page_width = PAGE_WIDTH * scale
    page_height = PAGE_HEIGHT * scale
    pdf = Canvas(
        str(path),
        pagesize=(page_width, page_height),
        pageCompression=0,
        invariant=1,
    )
    pdf.setTitle("TraceDocs fictional sample")
    pdf.setAuthor("TraceDocs sample generator")
    pdf.drawImage(ImageReader(image), 0, 0, width=page_width, height=page_height)

    # Keep searchable text in the PDF while the matching page image remains the visible layer.
    pdf.saveState()
    pdf.setFillAlpha(0)
    for run in runs:
        font_size = run["size"] * scale
        text_y = page_height - (run["y"] + run["size"]) * scale
        pdf.setFont("Helvetica", font_size)
        pdf.drawString(run["x"] * scale, text_y, run["text"])
    pdf.restoreState()
    pdf.showPage()
    pdf.save()


def _rotated_bbox(
    bbox: list[float],
    angle: float,
) -> list[float]:
    x, y, width, height = bbox
    left = x * PAGE_WIDTH
    top = y * PAGE_HEIGHT
    right = (x + width) * PAGE_WIDTH
    bottom = (y + height) * PAGE_HEIGHT
    center_x = PAGE_WIDTH / 2
    center_y = PAGE_HEIGHT / 2
    radians = angle * 3.141592653589793 / 180
    cosine = math.cos(radians)
    sine = math.sin(radians)
    points = []
    for px, py in ((left, top), (right, top), (left, bottom), (right, bottom)):
        dx = px - center_x
        dy = py - center_y
        points.append((center_x + cosine * dx + sine * dy, center_y - sine * dx + cosine * dy))
    min_x = min(point[0] for point in points)
    max_x = max(point[0] for point in points)
    min_y = min(point[1] for point in points)
    max_y = max(point[1] for point in points)
    return _normalized_bbox(
        (
            round(min_x),
            round(min_y),
            round(max_x),
            round(max_y),
        )
    )


def _make_scan(image: Image.Image, seed: int, angle: float) -> Image.Image:
    rotated = image.rotate(
        angle,
        resample=Image.Resampling.BICUBIC,
        expand=False,
        fillcolor="#f4f4f2",
    )
    noise_rng = random.Random(seed)
    noise = Image.frombytes("L", (PAGE_WIDTH, PAGE_HEIGHT), noise_rng.randbytes(PAGE_WIDTH * PAGE_HEIGHT))
    noise = noise.convert("RGB")
    return Image.blend(rotated, noise, 0.025)


def _money(value: Decimal) -> str:
    return f"{value:,.2f}"


def generate(output_dir: Path) -> list[Path]:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    _json_write(output_dir / "persons.json", _make_persons())
    persons = json.loads((output_dir / "persons.json").read_text(encoding="utf-8"))
    applicant = persons["applicant"]
    guarantor = persons["guarantor"]
    requested_amount = Decimal("28400.00")
    opening = Decimal("12500.00")
    transactions = _make_transactions(SEED)

    document_specs = [
        (
            "D1-ID-001",
            "id_card",
            "id_card_001",
            *_draw_id_card(applicant),
            0.45,
            901,
        ),
        (
            "D1-APP-001",
            "application_form",
            "application_form_001",
            *_draw_application(applicant, guarantor, requested_amount),
            -0.35,
            902,
        ),
        (
            "D1-BANK-001",
            "bank_statement",
            "bank_statement_001",
            *_draw_statement(applicant, transactions, opening),
            0.25,
            903,
        ),
    ]

    manifest_files = []
    generated_paths = [output_dir / "persons.json"]
    for doc_id, doc_type, stem, image, fields, runs, angle, noise_seed in document_specs:
        if doc_type == "id_card":
            digital_path = output_dir / f"{stem}.png"
            scan_path = output_dir / f"{stem}_scan.jpg"
            digital_path.parent.mkdir(parents=True, exist_ok=True)
            image.save(digital_path, format="PNG", dpi=(DPI, DPI), optimize=False)
            digital_mime = "image/png"
        else:
            digital_path = output_dir / f"{stem}.pdf"
            scan_path = output_dir / f"{stem}_scan.jpg"
            _write_pdf(digital_path, image, runs)
            digital_mime = "application/pdf"

        scan = _make_scan(image, noise_seed, angle)
        scan.save(scan_path, format="JPEG", quality=83, subsampling=0, optimize=False, dpi=(DPI, DPI))
        generated_paths.extend((digital_path, scan_path))

        for variant, path, mime_type in (
            ("digital", digital_path, digital_mime),
            ("scan", scan_path, "image/jpeg"),
        ):
            manifest_fields = []
            for field in fields:
                field_bbox = field["bbox"]
                if variant == "scan":
                    field_bbox = _rotated_bbox(field_bbox, angle)
                manifest_fields.append(
                    {
                        "name": field["name"],
                        "value": field["value"],
                        "bbox": field_bbox,
                    }
                )
            manifest_files.append(
                {
                    "doc_id": doc_id,
                    "doc_type": doc_type,
                    "variant": variant,
                    "path": path.relative_to(output_dir).as_posix(),
                    "media_type": mime_type,
                    "page": 1,
                    "width_px": PAGE_WIDTH,
                    "height_px": PAGE_HEIGHT,
                    "dpi": DPI,
                    "fields": manifest_fields,
                }
            )

    closing = opening + sum((txn["credit"] for txn in transactions), Decimal("0.00")) - sum(
        (txn["debit"] for txn in transactions), Decimal("0.00")
    )
    manifest = {
        "schema_version": "1.0",
        "seed": SEED,
        "page": {"width_px": PAGE_WIDTH, "height_px": PAGE_HEIGHT, "dpi": DPI},
        "persons_file": "persons.json",
        "support_files": [{"path": "persons.json", "kind": "fictional_person_records"}],
        "files": manifest_files,
        "statement_arithmetic": {
            "doc_id": "D1-BANK-001",
            "opening_balance": _money(opening),
            "total_debits": _money(sum((txn["debit"] for txn in transactions), Decimal("0.00"))),
            "statement_total": _money(sum((txn["credit"] for txn in transactions), Decimal("0.00"))),
            "closing_balance": _money(closing),
            "transactions": [
                {
                    "date": txn["date"],
                    "description": txn["description"],
                    "debit": _money(txn["debit"]),
                    "credit": _money(txn["credit"]),
                    "balance": _money(txn["balance"]),
                }
                for txn in transactions
            ],
        },
    }
    _json_write(output_dir / "manifest.json", manifest)
    generated_paths.append(output_dir / "manifest.json")

    for file_record in manifest_files:
        if any(field["name"] not in FIELD_NAMES for field in file_record["fields"]):
            raise ValueError(f"Unexpected field name in {file_record['path']}")
    return generated_paths


def main() -> None:
    samples_dir = Path(__file__).resolve().parents[1]
    generate(samples_dir)


if __name__ == "__main__":
    main()
