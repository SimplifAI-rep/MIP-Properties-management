export interface Owner {
  id: string;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
}

export interface BankAccount {
  id: string;
  bank_name: string;
  account_number: string;
  currency: string;
}

export interface Deposit {
  id: string;
  property_id: string;
  property_name: string;
  owner_name: string;
  bank_account_id: string;
  account_number: string;
  transaction_date: string;
  amount: string;
  currency: string;
  reference: string | null;
  description: string | null;
  source: string;
}

export interface Property {
  id: string;
  name: string;
  address: string | null;
  status: string;
  owner_id: string;
  owner_name: string;
  deposit_count: number;
  total_deposits: string;
}

export interface PropertyDetail extends Property {
  owner: Owner;
  bank_accounts: BankAccount[];
  recent_deposits: Deposit[];
}

export interface DepositListResponse {
  items: Deposit[];
  total: number;
  page: number;
  page_size: number;
}

export interface DepositSummary {
  total_amount: string;
  deposit_count: number;
  property_count: number;
  missing_deposit_count: number;
}

export interface DepositGap {
  property_id: string;
  property_name: string;
  owner_name: string;
  expected_amount: string;
  due_day: number;
  period_start: string;
  period_end: string;
  status: string;
}

export interface DepositFilters {
  property_id?: string;
  owner_id?: string;
  date_from?: string;
  date_to?: string;
  min_amount?: string;
  max_amount?: string;
  page?: number;
  page_size?: number;
}
