"""Fictional loan application form + bank statement as searchable PDFs (ReportLab)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas

from .common import field, fmt_address, money, money_text
from .signature import place, signature_strokes

W, H = letter  # 612 x 792 pt
M = 54         # page margin

BLACK = (0.06, 0.06, 0.06)
GREY = (0.40, 0.42, 0.45)
RULE = (0.75, 0.77, 0.80)
RED = (0.67, 0.10, 0.10)
SIG = (0.08, 0.12, 0.47)


class Page:
    """Thin wrapper: top-left coordinates, records a tight bbox for every named text."""

    def __init__(self, path: Path, title: str):
        self.c = canvas.Canvas(str(path), pagesize=letter, invariant=1, pageCompression=1)
        self.c.setTitle(title)
        self.c.setAuthor("TraceDocs sample generator")
        self.c.setSubject("Fictional SAMPLE document - test data only")
        self.fields: list = []

    def text(self, x, y, s, font="Helvetica", size=10, color=BLACK, align="left",
             name=None, ftype="text", value=None, pad=1.0):
        w = pdfmetrics.stringWidth(s, font, size)
        if align == "right":
            x -= w
        self.c.setFont(font, size)
        self.c.setFillColorRGB(*color)
        self.c.drawString(x, H - y, s)
        if name:
            asc = pdfmetrics.getAscent(font, size)
            desc = pdfmetrics.getDescent(font, size)  # negative
            self.fields.append(field(
                name, ftype, s, s if value is None else value,
                (x - pad, y - asc - pad, x + w + pad, y - desc + pad)))
        return w

    def rect(self, x0, y0, x1, y1, fill=None, stroke=None, lw=0.8):
        c = self.c
        if fill:
            c.setFillColorRGB(*fill)
        if stroke:
            c.setStrokeColorRGB(*stroke)
        c.setLineWidth(lw)
        c.rect(x0, H - y1, x1 - x0, y1 - y0, fill=1 if fill else 0, stroke=1 if stroke else 0)

    def line(self, x0, y0, x1, y1, color=RULE, lw=0.6):
        self.c.setStrokeColorRGB(*color)
        self.c.setLineWidth(lw)
        self.c.line(x0, H - y0, x1, H - y1)

    def signature(self, seed, rect, name):
        lw = 1.4
        c = self.c
        c.setStrokeColorRGB(*SIG)
        c.setLineWidth(lw)
        c.setLineCap(1)
        c.setLineJoin(1)
        for stroke in place(signature_strokes(seed), rect):
            p = c.beginPath()
            p.moveTo(stroke[0][0], H - stroke[0][1])
            for x, y in stroke[1:]:
                p.lineTo(x, H - y)
            c.drawPath(p, stroke=1, fill=0)
        h = lw / 2
        self.fields.append(field(name, "signature", None, None,
                                 (rect[0] - h, rect[1] - h, rect[2] + h, rect[3] + h)))

    def banner(self, text):
        self.rect(0, 0, W, 30, fill=(0.99, 0.92, 0.92))
        self.text(M, 19, text, "Helvetica-Bold", 10, RED, name="sample_marker", ftype="marker")

    def save(self):
        self.c.showPage()
        self.c.save()
        return self.fields, (W, H)


# --------------------------------------------------------------------------- form
def render_application(persons: dict, out_path: Path):
    by_id = {p["person_id"]: p for p in persons["persons"]}
    app = persons["loan_application"]
    a, g = by_id[app["applicant_id"]], by_id[app["guarantor_id"]]
    pg = Page(out_path, "SAMPLE Personal Loan Application (fictional)")

    pg.banner("SAMPLE DOCUMENT - FICTIONAL DATA - NOT A REAL APPLICATION")
    pg.text(M, 70, "Personal Loan Application", "Helvetica-Bold", 20)
    pg.text(M, 88, "Northwind Sample Bank - Retail Lending (fictional)", "Helvetica", 10, GREY)
    pg.text(W - M, 62, "Application No.", "Helvetica", 7.5, GREY, align="right")
    pg.text(W - M, 76, app["application_no"], "Helvetica-Bold", 11, align="right", name="application_number", ftype="identifier")
    pg.text(W - M, 92, "Date", "Helvetica", 7.5, GREY, align="right")
    pg.text(W - M, 106, app["application_date"], "Helvetica-Bold", 11, align="right", name="application_date", ftype="date")

    def section(y, title):
        pg.text(M, y, title, "Helvetica-Bold", 11)
        pg.line(M, y + 5, W - M, y + 5, color=(0.35, 0.37, 0.40), lw=0.8)

    def entry(label, text, x, y, w, name, ftype="text", value=None):
        pg.text(x, y + 8, label, "Helvetica", 7.5, GREY)
        pg.text(x, y + 23, text, "Helvetica", 11, name=name, ftype=ftype, value=value)
        pg.line(x, y + 29, x + w, y + 29)

    section(138, "1. Applicant details")
    entry("Full name", a["full_name"], M, 150, 180, "full_name")
    entry("ID number", a["id_number"], 232, 150, 130, "id_number", "identifier")
    entry("Date of birth (YYYY-MM-DD)", a["date_of_birth"], 372, 150, 186, "date_of_birth", "date")
    entry("Permanent address", fmt_address(a["permanent_address"]), M, 194, 504, "permanent_address")
    entry("Current address", fmt_address(a["current_address"]), M, 238, 504, "current_address")

    section(298, "2. Loan request")
    entry("Requested loan amount", f"{app['currency']} {money_text(Decimal(app['requested_amount']))}",
          M, 310, 200, "requested_loan_amount", "money", app["requested_amount"])
    entry("Term", f"{app['term_months']} months", 270, 310, 120, "loan_term_months", "integer", str(app["term_months"]))
    entry("Purpose", app["purpose"], 408, 310, 150, "loan_purpose")

    section(368, "3. Guarantor")
    entry("Guarantor full name", g["full_name"], M, 380, 180, "guarantor_full_name")
    entry("Guarantor ID number", g["id_number"], 232, 380, 130, "guarantor_id_number", "identifier")
    entry("Date of birth (YYYY-MM-DD)", g["date_of_birth"], 372, 380, 186, "guarantor_date_of_birth", "date")
    entry("Relationship to applicant", app["guarantor_relationship"], M, 424, 200, "guarantor_relationship")

    section(486, "4. Declaration and signatures")
    pg.text(M, 506, "I declare that the information given above is true and complete.", "Helvetica", 8.5)
    pg.text(M, 518, "This is a SAMPLE form containing fictional data, created only to test document-analysis software.",
            "Helvetica", 8.5)

    for who, x0, name in ((a, M, "applicant"), (g, 322, "guarantor")):
        pg.signature(who["signature_seed"], (x0 + 8, 540, x0 + 226, 584), f"{name}_signature")
        pg.line(x0, 592, x0 + 236, 592, color=GREY, lw=0.8)
        pg.text(x0, 604, f"{name.capitalize()} signature", "Helvetica", 7.5, GREY)
        pg.text(x0, 626, "Date:", "Helvetica", 9, GREY)
        pg.text(x0 + 32, 626, app["application_date"], "Helvetica", 9, name=f"{name}_signature_date", ftype="date")

    pg.text(M, 760, "SAMPLE - generated for OCR / forensics testing. All names, numbers and amounts are fictional.",
            "Helvetica", 7.5, GREY)
    return pg.save()


# ------------------------------------------------------------------------ statement
def compute_statement(acct: dict) -> dict:
    """Running balances + totals, all Decimal (single place for the arithmetic)."""
    bal = Decimal(acct["opening_balance"])
    td = tc = Decimal("0.00")
    rows = []
    for t in acct["transactions"]:
        deb = Decimal(t["debit"]) if t["debit"] else None
        cre = Decimal(t["credit"]) if t["credit"] else None
        if deb:
            bal -= deb
            td += deb
        if cre:
            bal += cre
            tc += cre
        rows.append({**t, "debit_d": deb, "credit_d": cre, "balance_d": bal})
    return {"rows": rows, "total_debits": td, "total_credits": tc, "closing": bal}


def _dmy(iso: str) -> str:
    return f"{date.fromisoformat(iso):%d %b %Y}"


def render_statement(persons: dict, out_path: Path, printed: dict | None = None):
    by_id = {p["person_id"]: p for p in persons["persons"]}
    acct = persons["bank_account"]
    holder = by_id[acct["holder_id"]]
    st = compute_statement(acct)
    if printed:  # D3 S7 only: print a total that does NOT match the listed transactions (arithmetic error)
        st = {**st, **{k: Decimal(v) for k, v in printed.items()}}
    pg = Page(out_path, "SAMPLE Account Statement (fictional)")

    pg.banner("SAMPLE DOCUMENT - FICTIONAL DATA - NOT A REAL STATEMENT")
    pg.text(M, 62, acct["bank_name"], "Helvetica-Bold", 18)
    pg.text(M, 80, "Account Statement", "Helvetica", 12, GREY)

    def lab_val(label, y, text, name, ftype="text", value=None):
        pg.text(M, y, label, "Helvetica", 7.5, GREY)
        pg.text(M, y + 14, text, "Helvetica-Bold", 11, name=name, ftype=ftype, value=value)

    lab_val("Account holder", 110, holder["full_name"], "account_holder")
    lab_val("Address", 142, fmt_address(holder["current_address"]), "account_holder_address")
    lab_val("Account number", 174, acct["account_number"], "account_number", "identifier")
    period = f"{_dmy(acct['statement_period_start'])} - {_dmy(acct['statement_period_end'])}"
    lab_val("Statement period", 206, period, "statement_period", "date_range",
            f"{acct['statement_period_start']}/{acct['statement_period_end']}")

    # summary box
    pg.rect(350, 98, W - M, 232, stroke=RULE)
    pg.text(360, 114, "Account summary", "Helvetica-Bold", 9)
    right = W - M - 10
    for label, y, val, name in (("Opening balance", 142, Decimal(acct["opening_balance"]), "opening_balance"),
                                ("Total debits", 162, st["total_debits"], "total_debits"),
                                ("Total credits", 182, st["total_credits"], "total_credits")):
        pg.text(360, y, label, "Helvetica", 9)
        pg.text(right, y, money_text(val), "Helvetica", 9, align="right", name=name, ftype="money", value=money(val))
    pg.line(360, 194, right, 194, color=GREY)
    pg.text(360, 211, "Closing balance", "Helvetica-Bold", 9)
    pg.text(right, 211, money_text(st["closing"]), "Helvetica-Bold", 9, align="right",
            name="closing_balance", ftype="money", value=money(st["closing"]))

    # table
    cols = {"date": M + 6, "desc": 130, "debit": 400, "credit": 470, "bal": W - M - 6}
    pg.rect(M, 252, W - M, 270, fill=(0.92, 0.93, 0.95))
    pg.text(cols["date"], 264, "Date", "Helvetica-Bold", 8.5)
    pg.text(cols["desc"], 264, "Description", "Helvetica-Bold", 8.5)
    pg.text(cols["debit"], 264, "Debit", "Helvetica-Bold", 8.5, align="right")
    pg.text(cols["credit"], 264, "Credit", "Helvetica-Bold", 8.5, align="right")
    pg.text(cols["bal"], 264, "Balance", "Helvetica-Bold", 8.5, align="right")

    y = 286
    for i, r in enumerate(st["rows"], start=1):
        pg.text(cols["date"], y, _dmy(r["date"]), "Helvetica", 8.5, name=f"transaction_{i:02d}_date",
                ftype="date", value=r["date"])
        pg.text(cols["desc"], y, r["description"], "Helvetica", 8.5, name=f"transaction_{i:02d}_description")
        if r["debit_d"] is not None:
            pg.text(cols["debit"], y, money_text(r["debit_d"]), "Helvetica", 8.5, align="right",
                    name=f"transaction_{i:02d}_debit", ftype="money", value=money(r["debit_d"]))
        if r["credit_d"] is not None:
            pg.text(cols["credit"], y, money_text(r["credit_d"]), "Helvetica", 8.5, align="right",
                    name=f"transaction_{i:02d}_credit", ftype="money", value=money(r["credit_d"]))
        pg.text(cols["bal"], y, money_text(r["balance_d"]), "Helvetica", 8.5, align="right",
                name=f"transaction_{i:02d}_balance", ftype="money", value=money(r["balance_d"]))
        pg.line(M, y + 4.5, W - M, y + 4.5, color=(0.88, 0.89, 0.91), lw=0.5)
        y += 17

    pg.line(M, y - 11, W - M, y - 11, color=GREY, lw=1.0)
    ty = y + 6
    pg.text(cols["date"], ty, "Totals / closing balance", "Helvetica-Bold", 8.5)
    pg.text(cols["debit"], ty, money_text(st["total_debits"]), "Helvetica-Bold", 8.5, align="right",
            name="table_total_debits", ftype="money", value=money(st["total_debits"]))
    pg.text(cols["credit"], ty, money_text(st["total_credits"]), "Helvetica-Bold", 8.5, align="right",
            name="table_total_credits", ftype="money", value=money(st["total_credits"]))
    pg.text(cols["bal"], ty, money_text(st["closing"]), "Helvetica-Bold", 8.5, align="right",
            name="table_closing_balance", ftype="money", value=money(st["closing"]))

    pg.text(M, 740, "SAMPLE - generated for OCR / forensics testing. All names, numbers and amounts are fictional.",
            "Helvetica", 7.5, GREY)
    return pg.save()
