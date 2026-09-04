"""Bank reconcile session: match bank Excel lines → verify app txs (Step 4)."""

from __future__ import annotations

import copy
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.bank_reconcile_session import BankReconcileSession
from app.models.cc_settlement_group import CcSettlementGroup
from app.models.deposit import Deposit
from app.models.expense import Expense
from app.models.property import Property
from app.services.account_scope import (
    deposit_belongs_to_account_clause,
    get_default_operating_account,
    get_operating_account,
)
from app.services.bank_reconcile_gap import parse_bank_statement_lines, sum_bank_scoped_nets
from app.services.bank_settings import (
    effective_last_verification,
    effective_opening_as_of,
    effective_opening_balance,
    get_or_create_settings,
    resolve_account_settings,
)
from app.services.transaction_filters import (
    deposit_company_float_clause,
    expense_company_float_clauses,
)

# Bank CC settlement debit descriptions (Leumi Mastercard, etc.)
_CC_SETTLEMENT_NEEDLES = (
    "לאומי מאסטרקרד",
    "לאומי מסטרקארד",
    "מאסטרקרד",
    "מסטרקארד",
    "mastercard",
)


def _is_cc_settlement_line(description: str | None) -> bool:
    if not description:
        return False
    text = description.lower()
    return any(needle.lower() in text for needle in _CC_SETTLEMENT_NEEDLES)


def _parse_iso_date(value: str | None) -> date | None:
    if not value:
        return None
    return date.fromisoformat(value[:10])


def _app_candidate_filters(
    *,
    date_from: date | None,
    date_to: date | None,
    bank_account_id: UUID | None = None,
    is_default_account: bool = True,
):
    """Unverified bank-scoped app txs inside the uploaded statement date window."""
    dep = [
        deposit_company_float_clause(),
        Deposit.bank_reconcile_exclude.is_(False),
        Deposit.bank_verified_at.is_(None),
        Deposit.transaction_date.is_not(None),
        Deposit.amount > 0,
    ]
    if bank_account_id is not None:
        dep.append(
            deposit_belongs_to_account_clause(
                bank_account_id, is_default=is_default_account
            )
        )
    exp = [
        *expense_company_float_clauses(),
        Expense.bank_reconcile_exclude.is_(False),
        Expense.bank_verified_at.is_(None),
        Expense.transaction_date.is_not(None),
        Expense.amount > 0,
        or_(Expense.payment_method.is_(None), Expense.payment_method != "credit_card"),
    ]
    if date_from is not None:
        dep.append(Deposit.transaction_date >= date_from)
        exp.append(Expense.transaction_date >= date_from)
    if date_to is not None:
        dep.append(Deposit.transaction_date <= date_to)
        exp.append(Expense.transaction_date <= date_to)
    # Non-default operating accounts only reconcile deposits on that account
    if not is_default_account:
        exp = None
    return dep, exp


def _score_deposit(line: dict, row: Deposit) -> int:
    score = 0
    line_date = _parse_iso_date(line.get("transaction_date"))
    amount = Decimal(str(line["amount"]))
    if row.amount != amount:
        return -1
    if line_date and row.transaction_date == line_date:
        score += 3
    asmachta = line.get("asmachta")
    if asmachta and row.reference and str(row.reference).strip() == asmachta:
        score += 5
    if asmachta and getattr(row, "bank_asmachta", None) == asmachta:
        score += 5
    desc = (line.get("description") or "").lower()
    row_desc = (row.description or "").lower()
    if desc and row_desc and (desc in row_desc or row_desc in desc):
        score += 2
    return score


