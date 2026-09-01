"""Verification tab workspace: bank period groups + accumulating CC pool."""

from __future__ import annotations

from datetime import date
from uuid import UUID

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, joinedload

from app.models.bank_reconcile_session import BankReconcileSession
from app.models.cc_reconcile_session import CcReconcileSession
from app.models.cc_settlement_group import CcSettlementGroup
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.property import Property
from app.services.bank_settings import get_or_create_settings
from app.services.deposit_query import deposit_to_read
from app.services.expense_query import expense_to_read
from app.services.source_file import load_batch_filenames, load_upload_filenames
from app.services.transaction_filters import (
    deposit_company_float_clause,
    expense_company_float_clauses,
)
from app.services.transaction_view import (
    deposit_dict_to_transaction,
    expense_dict_to_transaction,
)

def _session_linked_ids(session: BankReconcileSession) -> tuple[set[UUID], set[UUID], set[UUID]]:
    deposits: set[UUID] = set()
    expenses: set[UUID] = set()
    settlements: set[UUID] = set()
    for line in session.lines_json or []:
        status = line.get("status")
        if status in ("matched", "added") and line.get("proposed_tx_id"):
            kind = line.get("proposed_kind")
            try:
                uid = UUID(str(line["proposed_tx_id"]))
            except (TypeError, ValueError):
                continue
            if kind == "deposit":
                deposits.add(uid)
            else:
                expenses.add(uid)
        if status == "settled":
            gid = line.get("settlement_group_id")
            if gid:
                try:
                    settlements.add(UUID(str(gid)))
                except (TypeError, ValueError):
                    pass
            for mid in line.get("proposed_member_ids") or []:
                try:
                    expenses.add(UUID(str(mid)))
                except (TypeError, ValueError):
                    continue
    return deposits, expenses, settlements


def _open_period_filters(
    *, date_from: date | None, date_to: date | None
) -> tuple[list, list]:
    """Unverified bank-scoped txs inside an uploaded statement window."""
    dep = [
        deposit_company_float_clause(),
        Deposit.bank_reconcile_exclude.is_(False),
        Deposit.bank_verified_at.is_(None),
        Deposit.transaction_date.is_not(None),
    ]
    exp = [
        *expense_company_float_clauses(),
        Expense.bank_reconcile_exclude.is_(False),
        Expense.bank_verified_at.is_(None),
        Expense.payment_method != "credit_card",
        Expense.transaction_date.is_not(None),
    ]
    if date_from is not None:
        dep.append(Deposit.transaction_date >= date_from)
        exp.append(Expense.transaction_date >= date_from)
    if date_to is not None:
        dep.append(Deposit.transaction_date <= date_to)
        exp.append(Expense.transaction_date <= date_to)
    return dep, exp


def _count_open_bank_scoped(
    db: Session, *, date_from: date | None, date_to: date | None
) -> int:
    if date_from is None or date_to is None:
        return 0
    dep, exp = _open_period_filters(date_from=date_from, date_to=date_to)
    d = db.scalar(select(func.count()).select_from(Deposit).where(and_(*dep))) or 0
    e = db.scalar(select(func.count()).select_from(Expense).where(and_(*exp))) or 0
    return int(d) + int(e)


def list_bank_groups(db: Session) -> list[dict]:
    settings = get_or_create_settings(db)
    after = settings.last_verification_date
    groups: list[dict] = []

    open_session = db.scalars(
        select(BankReconcileSession)
        .where(BankReconcileSession.status == "in_progress")
        .order_by(BankReconcileSession.created_at.desc())
        .limit(1)
    ).first()

    start = open_session.statement_start_date if open_session else None
    end = open_session.statement_end_date if open_session else None

    groups.append(
        {
            "id": "bank-open",
            "kind": "bank",
            "status": "unverified",
            "title": "Open period (unverified)",
            "date": None,
            "statement_start_date": start.isoformat() if start else None,
            "statement_end_date": end.isoformat() if end else None,
            "after_date": after.isoformat() if after else None,
            "session_id": str(open_session.id) if open_session else None,
            "filename": open_session.filename if open_session else None,
            "transaction_count": _count_open_bank_scoped(
                db, date_from=start, date_to=end
            ),
            "settlement_count": 0,
        }
    )

    completed = db.scalars(
        select(BankReconcileSession)
        .where(BankReconcileSession.status == "completed")
        .order_by(
            BankReconcileSession.statement_end_date.desc().nullslast(),
            BankReconcileSession.created_at.desc(),
        )
    ).all()

    for session in completed:
        dep_ids, exp_ids, settle_ids = _session_linked_ids(session)
        end = session.statement_end_date
        groups.append(
            {
                "id": f"bank-session:{session.id}",
                "kind": "bank",
                "status": "verified",
                "title": f"Verified through {end.isoformat()}" if end else "Verified period",
                "date": end.isoformat() if end else None,
                "statement_start_date": session.statement_start_date.isoformat()
                if session.statement_start_date
                else None,
                "statement_end_date": end.isoformat() if end else None,
                "after_date": session.after_date.isoformat() if session.after_date else None,
                "session_id": str(session.id),
                "filename": session.filename,
                "transaction_count": len(dep_ids) + len(exp_ids),
                "settlement_count": len(settle_ids),
            }
        )

    return groups


