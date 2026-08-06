/** Canonical shared transaction row used across list UIs, AI results, and exports. */

export type TransactionKind = 'deposit' | 'expense';

export interface UnifiedTransaction {
  id: string;
  kind: TransactionKind;
  property_id: string;
  transaction_date: string | null;
  client_prop_id: string;
  property_name: string;
  owner_name: string;
  amount: string;
  currency: string;
  /** Excel "Section" (expense category / deposit account cue). */
  section: string;
  /** Excel "Notes". */
  notes: string | null;
  /** Excel "Company" when present. */
  company: string | null;
  payment_method?: string | null;
  source?: string | null;
  receipt_ref?: string | null;
  source_file?: string | null;
  balance_after?: string | null;
  paid_by_resident?: boolean;
  paid_by_company?: boolean;
  paid_by_owner?: boolean;
  ledger_column?: string | null;
  is_rental_income?: boolean;
  from_bank_statement?: boolean;
  needs_review?: boolean;
  review_reasons?: string | null;
}