def _score_expense(line: dict, row: Expense) -> int:
    score = 0
    line_date = _parse_iso_date(line.get("transaction_date"))
    amount = Decimal(str(line["amount"]))
    if row.amount != amount:
        return -1
    if line_date and row.transaction_date == line_date:
        score += 3
    asmachta = line.get("asmachta")
    if asmachta and row.reference and str(row.reference).strip() == asmachta:
        score += 5
    needle = (line.get("description") or "").lower()
    hay = " ".join(
        p for p in (row.vendor_name or "", row.description or "", row.category or "") if p
    ).lower()
    if needle and hay and (needle in hay or hay in needle):
        score += 2
    return score


def _propose_settlement_groups(db: Session, lines: list[dict]) -> None:
    """Link bank Mastercard settlement debits to CC-verified merchant date groups."""
    settlements = [
        line
        for line in lines
        if line.get("side") == "debit"
        and _is_cc_settlement_line(line.get("description"))
        and line.get("status") == "unmatched"
    ]
    if not settlements:
        return
    settlements.sort(key=lambda l: l.get("transaction_date") or "")

    candidates = list(
        db.scalars(
            select(Expense).where(
                and_(
                    Expense.payment_method == "credit_card",
                    Expense.cc_verified_at.is_not(None),
                    Expense.cc_settlement_group_id.is_(None),
                    Expense.cc_bank_confirmed_at.is_(None),
                    Expense.transaction_date.is_not(None),
                    Expense.amount > 0,
                )
            )
        )
    )
    used_ids: set[UUID] = set()
    prev_settlement_date: date | None = None

    for line in settlements:
        settle_date = _parse_iso_date(line.get("transaction_date"))
        settle_amount = Decimal(str(line["amount"]))
        # Billing window: day after previous settlement → settlement date (inclusive)
        if settle_date is None:
            window_start = None
            window_end = None
        else:
            window_end = settle_date
            if prev_settlement_date is not None:
                window_start = prev_settlement_date + timedelta(days=1)
            else:
                window_start = settle_date - timedelta(days=45)

        members: list[Expense] = []
        for row in candidates:
            if row.id in used_ids or row.transaction_date is None:
                continue
            if window_start and row.transaction_date < window_start:
                continue
            if window_end and row.transaction_date > window_end:
                continue
            members.append(row)

        member_total = sum((row.amount for row in members), Decimal("0"))
        # Only require bank confirmation when linked to Card-verified charges.
        if not members:
            line["proposed_kind"] = "cc_settlement"
            line["proposed_member_ids"] = []
            line["proposed_group_total"] = "0"
            line["proposed_window_start"] = (
                window_start.isoformat() if window_start else None
            )
            line["proposed_window_end"] = window_end.isoformat() if window_end else None
            line["proposed_summary"] = (
                "Card payment — no linked card-verified charges yet"
            )
            line["match_confidence"] = "low"
            # Leave status unmatched; does not block Complete until Card links exist.
            if settle_date is not None:
                prev_settlement_date = settle_date
            continue

        diff = abs(member_total - settle_amount)
        if diff <= Decimal("1.00"):
            confidence = "high"
        elif settle_amount > 0 and diff / settle_amount <= Decimal("0.05"):
            confidence = "medium"
        else:
            confidence = "low"

        for row in members:
            used_ids.add(row.id)

        line["status"] = "proposed_settlement"
        line["proposed_kind"] = "cc_settlement"
        line["proposed_tx_id"] = None
        line["proposed_tx_ref"] = None
        line["proposed_member_ids"] = [str(row.id) for row in members]
        line["proposed_group_total"] = str(member_total)
        line["proposed_window_start"] = window_start.isoformat() if window_start else None
        line["proposed_window_end"] = window_end.isoformat() if window_end else None
        line["match_confidence"] = confidence
        line["proposed_summary"] = (
            f"CC settlement → {len(members)} CC-verified merchant(s) · "
            f"group {member_total} vs bank {settle_amount}"
        )
        if settle_date is not None:
            prev_settlement_date = settle_date


