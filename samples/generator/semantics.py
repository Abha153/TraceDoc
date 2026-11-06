"""Ground-truth labels per manifest field: which semantic type it is and whose it is.

semantic_type values follow ARCHITECTURE.md (dob, full_name, id_number, address_permanent,
address_current, requested_amount, account_balance, account_number, statement_total, ...) so the
extractor (O4), assertion builder (B4) and the scenario/ground-truth files can share one vocabulary.
true_person_id / true_entity_role are GROUND TRUTH for tests, not what an analyzer would infer.
"""
from __future__ import annotations

import re

SEMANTIC = {
    "id_card": {
        "sample_marker": "marker", "photo": "photo", "signature": "signature",
        "full_name": "full_name", "date_of_birth": "dob", "id_number": "id_number",
        "permanent_address": "address_permanent",
        "issue_date": "document_issue_date", "expiry_date": "document_expiry_date",
    },
    "loan_application": {
        "sample_marker": "marker", "application_number": "application_number",
        "application_date": "document_date", "full_name": "full_name", "date_of_birth": "dob",
        "id_number": "id_number", "guarantor_id_number": "id_number",
        "permanent_address": "address_permanent", "current_address": "address_current",
        "requested_loan_amount": "requested_amount", "loan_term_months": "loan_term_months",
        "loan_purpose": "loan_purpose", "guarantor_full_name": "full_name",
        "guarantor_date_of_birth": "dob", "guarantor_relationship": "guarantor_relationship",
        "applicant_signature": "signature", "guarantor_signature": "signature",
        "applicant_signature_date": "signature_date", "guarantor_signature_date": "signature_date",
    },
    "bank_statement": {
        "sample_marker": "marker", "account_holder": "full_name",
        "account_holder_address": "address_current", "account_number": "account_number",
        "statement_period": "statement_period",
        "opening_balance": "account_balance", "closing_balance": "account_balance",
        "table_closing_balance": "account_balance",
        "total_debits": "statement_total", "total_credits": "statement_total",
        "table_total_debits": "statement_total", "table_total_credits": "statement_total",
    },
}
DETAIL = {"opening_balance": "opening", "closing_balance": "closing", "table_closing_balance": "closing",
          "total_debits": "debits", "table_total_debits": "debits",
          "total_credits": "credits", "table_total_credits": "credits"}
NO_PERSON = {"marker", "application_number", "document_date", "loan_term_months", "loan_purpose",
             "statement_period", "transaction_date",
             "transaction_description", "transaction_debit", "transaction_credit",
             "running_balance", "statement_total", "account_balance", "account_number"}
_TXN = re.compile(r"^transaction_\d+_(date|description|debit|credit|balance)$")
_TXN_TYPE = {"date": "transaction_date", "description": "transaction_description",
             "debit": "transaction_debit", "credit": "transaction_credit", "balance": "running_balance"}


def annotate(doc_type: str, name: str, applicant_id: str, guarantor_id: str) -> dict:
    m = _TXN.match(name)
    sem = _TXN_TYPE[m.group(1)] if m else SEMANTIC[doc_type][name]   # KeyError = unlabelled field
    out = {"semantic_type": sem}
    if name in DETAIL:
        out["semantic_detail"] = DETAIL[name]
    if sem in NO_PERSON and not (doc_type == "bank_statement" and sem == "full_name"):
        out["true_person_id"], out["true_entity_role"] = None, None
    elif name.startswith("guarantor_"):
        out["true_person_id"], out["true_entity_role"] = guarantor_id, "guarantor"
    elif doc_type == "bank_statement":
        out["true_person_id"], out["true_entity_role"] = applicant_id, "account_holder"
    else:
        out["true_person_id"], out["true_entity_role"] = applicant_id, "applicant"
    return out
