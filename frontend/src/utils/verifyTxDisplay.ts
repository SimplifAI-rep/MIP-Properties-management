import type { BankReconcileLine, CcReconcileLine } from '../types';
import { unifiedFromRecord, type UnifiedTransaction } from '../utils/unifiedTransaction';

/** Map API TransactionRead-shaped rows for TransactionTable. */
export function txsFromApi(items: Record<string, unknown>[] | undefined): UnifiedTransaction[] {
  return (items ?? []).map((item) => unifiedFromRecord(item));
}

/**
 * What a statement-only row is, in the language of the verification lists.
 * Drafts have no property or owner, so those cells read as not-applicable.
 */
function draftSection(status: string): string {
  if (status === 'added') return 'Created from statement';
  if (status === 'ignored') return 'Skipped';
  return 'Statement draft';
}

/** Synthetic row for Excel-only drafts (not yet in the app). */
export function bankDraftToUnified(line: BankReconcileLine): UnifiedTransaction {
  return {
    id: line.fingerprint,
    kind: line.side === 'credit' ? 'deposit' : 'expense',
    property_id: '',
    transaction_date: line.transaction_date,
    client_prop_id: '—',
    property_name: '—',
    owner_name: '—',
    amount: line.amount,
    currency: 'ILS',
    transaction_ref: line.asmachta ? `אסמכתא ${line.asmachta}` : null,
    bank_verified_at: line.status === 'added' ? new Date().toISOString() : null,
    bank_asmachta: line.asmachta,
    bank_reconcile_exclude: false,
    section: draftSection(line.status),
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
    client_prop_id: '—',
    property_name: '—',
    owner_name: '—',
    amount: line.amount,
    currency: 'ILS',
    transaction_ref: line.proposed_tx_ref ?? null,
    bank_verified_at: null,
    bank_asmachta: null,
    bank_reconcile_exclude: false,
    cc_verified_at: line.status === 'added' || line.status === 'matched'
      ? new Date().toISOString()
      : null,
    section: draftSection(line.status),
    notes: line.details || line.merchant || null,
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

/** Confirmed or created card charges for the Found / history lists. */
export function ccFoundTxs(session: {
  lines?: CcReconcileLine[];
  able_txs?: Record<string, unknown>[];
} | null | undefined): UnifiedTransaction[] {
  const ableTxs = txsFromApi(session?.able_txs);
  const ableById = new Map(ableTxs.map((tx) => [tx.id, tx]));
  const found: UnifiedTransaction[] = [];
  const seen = new Set<string>();
  for (const line of session?.lines ?? []) {
    if (
      line.status !== 'proposed_match' &&
      line.status !== 'matched' &&
      line.status !== 'added'
    ) {
      continue;
    }
    const id = line.proposed_tx_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    found.push(ableById.get(id) ?? { ...ccDraftToUnified(line), id });
  }
  for (const tx of ableTxs) {
    if (seen.has(tx.id)) continue;
    seen.add(tx.id);
    found.push(tx);
  }
  return found;
}