def _line_requires_bank_action(line: dict) -> bool:
    """Whether a bank line must be resolved before Complete period."""
    status = line.get("status") or "unmatched"
    if status == "proposed_match":
        return True
    if status == "proposed_settlement":
        # Only when linked to Card-verified merchants
        return bool(line.get("proposed_member_ids"))
    if status == "unmatched":
        # Card payment rows wait for Card section — not required on their own
        if _is_cc_settlement_line(line.get("description")) or line.get(
            "proposed_kind"
        ) == "cc_settlement":
            return False
        return True
    return False


def _propose_matches(
    db: Session,
    lines: list[dict],
    *,
    date_from: date | None,
    date_to: date | None,
    bank_account_id: UUID | None = None,
    is_default_account: bool = True,
) -> None:
    # Stage C first: settlement lines are groups, not 1:1 merchant matches
    # Settlements only apply on the default operating account
    if is_default_account:
        _propose_settlement_groups(db, lines)

    dep_f, exp_f = _app_candidate_filters(
        date_from=date_from,
        date_to=date_to,
        bank_account_id=bank_account_id,
        is_default_account=is_default_account,
    )
    deposits = list(db.scalars(select(Deposit).where(and_(*dep_f))))
    expenses = (
        list(db.scalars(select(Expense).where(and_(*exp_f)))) if exp_f is not None else []
    )
    used_dep: set[UUID] = set()
    used_exp: set[UUID] = set()

    for line in lines:
        if line.get("status") != "unmatched":
            continue
        if _is_cc_settlement_line(line.get("description")):
            # Already handled (or no group) — leave as unmatched settlement if not proposed
            continue
        line_date = _parse_iso_date(line.get("transaction_date"))
        amount = Decimal(str(line["amount"]))
        window_start = (line_date - timedelta(days=3)) if line_date else None
        window_end = (line_date + timedelta(days=3)) if line_date else None

        if line["side"] == "credit":
            best: tuple[int, Deposit] | None = None
            for row in deposits:
                if row.id in used_dep:
                    continue
                if window_start and row.transaction_date and not (
                    window_start <= row.transaction_date <= window_end  # type: ignore[operator]
                ):
                    continue
                if row.amount != amount:
                    continue
                score = _score_deposit(line, row)
                if score < 0:
                    continue
                if best is None or score > best[0]:
                    best = (score, row)
            if best and best[0] >= 3:
                row = best[1]
                used_dep.add(row.id)
                line["status"] = "proposed_match"
                line["proposed_kind"] = "deposit"
                line["proposed_tx_id"] = str(row.id)
                line["proposed_tx_ref"] = row.transaction_ref
                line["proposed_summary"] = (
                    f"deposit {row.transaction_date} · {row.amount} · "
                    f"{(row.description or '')[:80]}"
                )
                line["match_confidence"] = "high" if best[0] >= 5 else "medium"
        else:
            best_e: tuple[int, Expense] | None = None
            for row in expenses:
                if row.id in used_exp:
                    continue
                if window_start and row.transaction_date and not (
                    window_start <= row.transaction_date <= window_end  # type: ignore[operator]
                ):
                    continue
                if row.amount != amount:
                    continue
                score = _score_expense(line, row)
                if score < 0:
                    continue
                if best_e is None or score > best_e[0]:
                    best_e = (score, row)
            if best_e and best_e[0] >= 3:
                row = best_e[1]
                used_exp.add(row.id)
                line["status"] = "proposed_match"
                line["proposed_kind"] = "expense"
                line["proposed_tx_id"] = str(row.id)
                line["proposed_tx_ref"] = row.transaction_ref
                line["proposed_summary"] = (
                    f"expense {row.transaction_date} · {row.amount} · "
                    f"{(row.vendor_name or row.description or row.category or '')[:80]}"
                )
                line["match_confidence"] = "high" if best_e[0] >= 5 else "medium"