def _rows_to_transactions(
    db: Session, *, deposits: list[Deposit], expenses: list[Expense]
) -> list[dict]:
    upload_names = load_upload_filenames(
        db,
        [d.receipt_ref for d in deposits] + [e.receipt_ref for e in expenses],
    )
    batch_names = load_batch_filenames(db, [d.import_batch_id for d in deposits])
    out: list[dict] = []
    for row in deposits:
        prop = row.property
        owner = prop.owner if prop else None
        account_number = row.bank_account.account_number if row.bank_account else None
        read = deposit_to_read(
            row,
            prop.name if prop else "",
            owner.name if owner else "",
            account_number,
            prop.client_prop_id if prop else "",
            upload_names=upload_names,
            batch_names=batch_names,
        )
        out.append(deposit_dict_to_transaction(read.model_dump(mode="json")))
    for row in expenses:
        prop = row.property
        owner = prop.owner if prop else None
        read = expense_to_read(
            row,
            prop.name if prop else "",
            owner.name if owner else "",
            prop.client_prop_id if prop else "",
            upload_names=upload_names,
        )
        out.append(expense_dict_to_transaction(read.model_dump(mode="json")))
    out.sort(
        key=lambda r: (
            r.get("transaction_date") or "",
            r.get("kind") or "",
            r.get("transaction_ref") or "",
        ),
        reverse=True,
    )
    return out


DEFAULT_TX_LIMIT = 200


def get_bank_group_transactions(
    db: Session, group_id: str, *, limit: int = DEFAULT_TX_LIMIT
) -> tuple[list[dict], int]:
    limit = max(1, min(int(limit), 500))
    if group_id == "bank-open":
        open_session = db.scalars(
            select(BankReconcileSession)
            .where(BankReconcileSession.status == "in_progress")
            .order_by(BankReconcileSession.created_at.desc())
            .limit(1)
        ).first()
        if (
            open_session is None
            or open_session.statement_start_date is None
            or open_session.statement_end_date is None
        ):
            # No uploaded Excel window yet — do not dump historical unverified txs.
            return [], 0
        date_from = open_session.statement_start_date
        date_to = open_session.statement_end_date
        dep_f, exp_f = _open_period_filters(date_from=date_from, date_to=date_to)
        dep_total = (
            db.scalar(select(func.count()).select_from(Deposit).where(and_(*dep_f))) or 0
        )
        exp_total = (
            db.scalar(select(func.count()).select_from(Expense).where(and_(*exp_f))) or 0
        )
        total = int(dep_total) + int(exp_total)
        deposits = list(
            db.scalars(
                select(Deposit)
                .options(
                    joinedload(Deposit.property).joinedload(Property.owner),
                    joinedload(Deposit.bank_account),
                )
                .where(and_(*dep_f))
                .order_by(Deposit.transaction_date.desc().nullslast())
                .limit(limit)
            ).unique()
        )
        expenses = list(
            db.scalars(
                select(Expense)
                .options(joinedload(Expense.property).joinedload(Property.owner))
                .where(and_(*exp_f))
                .order_by(Expense.transaction_date.desc().nullslast())
                .limit(limit)
            ).unique()
        )
        rows = _rows_to_transactions(db, deposits=deposits, expenses=expenses)[:limit]
        return rows, total

    if group_id.startswith("bank-session:"):
        session_id = UUID(group_id.split(":", 1)[1])
        session = db.get(BankReconcileSession, session_id)
        if not session:
            raise ValueError("Bank session not found")
        dep_ids, exp_ids, settle_ids = _session_linked_ids(session)
        if settle_ids:
            for group in db.scalars(
                select(CcSettlementGroup).where(CcSettlementGroup.id.in_(settle_ids))
            ):
                for mid in group.member_expense_ids or []:
                    try:
                        exp_ids.add(UUID(str(mid)))
                    except (TypeError, ValueError):
                        continue
        deposits = (
            list(
                db.scalars(
                    select(Deposit)
                    .options(
                        joinedload(Deposit.property).joinedload(Property.owner),
                        joinedload(Deposit.bank_account),
                    )
                    .where(Deposit.id.in_(dep_ids))
                ).unique()
            )
            if dep_ids
            else []
        )
        expenses = (
            list(
                db.scalars(
                    select(Expense)
                    .options(joinedload(Expense.property).joinedload(Property.owner))
                    .where(Expense.id.in_(exp_ids))
                ).unique()
            )
            if exp_ids
            else []
        )
        rows = _rows_to_transactions(db, deposits=deposits, expenses=expenses)
        total = len(rows)
        return rows[:limit], total

    raise ValueError(f"Unknown group id {group_id}")


