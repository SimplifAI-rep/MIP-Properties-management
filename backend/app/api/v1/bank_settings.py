from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.admin_auth import require_admin
from app.models.bank_reconcile_session import BankReconcileSession
from app.models.cc_reconcile_session import CcReconcileSession
from app.schemas import (
    BankBalanceParseResponse,
    BankCutoverRequest,
    BankCutoverResponse,
    BankGapResponse,
    BankReconcileActionsRequest,
    BankReconcileSessionResponse,
    CcReconcileActionsRequest,
    CcReconcileSessionResponse,
    CompanyBankSettingsRead,
    CompanyBankSettingsUpdate,
    TransactionRead,
    VerificationTransactionsResponse,
    VerificationWorkspaceResponse,
)
from app.services import bank_reconcile as bank_reconcile_service
from app.services import bank_settings as bank_settings_service
from app.services import cc_reconcile as cc_reconcile_service
from app.services import verification_workspace as verification_workspace_service
from app.services.bank_reconcile_gap import parse_bank_statement_balance, sum_bank_scoped_nets

router = APIRouter(prefix="/bank-settings", tags=["bank-settings"])


def _to_read(db, *, bank_account_id=None) -> CompanyBankSettingsRead:
    payload = bank_settings_service.settings_read_payload(
        db, bank_account_id=bank_account_id
    )
    return CompanyBankSettingsRead(
        bank_account_id=payload["bank_account_id"],
        bank_account_label=payload["bank_account_label"],
        account_number=payload["account_number"],
        opening_balance=payload["opening_balance"],
        opening_balance_as_of=payload["opening_balance_as_of"],
        last_verification_date=payload["last_verification_date"],
        gap_tolerance_amount=payload["gap_tolerance_amount"],
        unverified_count=payload["unverified_count"],
    )


@router.get("", response_model=CompanyBankSettingsRead)
def get_bank_settings(
    bank_account_id: UUID | None = Query(default=None),
    db: Session = Depends(get_db),
) -> CompanyBankSettingsRead:
    return _to_read(db, bank_account_id=bank_account_id)


