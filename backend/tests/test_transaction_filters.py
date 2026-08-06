"""Unit tests for shared transaction filter / company-float helpers."""

from types import SimpleNamespace
from uuid import uuid4

from app.services.transaction_filters import (
    deposit_counts_in_company_float,
    deposit_float_filter_clauses,
    expense_counts_in_company_float,
    expense_float_filter_clauses,
    merge_unique_ids,
    normalize_client_prop_codes,
)


def test_deposit_counts_in_company_float():
    assert deposit_counts_in_company_float(SimpleNamespace(is_rental_income=False))
    assert not deposit_counts_in_company_float(SimpleNamespace(is_rental_income=True))


def test_expense_counts_in_company_float():
    assert expense_counts_in_company_float(
        SimpleNamespace(paid_by_resident=False, paid_by_owner=False)
    )
    assert not expense_counts_in_company_float(
        SimpleNamespace(paid_by_resident=True, paid_by_owner=False)
    )
    assert not expense_counts_in_company_float(
        SimpleNamespace(paid_by_resident=False, paid_by_owner=True)
    )


def test_deposit_float_filter_default_and_override():
    default = deposit_float_filter_clauses()
    assert len(default) == 1
    include_all = deposit_float_filter_clauses(include_all=True)
    assert include_all == []
    explicit = deposit_float_filter_clauses(is_rental_income=True, include_all=True)
    assert len(explicit) == 1


def test_expense_float_filter_default_and_override():
    default = expense_float_filter_clauses()
    assert len(default) == 2
    include_all = expense_float_filter_clauses(include_all=True)
    assert include_all == []
    explicit = expense_float_filter_clauses(paid_by_resident=True, include_all=False)
    assert len(explicit) == 1


def test_normalize_client_prop_codes_dedupes():
    codes = normalize_client_prop_codes("c8", ["C8", " n160 ", "C8"])
    assert codes == ["C8", "N160"]


def test_merge_unique_ids():
    a, b = uuid4(), uuid4()
    assert merge_unique_ids(a, [b, a]) == [b, a]
    assert merge_unique_ids(None, None) == []
