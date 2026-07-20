from datetime import date, datetime

from app.services.client_import import _parse_date


def test_parse_date_accepts_normal_dates():
    assert _parse_date("15.03.2024") == date(2024, 3, 15)
    assert _parse_date("2024-07-01") == date(2024, 7, 1)
    assert _parse_date(datetime(2026, 1, 28)) == date(2026, 1, 28)


def test_parse_date_rejects_excel_serial_and_1900():
    assert _parse_date(28) is None
    assert _parse_date(30.0) is None
    assert _parse_date(date(1900, 1, 28)) is None
    assert _parse_date(datetime(1900, 1, 30)) is None
    assert _parse_date("1900-01-28") is None