@router.patch("", response_model=CompanyBankSettingsRead)
def patch_bank_settings(
    payload: CompanyBankSettingsUpdate,
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> CompanyBankSettingsRead:
    try:
        account, _company = bank_settings_service.update_settings(
            db,
            bank_account_id=payload.bank_account_id,
            opening_balance=payload.opening_balance,
            opening_balance_as_of=payload.opening_balance_as_of,
            last_verification_date=payload.last_verification_date,
            gap_tolerance_amount=payload.gap_tolerance_amount,
            clear_opening_balance=payload.clear_opening_balance,
            clear_opening_balance_as_of=payload.clear_opening_balance_as_of,
            clear_last_verification_date=payload.clear_last_verification_date,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _to_read(
        db, bank_account_id=account.id if account else payload.bank_account_id
    )


@router.post("/cutover", response_model=BankCutoverResponse)
def go_live_cutover(
    payload: BankCutoverRequest,
    db: Session = Depends(get_db),
    _admin: str = Depends(require_admin),
) -> BankCutoverResponse:
    """Go-live: set opening balance + as-of, mark txs ≤ as-of Verified."""
    try:
        account, _company, deposits_marked, expenses_marked = (
            bank_settings_service.run_go_live_cutover(
                db,
                opening_balance=payload.opening_balance,
                as_of_date=payload.as_of_date,
                gap_tolerance_amount=payload.gap_tolerance_amount,
                bank_account_id=payload.bank_account_id,
            )
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return BankCutoverResponse(
        settings=_to_read(
            db, bank_account_id=account.id if account else payload.bank_account_id
        ),
        deposits_marked=deposits_marked,
        expenses_marked=expenses_marked,
    )


@router.get("/gap", response_model=BankGapResponse)
def get_bank_gap(
    bank_balance: Decimal | None = Query(default=None),
    date_to: date | None = Query(default=None),
    bank_account_id: UUID | None = Query(default=None),
    db: Session = Depends(get_db),
) -> BankGapResponse:
    """Gap = statement balance − (opening + net)."""
    payload = bank_settings_service.settings_read_payload(
        db, bank_account_id=bank_account_id
    )
    after = payload["opening_balance_as_of"] or payload["last_verification_date"]
    all_net, verified_net, all_dep, all_exp = sum_bank_scoped_nets(
        db, after_date=after, date_to=date_to
    )
    opening = payload["opening_balance"]
    tolerance = payload["gap_tolerance_amount"]

    gap_all = None
    gap_verified = None
    within = None
    if bank_balance is not None and opening is not None:
        gap_all = bank_balance - (opening + all_net)
        gap_verified = bank_balance - (opening + verified_net)
        within = abs(gap_verified) <= tolerance

    return BankGapResponse(
        opening_balance=opening,
        opening_balance_as_of=payload["opening_balance_as_of"],
        last_verification_date=payload["last_verification_date"],
        gap_tolerance_amount=tolerance,
        after_date=after,
        date_to=date_to,
        bank_balance=bank_balance,
        all_scoped_net=all_net,
        verified_net=verified_net,
        all_scoped_deposits=all_dep,
        all_scoped_expenses=all_exp,
        gap_all_scoped=gap_all,
        gap_verified=gap_verified,
        within_tolerance_verified=within,
    )


@router.post("/parse-bank-balance", response_model=BankBalanceParseResponse)
async def parse_bank_balance_upload(
    file: UploadFile = File(...),
) -> BankBalanceParseResponse:
    """Read latest row היתרה בש״ח from an uploaded bank Excel (does not import txs)."""
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    try:
        parsed = parse_bank_statement_balance(content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Could not parse bank Excel: {exc}"
        ) from exc
    return BankBalanceParseResponse(
        bank_balance=parsed["bank_balance"],
        statement_start_date=parsed.get("statement_start_date"),
        statement_end_date=parsed["statement_end_date"],
        movement_row_count=parsed["movement_row_count"],
    )


@router.post("/reconcile/sessions", response_model=BankReconcileSessionResponse)
async def create_reconcile_session(
    file: UploadFile = File(...),
    bank_account_id: UUID | None = Query(default=None),
    db: Session = Depends(get_db),
) -> BankReconcileSessionResponse:
    """Upload bank Excel and open a match/verify session for an operating account."""
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    try:
        session = bank_reconcile_service.create_session_from_upload(
            db,
            content=content,
            filename=file.filename,
            bank_account_id=bank_account_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Could not start reconcile: {exc}") from exc
    return BankReconcileSessionResponse(**bank_reconcile_service.session_summary(db, session))


@router.get("/reconcile/sessions/{session_id}", response_model=BankReconcileSessionResponse)
def get_reconcile_session(
    session_id: UUID,
    db: Session = Depends(get_db),
) -> BankReconcileSessionResponse:
    session = db.get(BankReconcileSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Reconcile session not found")
    return BankReconcileSessionResponse(**bank_reconcile_service.session_summary(db, session))


@router.post("/reconcile/sessions/{session_id}/actions", response_model=BankReconcileSessionResponse)
def apply_reconcile_actions(
    session_id: UUID,
    payload: BankReconcileActionsRequest,
    db: Session = Depends(get_db),
) -> BankReconcileSessionResponse:
    session = db.get(BankReconcileSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Reconcile session not found")
    try:
        session = bank_reconcile_service.apply_actions(
            db,
            session,
            [a.model_dump(exclude_none=True) for a in payload.actions],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return BankReconcileSessionResponse(**bank_reconcile_service.session_summary(db, session))


@router.post("/reconcile/sessions/{session_id}/complete", response_model=BankReconcileSessionResponse)
def complete_reconcile_session(
    session_id: UUID,
    db: Session = Depends(get_db),
) -> BankReconcileSessionResponse:
    session = db.get(BankReconcileSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Reconcile session not found")
    try:
        session = bank_reconcile_service.complete_session(db, session)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return BankReconcileSessionResponse(**bank_reconcile_service.session_summary(db, session))

@router.post("/cc-reconcile/sessions", response_model=CcReconcileSessionResponse)
async def create_cc_reconcile_session(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> CcReconcileSessionResponse:
    """Upload credit-card Excel and match paid-by-card expenses (does not mass-create)."""
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    try:
        session = cc_reconcile_service.create_session_from_upload(
            db, content=content, filename=file.filename
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"Could not start CC reconcile: {exc}"
        ) from exc
    return CcReconcileSessionResponse(**cc_reconcile_service.session_summary(db, session))


@router.get("/cc-reconcile/sessions/{session_id}", response_model=CcReconcileSessionResponse)
def get_cc_reconcile_session(
    session_id: UUID,
    db: Session = Depends(get_db),
) -> CcReconcileSessionResponse:
    session = db.get(CcReconcileSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="CC reconcile session not found")
    return CcReconcileSessionResponse(**cc_reconcile_service.session_summary(db, session))


@router.post(
    "/cc-reconcile/sessions/{session_id}/actions",
    response_model=CcReconcileSessionResponse,
)
def apply_cc_reconcile_actions(
    session_id: UUID,
    payload: CcReconcileActionsRequest,
    db: Session = Depends(get_db),
) -> CcReconcileSessionResponse:
    session = db.get(CcReconcileSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="CC reconcile session not found")
    try:
        session = cc_reconcile_service.apply_actions(
            db,
            session,
            [a.model_dump(exclude_none=True) for a in payload.actions],
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return CcReconcileSessionResponse(**cc_reconcile_service.session_summary(db, session))


@router.post(
    "/cc-reconcile/sessions/{session_id}/complete",
    response_model=CcReconcileSessionResponse,
)
def complete_cc_reconcile_session(
    session_id: UUID,
    db: Session = Depends(get_db),
) -> CcReconcileSessionResponse:
    session = db.get(CcReconcileSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="CC reconcile session not found")
    try:
        session = cc_reconcile_service.complete_session(db, session)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return CcReconcileSessionResponse(**cc_reconcile_service.session_summary(db, session))

@router.get("/verification-workspace", response_model=VerificationWorkspaceResponse)
def get_verification_workspace(db: Session = Depends(get_db)) -> VerificationWorkspaceResponse:
    """Bank period accordion groups + CC accumulate pool summary."""
    return VerificationWorkspaceResponse(**verification_workspace_service.verification_workspace(db))


@router.get(
    "/verification-groups/{group_id}/transactions",
    response_model=VerificationTransactionsResponse,
)
def get_verification_group_transactions(
    group_id: str,
    db: Session = Depends(get_db),
    limit: int = Query(200, ge=1, le=500),
) -> VerificationTransactionsResponse:
    try:
        items, total = verification_workspace_service.get_bank_group_transactions(
            db, group_id, limit=limit
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return VerificationTransactionsResponse(
        items=[TransactionRead.model_validate(item) for item in items],
        total=total,
    )


@router.get("/cc-pool/transactions", response_model=VerificationTransactionsResponse)
def get_cc_pool_transactions(
    status: str = Query("pending", pattern="^(pending|cc_verified)$"),
    db: Session = Depends(get_db),
    limit: int = Query(200, ge=1, le=500),
) -> VerificationTransactionsResponse:
    """Accumulating CC pool. Bank-confirmed merchants live under bank groups."""
    try:
        items, total = verification_workspace_service.get_cc_pool_transactions(
            db, status=status, limit=limit
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return VerificationTransactionsResponse(
        items=[TransactionRead.model_validate(item) for item in items],
        total=total,
    )
