from uuid import uuid4

from app.services.source_file import resolve_source_file


def test_receipt_does_not_replace_bank_verification_file():
    receipt_id = str(uuid4())
    assert (
        resolve_source_file(
            source_file="July bank.xlsx",
            receipt_ref=receipt_id,
            source="bank_statement",
            upload_names={receipt_id: "image.png"},
        )
        == "July bank.xlsx"
    )
    assert (
        resolve_source_file(
            source_file=None,
            receipt_ref=receipt_id,
            source="bank_statement",
            upload_names={receipt_id: "image.png"},
        )
        == "Bank Account example.xlsx"
    )


def test_receipt_does_not_replace_credit_card_file():
    receipt_id = str(uuid4())
    assert (
        resolve_source_file(
            source_file=None,
            receipt_ref=receipt_id,
            source="credit_card",
            upload_names={receipt_id: "photo.jpg"},
        )
        == "credit card statement.xlsx"
    )


def test_file_upload_still_uses_receipt_when_filename_was_not_stored():
    receipt_id = str(uuid4())
    assert (
        resolve_source_file(
            source_file=None,
            receipt_ref=receipt_id,
            source="file_upload",
            upload_names={receipt_id: "invoice.pdf"},
        )
        == "invoice.pdf"
    )


def test_import_batch_wins_over_receipt():
    receipt_id = str(uuid4())
    batch_id = uuid4()
    assert (
        resolve_source_file(
            source_file=None,
            receipt_ref=receipt_id,
            import_batch_id=batch_id,
            source="excel_import",
            upload_names={receipt_id: "image.png"},
            batch_names={str(batch_id): "deposits.xlsx"},
        )
        == "deposits.xlsx"
    )
