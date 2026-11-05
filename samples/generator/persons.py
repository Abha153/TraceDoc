"""Build persons.json: the single source of fictional data for every sample.

All documents are rendered *from the file written here*, never from in-memory
values, so persons.json and the documents cannot drift apart.
"""
from __future__ import annotations

import random
import string
from datetime import date, timedelta
from decimal import Decimal

from .common import APPLICATION_DATE, STATEMENT_END, STATEMENT_START, money

BANK_NAME = "Northwind Sample Bank"

CREDITS = [
    ("Salary - Brightwave Logistics Ltd", 3200, 4800),
    ("Refund - Pinecrest Outfitters", 15, 90),
    ("Transfer in - ref 5521", 100, 600),
]
DEBITS = [
    ("Rent - Harbor View Apartments", 950, 1350),
    ("Groceries - Greenfield Market", 18, 140),
    ("Electricity - Metro Power Co", 45, 120),
    ("Mobile - ClearTalk Wireless", 25, 60),
    ("Coffee - Bean Counter Cafe", 3, 12),
    ("Fuel - Roadrunner Fuel Stop", 25, 70),
    ("Transfer to savings", 100, 400),
    ("ATM cash withdrawal", 20, 200),
    ("Streaming - Streamly Media", 8, 18),
    ("Pharmacy - Wellspring Chemist", 6, 40),
    ("Internet - FiberNest Broadband", 35, 60),
    ("Restaurant - Olive and Thyme", 22, 75),
]
N_TRANSACTIONS = 18
PURPOSES = ["Home improvement", "Vehicle purchase", "Education fees", "Debt consolidation"]
RELATIONSHIPS = ["Sibling", "Parent", "Employer", "Friend"]


def _address(fake) -> dict:
    for _ in range(100):
        street = fake.street_address()
        if len(street) <= 30:
            break
    return {"street": street, "city": fake.city(),
            "state": fake.state_abbr(), "postcode": fake.postcode()}


def _name(fake):
    for _ in range(100):
        given, surname = fake.first_name(), fake.last_name()
        if len(given) + len(surname) <= 22:
            return given, surname
    return given, surname


def _dob(rng: random.Random, lo: date, hi: date) -> str:
    return (lo + timedelta(days=rng.randint(0, (hi - lo).days))).isoformat()


def _person(fake, rng, pid, role, dob_range):
    given, surname = _name(fake)
    perm = _address(fake)
    cur = _address(fake)
    issue = date(2024, rng.randint(1, 12), rng.randint(1, 28))
    return {
        "person_id": pid,
        "role": role,
        "given_name": given,
        "surname": surname,
        "full_name": f"{given} {surname}",
        "date_of_birth": _dob(rng, *dob_range),
        "permanent_address": perm,
        "current_address": cur,
        "id_number": "SMP-{}-{}-{}".format(
            rng.randint(1000, 9999), rng.randint(1000, 9999),
            "".join(rng.choice(string.ascii_uppercase) for _ in range(2))),
        "id_issue_date": issue.isoformat(),
        "id_expiry_date": issue.replace(year=issue.year + 10).isoformat(),
        "signature_seed": rng.randint(1, 10**6),
    }


def _transactions(rng: random.Random, opening: Decimal):
    items = [("credit", *CREDITS[0], rng.randint(1, 3)),
             ("debit", *DEBITS[0], rng.randint(2, 5)),
             ("credit", *CREDITS[1], rng.randint(8, 24)),
             ("credit", *CREDITS[2], rng.randint(10, 26))]
    while len(items) < N_TRANSACTIONS:
        d = rng.choice(DEBITS[1:])
        items.append(("debit", *d, rng.randint(1, 28)))
    items.sort(key=lambda t: t[4])  # stable: by day
    bal, out = opening, []
    for kind, desc, lo, hi, day in items:
        amt = Decimal(rng.randint(lo * 100, hi * 100)) / 100
        if kind == "debit" and amt > bal:           # never overdraw
            amt = (bal * Decimal("0.3")).quantize(Decimal("0.01"))
        bal += amt if kind == "credit" else -amt
        out.append({
            "date": date.fromisoformat(STATEMENT_START).replace(day=day).isoformat(),
            "description": desc,
            "debit": money(amt) if kind == "debit" else None,
            "credit": money(amt) if kind == "credit" else None,
        })
    return out


def build_persons(seed: int) -> dict:
    from faker import Faker  # lazy: only needed when persons are rebuilt, not to render
    Faker.seed(seed)
    fake = Faker("en_US")
    return assemble(fake, random.Random(seed), seed, ("P001", "P002"), "samples/generator (D1-lite)")


def assemble(fake, rng, seed: int, ids, generator_label: str) -> dict:
    """Build the persons.json structure. `fake` only needs first_name/last_name/street_address/
    city/state_abbr/postcode, so Faker and persons_builtin.BuiltinFake are interchangeable."""
    pid_a, pid_g = ids
    applicant = _person(fake, rng, pid_a, "applicant", (date(1978, 1, 1), date(1996, 12, 31)))
    guarantor = _person(fake, rng, pid_g, "guarantor", (date(1965, 1, 1), date(1985, 12, 31)))
    opening = Decimal(rng.randint(150000, 450000)) / 100

    return {
        "_meta": {
            "fictional": True,
            "note": "All people, addresses, numbers and amounts are randomly generated "
                    "fictional data for software testing. Not real, not for real use.",
            "seed": seed,
            "generator": generator_label,
        },
        "persons": [applicant, guarantor],
        "loan_application": {
            "application_no": f"APP-2026-{rng.randint(100000, 999999)}",
            "application_date": APPLICATION_DATE,
            "applicant_id": pid_a,
            "guarantor_id": pid_g,
            "guarantor_relationship": rng.choice(RELATIONSHIPS),
            "requested_amount": money(Decimal(rng.randint(20, 80)) * 500),
            "currency": "USD",
            "purpose": rng.choice(PURPOSES),
            "term_months": rng.choice([12, 24, 36, 48]),
        },
        "bank_account": {
            "holder_id": pid_a,
            "bank_name": BANK_NAME,
            "account_number": f"NSB-{rng.randint(1000, 9999)}-{rng.randint(100000, 999999)}",
            "currency": "USD",
            "statement_period_start": STATEMENT_START,
            "statement_period_end": STATEMENT_END,
            "opening_balance": money(opening),
            "transactions": _transactions(rng, opening),
        },
    }
