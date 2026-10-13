import type { Transaction } from '../types';

export function transactionCsvRows(
  rows: Transaction[],
): Record<string, string | number | null>[] {
  return rows.map((row) => ({
    Ref: row.transaction_ref ?? '',
    'Prop ID': row.client_prop_id,
    Date: row.transaction_date,
    Section: row.section,
    Notes: row.notes ?? '',
    Type: row.kind === 'deposit' ? 'Deposit' : 'Expense',
    Amount: row.kind === 'expense' ? row.amount : '',
    Inflow: row.kind === 'deposit' ? row.amount : '',
    Company: row.company ?? '',
    Balance: row.balance_after ?? '',
    Property: row.property_name,
    Owner: row.owner_name,
    'Source file': row.source_file ?? '',
    'He/She paid': row.paid_by_resident ? 'yes' : '',
    'Owner paid': row.paid_by_owner ? 'yes' : '',
    'Rental income': row.is_rental_income ? 'yes' : '',
  }));
}