def get_cc_pool_transactions(
    db: Session, *, status: str, limit: int = DEFAULT_TX_LIMIT
) -> tuple[list[dict], int]:
    """Unverified CC pool only, scoped after last completed CC verification when set."""
    limit = max(1, min(int(limit), 500))
    last_cc = _last_cc_verification_date(db)
    clauses = [Expense.payment_method == "credit_card"]
    if status == "pending":
        clauses.append(Expense.cc_verified_at.is_(None))
        if last_cc is not None:
            clauses.append(
                or_(Expense.transaction_date.is_(None), Expense.transaction_date > last_cc)
            )
    elif status == "cc_verified":
        clauses.append(Expense.cc_verified_at.is_not(None))
        clauses.append(Expense.cc_bank_confirmed_at.is_(None))
    else:
        raise ValueError("status must be pending or cc_verified")
    total = db.scalar(select(func.count()).select_from(Expense).where(and_(*clauses))) or 0
    expenses = list(
        db.scalars(
            select(Expense)
            .options(joinedload(Expense.property).joinedload(Property.owner))
            .where(and_(*clauses))
            .order_by(Expense.transaction_date.desc().nullslast())
            .limit(limit)
        ).unique()
    )
    return _rows_to_transactions(db, deposits=[], expenses=expenses), int(total)


def _last_cc_verification_date(db: Session) -> date | None:
    row = db.scalars(
        select(CcReconcileSession)
        .where(CcReconcileSession.status == "completed")
        .order_by(
            CcReconcileSession.statement_end_date.desc().nullslast(),
            CcReconcileSession.created_at.desc(),
        )
        .limit(1)
    ).first()
    return row.statement_end_date if row else None


def list_cc_history_groups(db: Session) -> list[dict]:
    completed = db.scalars(
        select(CcReconcileSession)
        .where(CcReconcileSession.status == "completed")
        .order_by(
            CcReconcileSession.statement_end_date.desc().nullslast(),
            CcReconcileSession.created_at.desc(),
        )
    ).all()
    groups: list[dict] = []
    for session in completed:
        matched = 0
        for line in session.lines_json or []:
            if line.get("status") in ("matched", "added") and line.get("proposed_tx_id"):
                matched += 1
        end = session.statement_end_date
        groups.append(
            {
                "id": f"cc-session:{session.id}",
                "kind": "cc",
                "status": "verified",
                "title": f"CC verified through {end.isoformat()}" if end else "CC verified period",
                "date": end.isoformat() if end else None,
                "statement_start_date": session.statement_start_date.isoformat()
                if session.statement_start_date
                else None,
                "statement_end_date": end.isoformat() if end else None,
                "session_id": str(session.id),
                "filename": session.filename,
                "card_last4": session.card_last4,
                "transaction_count": matched,
            }
        )
    return groups


def verification_workspace(db: Session) -> dict:
    settings = get_or_create_settings(db)
    last_cc = _last_cc_verification_date(db)
    pending_clauses = [
        Expense.payment_method == "credit_card",
        Expense.cc_verified_at.is_(None),
    ]
    if last_cc is not None:
        pending_clauses.append(
            or_(Expense.transaction_date.is_(None), Expense.transaction_date > last_cc)
        )
    pending_n = (
        db.scalar(select(func.count()).select_from(Expense).where(and_(*pending_clauses)))
        or 0
    )
    verified_n = db.scalar(
        select(func.count())
        .select_from(Expense)
        .where(
            Expense.payment_method == "credit_card",
            Expense.cc_verified_at.is_not(None),
            Expense.cc_bank_confirmed_at.is_(None),
        )
    ) or 0
    open_cc = db.scalars(
        select(CcReconcileSession)
        .where(CcReconcileSession.status == "in_progress")
        .order_by(CcReconcileSession.created_at.desc())
        .limit(1)
    ).first()
    return {
        "last_verification_date": settings.last_verification_date.isoformat()
        if settings.last_verification_date
        else None,
        "last_cc_verification_date": last_cc.isoformat() if last_cc else None,
        "bank_groups": list_bank_groups(db),
        "cc_history": list_cc_history_groups(db),
        "cc_active_session_id": str(open_cc.id) if open_cc else None,
        "cc_pool": {
            "pending_count": int(pending_n),
            "cc_verified_count": int(verified_n),
        },
    }
