import json
import re
from decimal import Decimal

from PIL import Image

from generate import FIELD_NAMES, PAGE_HEIGHT, PAGE_WIDTH, DPI, SEED, generate


def _read_manifest(root):
    return json.loads((root / "manifest.json").read_text(encoding="utf-8"))


def _amount(value):
    return Decimal(value.replace(",", ""))


def test_generation_is_byte_deterministic(tmp_path):
    first = tmp_path / "first"
    second = tmp_path / "second"
    generate(first)
    generate(second)

    first_files = {
        path.relative_to(first).as_posix(): path.read_bytes()
        for path in first.rglob("*")
        if path.is_file()
    }
    second_files = {
        path.relative_to(second).as_posix(): path.read_bytes()
        for path in second.rglob("*")
        if path.is_file()
    }
    assert first_files == second_files


def test_manifest_schema_and_generated_files(tmp_path):
    generate(tmp_path)
    manifest = _read_manifest(tmp_path)

    assert set(manifest) == {
        "schema_version",
        "seed",
        "page",
        "persons_file",
        "support_files",
        "files",
        "statement_arithmetic",
    }
    assert manifest["schema_version"] == "1.0"
    assert manifest["seed"] == SEED
    assert manifest["page"] == {
        "width_px": PAGE_WIDTH,
        "height_px": PAGE_HEIGHT,
        "dpi": DPI,
    }

    persons = json.loads((tmp_path / "persons.json").read_text(encoding="utf-8"))
    assert set(persons) == {"seed", "applicant", "guarantor"}
    assert persons["seed"] == SEED
    assert re.fullmatch(r"TDX-APP-\d{4}-[A-Z]{2}", persons["applicant"]["id_number"])
    assert re.fullmatch(r"TDX-GUA-\d{4}-[A-Z]{2}", persons["guarantor"]["id_number"])

    assert len(manifest["files"]) == 6
    assert len({record["path"] for record in manifest["files"]}) == 6
    observed_fields = set()
    for record in manifest["files"]:
        assert set(record) == {
            "doc_id",
            "doc_type",
            "variant",
            "path",
            "media_type",
            "page",
            "width_px",
            "height_px",
            "dpi",
            "fields",
        }
        assert (tmp_path / record["path"]).is_file()
        assert record["page"] == 1
        assert (record["width_px"], record["height_px"], record["dpi"]) == (
            PAGE_WIDTH,
            PAGE_HEIGHT,
            DPI,
        )
        for field in record["fields"]:
            assert set(field) == {"name", "value", "bbox"}
            assert field["name"] in FIELD_NAMES
            observed_fields.add(field["name"])

        if record["media_type"].startswith("image/"):
            with Image.open(tmp_path / record["path"]) as image:
                assert image.size == (PAGE_WIDTH, PAGE_HEIGHT)

    assert observed_fields == FIELD_NAMES
    assert manifest["support_files"] == [
        {"path": "persons.json", "kind": "fictional_person_records"}
    ]
    assert (tmp_path / manifest["persons_file"]).is_file()


def test_all_field_boxes_are_normalized_and_inside_page(tmp_path):
    generate(tmp_path)
    manifest = _read_manifest(tmp_path)

    for record in manifest["files"]:
        for field in record["fields"]:
            x, y, width, height = field["bbox"]
            assert all(isinstance(value, (int, float)) for value in field["bbox"])
            assert 0 <= x < 1
            assert 0 <= y < 1
            assert width > 0
            assert height > 0
            assert x + width <= 1
            assert y + height <= 1


def test_statement_arithmetic_and_manifest_fields(tmp_path):
    generate(tmp_path)
    manifest = _read_manifest(tmp_path)
    statement = manifest["statement_arithmetic"]
    opening = _amount(statement["opening_balance"])
    total_debits = _amount(statement["total_debits"])
    total_credits = _amount(statement["statement_total"])
    closing = _amount(statement["closing_balance"])

    running_balance = opening
    transaction_debits = Decimal("0.00")
    transaction_credits = Decimal("0.00")
    for transaction in statement["transactions"]:
        debit = _amount(transaction["debit"])
        credit = _amount(transaction["credit"])
        transaction_debits += debit
        transaction_credits += credit
        running_balance += credit - debit
        assert _amount(transaction["balance"]) == running_balance

    assert transaction_debits == total_debits
    assert transaction_credits == total_credits
    assert opening + total_credits - total_debits == closing

    statement_records = [
        record for record in manifest["files"] if record["doc_type"] == "bank_statement"
    ]
    assert len(statement_records) == 2
    for record in statement_records:
        fields = record["fields"]
        assert _amount(next(field["value"] for field in fields if field["name"] == "account_balance")) == closing
        assert _amount(next(field["value"] for field in fields if field["name"] == "statement_total")) == total_credits
        assert len([field for field in fields if field["name"] == "txn_amount"]) == len(
            statement["transactions"]
        )


def test_application_pdf_contains_searchable_text(tmp_path):
    generate(tmp_path)
    manifest = _read_manifest(tmp_path)
    pdf_record = next(
        record
        for record in manifest["files"]
        if record["doc_type"] == "application_form" and record["variant"] == "digital"
    )
    pdf_bytes = (tmp_path / pdf_record["path"]).read_bytes()
    applicant_name = json.loads((tmp_path / "persons.json").read_text(encoding="utf-8"))[
        "applicant"
    ]["full_name"]
    assert applicant_name.encode("ascii") in pdf_bytes
    assert b"APPLICATION" in pdf_bytes
    assert b"/MediaBox [ 0 0 595.2 841.92 ]" in pdf_bytes