def _unmatched_app_rows(
    db: Session,
    *,
    date_from: date | None,
    date_to: date | None,
    matched_ids: set[str],
    bank_account_id: UUID | None = None,
    is_default_account: bool = True,
) -> list[dict]:
    dep_f, exp_f = _app_candidate_filters(
        date_from=date_from,
        date_to=date_to,
        bank_account_id=bank_account_id,
        is_default_account=is_default_account,
    )
    out: list[dict] = []
    for row in db.scalars(select(Deposit).where(and_(*dep_f))):
        if str(row.id) in matched_ids:
            continue
        out.append(
            {
                "kind": "deposit",
                "id": str(row.id),
                "transaction_ref": row.transaction_ref,
                "transaction_date": row.transaction_date.isoformat()
                if row.transaction_date
                else None,
                "amount": str(row.amount),
                "description": row.description,
                "status": "unmatched",
                "ignore_reason": None,
            }
        )
    if exp_f is not None:
        for row in db.scalars(select(Expense).where(and_(*exp_f))):
            if str(row.id) in matched_ids:
                continue
            out.append(
                {
                    "kind": "expense",
                    "id": str(row.id),
                    "transaction_ref": row.transaction_ref,
                    "transaction_date": row.transaction_date.isoformat()
                    if row.transaction_date
                    else None,
                    "amount": str(row.amount),
                    "description": row.vendor_name or row.description or row.category,
                    "status": "unmatched",
                    "ignore_reason": None,
                }
            )
    out.sort(key=lambda r: (r.get("transaction_date") or "", r["kind"], r["id"]))
    return out


