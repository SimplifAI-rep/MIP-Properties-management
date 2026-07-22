/** Shared expense option lists used by Transactions, Upload, and Alerts. */

export const EXPENSE_CATEGORIES = [
  'maintenance',
  'tax',
  'insurance',
  'utilities',
  'management_fee',
  'other',
] as const;

/** Common Method values — Excel uses free text; these cover manual entry. */
export const PAYMENT_METHODS = [
  'bank_direct_debit',
  'credit_card',
  'bank_transfer',
  'owner_personal',
  'company_account',
  'cash',
] as const;

export const EXPENSE_SOURCES = [
  'standing_order',
  'credit_card',
  'manual_owner',
  'manual_company',
  'management_ledger',
  'bank_statement',
] as const;

/** Soft suggestions for Section (Excel free-text); users can type anything. */
export const SECTION_SUGGESTIONS = [
  'Cleaning',
  'Maintenance',
  'Utilities',
  'Insurance',
  'Tax',
  'Management fee',
  'Other',
] as const;
