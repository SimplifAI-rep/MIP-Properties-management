import type { BankReconcileLine, CcReconcileLine } from '../types';
import { unifiedFromRecord, type UnifiedTransaction } from '../utils/unifiedTransaction';

/** Map API TransactionRead-shaped rows for TransactionTable. */
export function txsFromApi(items: Record<string, unknown>[] | undefined): UnifiedTransaction[] {
  return (items ?? []).map((item) => unifiedFromRecord(item));
}

/** Synthetic row for Excel-only drafts (not yet in the app). */
export function bankDraftToUnified(line: BankReconcileLine): UnifiedTransaction {
  return {
    id: line.fingerprint,
    kind: line.side === 'credit' ? 'deposit' : 'expense',
    property_id: '',
    transaction_date: line.transaction_date,
    client_prop_id: '',
    property_name: '—',
    owner_name: '',
    amount: line.amount,
    currency: 'ILS',
    transaction_ref: line.asmachta ? `אסמכתא ${line.asmachta}` : null,
    bank_verified_at: line.status === 'added' ? new Date().toISOString() : null,
    bank_asmachta: line.asmachta,
    bank_reconcile_exclude: false,
    section: line.status === 'added' ? 'Created from statement' : 'Statement draft',
    notes: line.description,
    company: null,
    payment_method: null,
    source: 'bank_statement',
    receipt_ref: null,
    source_file: null,
    balance_after: null,
    from_bank_statement: true,
    needs_review: line.status === 'unmatched',
    review_reasons: line.status === 'unmatched' ? 'Unmatched' : null,
  };
}

export function ccDraftToUnified(line: CcReconcileLine): UnifiedTransaction {
  return {
    id: line.fingerprint,
    kind: 'expense',
    property_id: '',
    transaction_date: line.transaction_date,
    client_prop_id: '',
    property_name: '—',
    owner_name: '',
    amount: line.amount,
    currency: 'ILS',
    transaction_ref: line.proposed_tx_ref ?? null,
    bank_verified_at: null,
    bank_asmachta: null,
    bank_reconcile_exclude: false,
    cc_verified_at: line.status === 'added' ? new Date().toISOString() : null,
    section: line.status === 'added' ? 'Created from statement' : 'Statement draft',
    notes: line.details || line.merchant,
    company: line.merchant ?? null,
    payment_method: 'credit_card',
    source: 'credit_card',
    receipt_ref: null,
    source_file: null,
    balance_after: null,
    from_bank_statement: false,
    needs_review: line.status === 'unmatched',
    review_reasons: line.status === 'unmatched' ? 'Unmatched' : null,
  };
}