def create_session_from_upload(
    db: Session,
    *,
    content: bytes,
    filename: str | None,
    bank_account_id: UUID | str | None = None,
) -> BankReconcileSession:
    account = get_operating_account(db, bank_account_id)
    if account is None:
        raise ValueError(
            "No operating bank account found. Import company data or create an account first."
        )
    default = get_default_operating_account(db)
    is_default = default is not None and account.id == default.id

    existing_q = select(BankReconcileSession).where(
        BankReconcileSession.status == "in_progress",
    )
    if is_default:
        existing_q = existing_q.where(
            or_(
                BankReconcileSession.bank_account_id == account.id,
                BankReconcileSession.bank_account_id.is_(None),
            )
        )
    else:
        existing_q = existing_q.where(BankReconcileSession.bank_account_id == account.id)
    existing = db.scalars(existing_q).first()
    if existing:
        raise ValueError(
            "A verification period is already open for this bank account. "
            "Complete it before uploading another statement."
        )

    parsed = parse_bank_statement_lines(content)
    account_row, company = resolve_account_settings(db, bank_account_id=account.id)
    opening = effective_opening_balance(account_row, company)
    after = effective_opening_as_of(account_row, company) or effective_last_verification(
        account_row, company
    )
    date_from = parsed["statement_start_date"]
    date_to = parsed["statement_end_date"]
    lines = parsed["lines"]
    _propose_matches(
        db,
        lines,
        date_from=date_from,
        date_to=date_to,
        bank_account_id=account.id,
        is_default_account=is_default,
    )
    matched_ids = {
        line["proposed_tx_id"]
        for line in lines
        if line.get("status") == "proposed_match" and line.get("proposed_tx_id")
    }
    unmatched_app = _unmatched_app_rows(
        db,
        date_from=date_from,
        date_to=date_to,
        matched_ids=matched_ids,
        bank_account_id=account.id,
        is_default_account=is_default,
    )

    session = BankReconcileSession(
        status="in_progress",
        filename=filename,
        bank_account_id=account.id,
        bank_balance=parsed["bank_balance"],
        statement_start_date=date_from,
        statement_end_date=date_to,
        opening_balance=opening,
        after_date=after,
        gap_tolerance_amount=company.gap_tolerance_amount or Decimal("0.01"),
        lines_json=lines,
        unmatched_app_json=unmatched_app,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def session_summary(db: Session, session: BankReconcileSession) -> dict:
    lines = list(session.lines_json or [])
    apps = list(session.unmatched_app_json or [])
    counts = {
        "proposed_match": 0,
        "proposed_settlement": 0,
        "matched": 0,
        "ignored": 0,
        "unmatched": 0,
        "added": 0,
        "settled": 0,
    }
    for line in lines:
        st = line.get("status") or "unmatched"
        counts[st] = counts.get(st, 0) + 1
    app_unmatched = sum(1 for a in apps if a.get("status") == "unmatched")
    app_ignored = sum(1 for a in apps if a.get("status") == "ignored")

    all_net, verified_net, _, _ = sum_bank_scoped_nets(
        db,
        after_date=session.after_date,
        date_to=session.statement_end_date,
    )
    opening = session.opening_balance
    bank_balance = session.bank_balance
    tolerance = session.gap_tolerance_amount or Decimal("0.01")
    gap_verified = None
    within = None
    if bank_balance is not None and opening is not None:
        gap_verified = bank_balance - (opening + verified_net)
        within = abs(gap_verified) <= tolerance

    unresolved_bank = sum(1 for line in lines if _line_requires_bank_action(line))
    unresolved_app = app_unmatched
    can_complete = unresolved_bank == 0 and unresolved_app == 0 and (
        within is True or (bank_balance is None or opening is None)
    )
    # If O and B set, require gap within tolerance
    if bank_balance is not None and opening is not None:
        can_complete = unresolved_bank == 0 and unresolved_app == 0 and within is True

    able_dep: set[UUID] = set()
    able_exp: set[UUID] = set()
    for line in lines:
        if line.get("status") not in ("proposed_match", "matched", "added"):
            continue
        tx_id = line.get("proposed_tx_id")
        kind = line.get("proposed_kind")
        if not tx_id or kind not in ("deposit", "expense"):
            continue
        try:
            uid = UUID(str(tx_id))
        except (TypeError, ValueError):
            continue
        if kind == "deposit":
            able_dep.add(uid)
        else:
            able_exp.add(uid)

    not_excel_dep: set[UUID] = set()
    not_excel_exp: set[UUID] = set()
    for app in apps:
        try:
            uid = UUID(str(app["id"]))
        except (TypeError, ValueError, KeyError):
            continue
        if app.get("kind") == "deposit":
            not_excel_dep.add(uid)
        else:
            not_excel_exp.add(uid)

    from app.services.verification_workspace import load_transactions_by_ids

    able_txs = load_transactions_by_ids(db, deposit_ids=able_dep, expense_ids=able_exp)
    not_in_excel_txs = load_transactions_by_ids(
        db, deposit_ids=not_excel_dep, expense_ids=not_excel_exp
    )

    return {
        "id": str(session.id),
        "status": session.status,
        "filename": session.filename,
        "bank_account_id": str(session.bank_account_id) if session.bank_account_id else None,
        "bank_balance": str(bank_balance) if bank_balance is not None else None,
        "statement_start_date": session.statement_start_date.isoformat()
        if session.statement_start_date
        else None,
        "statement_end_date": session.statement_end_date.isoformat()
        if session.statement_end_date
        else None,
        "opening_balance": str(opening) if opening is not None else None,
        "after_date": session.after_date.isoformat() if session.after_date else None,
        "gap_tolerance_amount": str(tolerance),
        "verified_net": str(verified_net),
        "all_scoped_net": str(all_net),
        "gap_verified": str(gap_verified) if gap_verified is not None else None,
        "within_tolerance_verified": within,
        "counts": {
            **counts,
            "app_unmatched": app_unmatched,
            "app_ignored": app_ignored,
            "unresolved_bank": unresolved_bank,
            "unresolved_app": unresolved_app,
        },
        "can_complete": can_complete,
        "lines": lines,
        "unmatched_app": apps,
        "able_txs": able_txs,
        "not_in_excel_txs": not_in_excel_txs,
    }


def apply_actions(db: Session, session: BankReconcileSession, actions: list[dict]) -> BankReconcileSession:
    if session.status != "in_progress":
        raise ValueError("Session is not in progress")
    lines = {line["fingerprint"]: line for line in (session.lines_json or [])}
    apps = {f"{a['kind']}:{a['id']}": a for a in (session.unmatched_app_json or [])}
    now = datetime.now(timezone.utc)

    for action in actions:
        kind = action.get("action")
        if kind == "confirm_match":
            fp = action["fingerprint"]
            line = lines.get(fp)
            if not line:
                raise ValueError(f"Unknown bank line {fp}")
            if line.get("proposed_kind") == "cc_settlement" or line.get("status") == "proposed_settlement":
                raise ValueError("Use confirm_settlement for CC settlement bank lines")
            tx_kind = action.get("kind") or line.get("proposed_kind")
            tx_id = action.get("tx_id") or line.get("proposed_tx_id")
            if not tx_kind or not tx_id:
                raise ValueError("confirm_match requires kind and tx_id")
            uid = UUID(str(tx_id))
            if tx_kind == "deposit":
                row = db.get(Deposit, uid)
            else:
                row = db.get(Expense, uid)
            if not row:
                raise ValueError(f"Transaction {tx_id} not found")
            row.bank_verified_at = now
            row.bank_asmachta = line.get("asmachta")
            line["status"] = "matched"
            line["proposed_kind"] = tx_kind
            line["proposed_tx_id"] = str(tx_id)
            line["proposed_tx_ref"] = row.transaction_ref
            apps.pop(f"{tx_kind}:{tx_id}", None)

        elif kind == "confirm_settlement":
            fp = action["fingerprint"]
            line = lines.get(fp)
            if not line:
                raise ValueError(f"Unknown bank line {fp}")
            if not _is_cc_settlement_line(line.get("description")) and line.get(
                "proposed_kind"
            ) != "cc_settlement":
                raise ValueError("Bank line is not a CC settlement")
            member_ids = action.get("member_ids") or line.get("proposed_member_ids") or []
            member_ids = [str(mid) for mid in member_ids]
            settle_date = _parse_iso_date(line.get("transaction_date"))
            settle_amount = Decimal(str(line["amount"]))
            window_start = _parse_iso_date(line.get("proposed_window_start"))
            window_end = _parse_iso_date(line.get("proposed_window_end")) or settle_date

            members: list[Expense] = []
            member_total = Decimal("0")
            for mid in member_ids:
                row = db.get(Expense, UUID(mid))
                if not row:
                    raise ValueError(f"Expense {mid} not found")
                if row.payment_method != "credit_card":
                    raise ValueError(f"Expense {mid} is not paid-by-card")
                if row.cc_verified_at is None:
                    raise ValueError(f"Expense {mid} is not CC-verified yet")
                if row.cc_settlement_group_id is not None:
                    raise ValueError(f"Expense {mid} already in a settlement group")
                members.append(row)
                member_total += row.amount

            group = CcSettlementGroup(
                settlement_date=settle_date,
                amount=settle_amount,
                bank_asmachta=line.get("asmachta"),
                bank_fingerprint=fp,
                bank_description=line.get("description"),
                window_start=window_start,
                window_end=window_end,
                member_total=member_total,
                member_expense_ids=member_ids,
                status="confirmed",
                confirmed_at=now,
            )
            db.add(group)
            db.flush()
            for row in members:
                row.cc_settlement_group_id = group.id
                row.cc_bank_confirmed_at = now
                # Settlement is the bank cash event — merchants stay out of bank 1:1 verify
            line["status"] = "settled"
            line["proposed_kind"] = "cc_settlement"
            line["settlement_group_id"] = str(group.id)
            line["proposed_member_ids"] = member_ids
            line["proposed_group_total"] = str(member_total)
            line["proposed_summary"] = (
                f"Settled {len(members)} merchant(s) · group {member_total} · "
                f"bank {settle_amount}"
            )

        elif kind == "ignore_bank":
            fp = action["fingerprint"]
            line = lines.get(fp)
            if not line:
                raise ValueError(f"Unknown bank line {fp}")
            reason = (action.get("reason") or "").strip() or "Ignored"
            line["status"] = "ignored"
            line["ignore_reason"] = reason

        elif kind == "ignore_app":
            tx_kind = action["kind"]
            tx_id = str(action["tx_id"])
            key = f"{tx_kind}:{tx_id}"
            app = apps.get(key)
            if not app:
                # Allow ignoring even if not in list (already matched)
                continue
            reason = (action.get("reason") or "").strip() or "Ignored"
            app["status"] = "ignored"
            app["ignore_reason"] = reason

        elif kind == "add_from_bank":
            fp = action["fingerprint"]
            line = lines.get(fp)
            if not line:
                raise ValueError(f"Unknown bank line {fp}")
            property_id = action.get("property_id")
            if not property_id:
                raise ValueError("add_from_bank requires property_id")
            prop = db.get(Property, UUID(str(property_id)))
            if not prop:
                raise ValueError("Property not found")
            amount = Decimal(str(line["amount"]))
            tx_date = _parse_iso_date(line.get("transaction_date"))
            asmachta = line.get("asmachta")
            desc = line.get("description")
            if line["side"] == "credit":
                row = Deposit(
                    property_id=prop.id,
                    bank_account_id=session.bank_account_id,
                    transaction_date=tx_date,
                    amount=amount,
                    currency="ILS",
                    reference=asmachta,
                    description=desc or "Bank statement credit",
                    source="bank_statement",
                    bank_verified_at=now,
                    bank_asmachta=asmachta,
                )
                db.add(row)
                db.flush()
                line["status"] = "added"
                line["proposed_kind"] = "deposit"
                line["proposed_tx_id"] = str(row.id)
                line["proposed_tx_ref"] = row.transaction_ref
            else:
                row = Expense(
                    property_id=prop.id,
                    transaction_date=tx_date,
                    amount=amount,
                    currency="ILS",
                    category="bank_transfer",
                    source="bank_statement",
                    payment_method="bank_transfer",
                    reference=asmachta,
                    description=desc or "Bank statement debit",
                    bank_verified_at=now,
                    bank_asmachta=asmachta,
                )
                db.add(row)
                db.flush()
                line["status"] = "added"
                line["proposed_kind"] = "expense"
                line["proposed_tx_id"] = str(row.id)
                line["proposed_tx_ref"] = row.transaction_ref
        else:
            raise ValueError(f"Unknown action {kind}")

    session.lines_json = copy.deepcopy(list(lines.values()))
    session.unmatched_app_json = copy.deepcopy(list(apps.values()))
    flag_modified(session, "lines_json")
    flag_modified(session, "unmatched_app_json")
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def complete_session(db: Session, session: BankReconcileSession) -> BankReconcileSession:
    summary = session_summary(db, session)
    if not summary["can_complete"]:
        raise ValueError(
            "Cannot complete: unresolved bank/app lines remain, or Gap outside tolerance"
        )
    settings = get_or_create_settings(db)
    if session.statement_end_date is not None:
        from app.models.bank_account import BankAccount

        account = (
            db.get(BankAccount, session.bank_account_id)
            if session.bank_account_id is not None
            else None
        )
        if account is not None:
            account.last_verification_date = session.statement_end_date
            db.add(account)
            default = get_default_operating_account(db)
            if default is not None and account.id == default.id:
                settings.last_verification_date = session.statement_end_date
                db.add(settings)
        else:
            settings.last_verification_date = session.statement_end_date
            db.add(settings)
    session.status = "completed"
    db.add(session)
    db.commit()
    db.refresh(session)
    return session
