# Bank reconciliation redesign — design for review

**Status:** Draft for discussion (not implementation)  
**Audience:** Product / founders / client workflow owners  
**Date:** 2026-08-31 (updated after client Zoom)

---

## 1. Purpose of this document

Align on a product redesign so the app matches how the client actually works:

1. Enter receipts into SimplifAI as they arrive (including **owner-paid** and **paid by card** flags).  
2. Later upload the **bank Excel** as **ground truth** for money that hits the operating account.  
3. Confirm every **bank-scoped** app transaction in the period appears in the bank (and every bank line is accounted for).  
4. Reach a **verified** state where bank balance and system net reconcile (difference = 0 after accounting for opening balance and **exclusions**).  
5. Handle **credit cards** in two stages: verify merchant receipts against the **CC Excel**, then confirm that period’s CC group when the **bank** shows the card settlement debit.  
6. Ensure **deposits (inflows)** are included in bank matching; exclude rows that never hit the bank (e.g. owner paid the provider) so Gap still closes.

This document proposes goals, concepts, UX, data ideas, and open decisions. **No code changes are implied until this is approved.**

---

## 2. Client workflow (agreed understanding)

| Step | What she does today | What the product should support |
|------|---------------------|--------------------------------|
| 1 | Receives a receipt from a service provider | — |
| 2 | Adds the expense/deposit in **Transactions** (manual or file); may flag **owner-paid** or **paid by card** | Keep as primary entry path; flags drive bank vs CC vs exclude |
| 3 | Periodically uploads **credit card Excel** for card spends | Match / **CC-verify** card-flagged receipts |
| 4 | At period end downloads **bank Excel** | Dedicated **bank reconcile** upload (ground truth for cash) |
| 5 | Checks app ↔ bank (and CC settlement groups) | Match / mark verified; surface leftovers |
| 6 | Confirms totals line up | Show **Bank balance vs bank-scoped net** (target gap = 0) |

**Key mindset shift:** the bank file is not “another way to create transactions.” It is the **verification pass** over work already in the system.

**Ideal outcome when uploading bank Excel:** almost every bank row **matches** an existing transaction (what today looks like “duplicates”). That match should mean **verified**, not “error / ignore.”

---

## 3. Why we need an opening bank balance

The bank Excel includes a **running balance column** (account balance after each row). That number is **not** zero — it is the real bank balance.

So the verification equation cannot be:

> “System net alone must equal 0.”

It must be of the form:

> **Bank statement balance − (Opening bank amount + Bank-scoped net) = 0**  
> (exact formula TBD — see §8)

**Bank-scoped net** includes **deposits (inflows)** and expenses that are expected to hit the operating account. It **excludes** amounts that never move through that bank (notably **owner paid the service provider**), and applies the **credit-card rules in §12** so merchant charges and bank CC settlements are not double-counted.

### First-time / go-live requirement (“verification → verification”)

When SimplifAI goes to **production** for this client, she should start in a **fully verified** baseline — then only work forward **from verification to verification**.

**Go-live cutover (day 0):**

1. Load her current data / files as agreed (ClientData, opening books).  
2. Enter **current bank balance** as the opening bank amount (**O**) with as-of date **D₀** (= last verification / cutover date).  
3. Mark **all existing transactions on or before D₀ as Verified** (baseline — no need to re-match historical bank lines one by one on day 1).  
4. Record **Last verification date = D₀** and show it on the **Dashboard**.  
5. From then on: new receipts enter as **Unverified**; each successful bank reconcile advances the last verification date and clears (or alerts on) gaps.

**Ongoing cadence:**

```text
[Verified through D_last]
        │
        ├─ daily: add receipts → Unverified (after D_last)
        │
        └─ bank upload for (D_last , D_new]
              → match / verify
              → if clean (Gap ≈ 0, no unmatched): Last verification date → D_new
              → if leftovers: high-priority alerts until fixed
```

She always knows: “Books are verified through **this date**; everything after that still needs bank confirmation.”

**Proposal:** opening bank amount + **last verification date** are first-class settings (same cutover moment), editable by admin, visible on Dashboard and Bank reconcile.

---

## 4. Current product gaps (today)

| Area | Today | Gap |
|------|--------|-----|
| Bank upload | Creates/reviews deposit & expense drafts (`source=bank_statement`); duplicates flagged with default **Ignore** | Treated as import, not reconcile |
| “Duplicate” | Soft match (±3 days, amount, ref/text) | Should become **Match → Verified** |
| Verified flag | Only `Expense.reconciled` from management ledger; unused in workflow | No per-transaction **bank-verified** state |
| Bank balance | Not stored; UI “Balance” = company-float Inflow − Expenses | No bank balance / opening balance / last verification date |
| Credit cards | CC Excel creates BUFFER expenses; bank later shows settlement | Double-count risk; no CC-verify → bank-group-confirm path |
| Owner-paid | Excluded from company float today | Not yet treated as first-class “out of bank reconcile” in a Gap/match UX |
| Dashboard / cards | Company-float rules (exclude rental / he-she / owner-paid) | No “verified through” date; no reconcile Gap |
| Alerts | Missing deposits, uploads, incomplete imports, low balance | No auto high-priority alerts for bank↔app mismatches |

---

## 5. Design goals

1. **Bank is ground truth** for company operating account activity.  
2. **Every transaction** can show whether it is **verified against the bank**.  
3. **Every transaction** has a **unique SimplifAI ref** (our own אסמכתא); verified rows also store the bank **אסמכתא**.  
4. Bank upload primarily **matches and verifies**, not invents a second copy of every row.  
5. **Opening bank amount** + go-live cutover so she starts **fully verified** on day 1.  
6. Work **from verification to verification**: Dashboard shows **last verification date**; it advances only after a successful bank reconcile.  
7. After a successful period reconcile: **gap to bank balance = 0** (within a small tolerance).  
8. **Credit cards:** two-stage verify — CC Excel confirms card-flagged receipts; bank CC settlement confirms that date group (no double-count in bank Gap).  
9. **Owner-paid** (and similar non-bank pays) are **excluded from bank totals** / bank match scope.  
10. **Deposits** are always part of bank reconciliation (must match bank credits); exclusions + CC rules keep Gap consistent when some app rows never appear on the bank file.  
11. Unmatched bank rows and unmatched app rows remain visible until resolved — and raise **high-priority alerts** automatically.  
12. Keep manual receipt entry as the daily habit; bank (and CC) work is periodic.

### Non-goals (for this redesign phase)

- Full multi-bank / multi-currency treasury.  
- Automatic payment to vendors.  
- Replacing management-ledger import.  
- Perfect OCR of every receipt (optional later).

---

## 6. Core concepts (proposed language)

| Term | Meaning |
|------|---------|
| **App transaction** | Deposit or expense already in SimplifAI (manual, PDF, ledger, CC file, etc.) |
| **Bank line** | One row from the bank Excel (debit / credit + date + **אסמכתא** + description + **היתרה בש״ח**) |
| **אסמכתא (asmachta)** | Bank statement reference on each bank line — **attached to the app transaction when it is verified** (not always unique in the bank file) |
| **Transaction ref / SimplifAI אסמכתא** | **Our** stable unique id for every deposit/expense — always unique in the app; used for support, search, and linking when bank אסמכתא repeats |
| **Bank-scoped** | App rows expected to appear on the operating bank statement (deposits + company-paid expenses, etc.) — used for match lists and Gap |
| **Owner-paid (non-bank)** | Expense where the **owner paid the service provider directly** — tracked in the app but **excluded from bank totals / bank match / Gap** |
| **Paid by card** | Expense flagged at entry as paid by credit card — awaits **CC Excel** verification, then bank settlement confirmation for its billing period |
| **CC-verified** | Card-flagged merchant tx matched to a row on the credit-card Excel |
| **CC period / settlement group** | Set of CC-verified merchant txs for a billing window; confirmed as a **group** when the bank shows the card settlement debit |
| **Bank-verified** | Bank-scoped app tx matched to a bank line (stores bank **אסמכתא**); or a CC settlement group linked to a bank CC debit |
| **Unmatched bank** | Bank line with no app counterpart — needs entry or explanation |
| **Unmatched app** | Bank-scoped app transaction in period with no bank counterpart — needs attention |
| **Opening bank amount** | Starting balance she enters as of date *D₀* so first reconcile can close to 0 |
| **Last verification date** | Latest date through which books are considered bank-verified; set at go-live, updated when a reconcile session completes cleanly |
| **Go-live cutover** | Production start: balance + files loaded; all txs ≤ D₀ marked Verified; last verification date = D₀ |
| **Reconcile session** | One upload + period + results (matches, leftovers, gap) |
| **Reconcile alert** | High-priority alert when a bank upload leaves unmatched app rows, unmatched bank lines, and/or Gap ≠ 0 |
| **CC settlement** | Bank debit that pays the credit-card bill (e.g. `לאומי מאסטרקרד`) — must not double-count with CC merchant rows |

---

## 7. Proposed end-to-end flow

```text
Go-live (production)
  Load files + set Opening bank amount O as of D₀
  Mark all existing txs (≤ D₀) Verified (baseline)
  Dashboard: Last verification date = D₀

Daily (after D₀)
  Receipt → Add expense/deposit
            • Normal company pay → Unverified (bank-scoped)
            • Owner paid provider → flag owner-paid → Excluded from bank Gap/match
            • Paid by card → flag paid-by-card → awaits CC verify (not raw bank match)

Credit-card cycle
  Manual card receipts (paid-by-card) accumulate as Unverified / CC-pending
  → Upload credit card Excel
        → Match merchant lines → mark those txs CC-verified
  → Later: bank Excel contains CC settlement debit (e.g. לאומי מאסטרקרד)
        → Link settlement to the CC date group → group bank-confirmed
        → Settlement counts in bank balance; merchant CC amounts do not also
          count again in bank-scoped net (see §12)

Bank reconcile (operating account)
  Upload bank Excel (ground truth for cash in/out of the account)
  → Match bank-scoped Unverified txs (especially deposits = credits, company expenses = debits)
  → Skip owner-paid from unmatched-app pressure (they are excluded)
  → Handle CC settlement lines as group confirmation (§12), not as duplicate merchant expenses
  → Gap = B − (O + bank-scoped net including deposits)
  → Leftovers → high-priority alerts
  → Clean complete → advance last verification date
```

**Important:** matching a bank line to an existing app row should **not** create a duplicate transaction by default. Creating a new row is only for true unmatched bank lines.

**Important:** she works **verification → verification**. Between dates, Unverified / CC-pending rows and open reconcile alerts are the work queue; after a clean bank pass, the Dashboard date moves forward.

**Important — deposits:** inflows **do** appear on the bank file (בזכות) and **must** be matched into bank totals. Items that **do not** appear on the bank file (owner-paid, and CC merchant detail once settlement is the bank event) are excluded from Gap so the equation can still close.

---

## 8. Balance equation (for bosses to confirm)

### Suggested definition (v1)

Let:

- **B** = bank balance from the statement (header **היתרה** and/or period-end **היתרה בש״ח** — **choose one**).  
- **O** = Opening bank amount (user-entered), as of date **D₀**.  
- **N** = **Bank-scoped net** for `transaction_date > D₀` through statement end:
  - **Include:** deposits (inflows) + expenses paid from the company / bank path  
  - **Exclude:** **owner-paid** (and resident-paid / other non-bank flags already out of company float, as applicable)  
  - **Credit cards:** count economic CC spend **once** — either merchant CC-verified amounts **or** the bank settlement, not both (see §12; recommendation below)

Then:

> **Gap = B − (O + N)**  
> Success when **|Gap| ≤ tolerance** (e.g. ₪0.01 or ₪1).

### Why exclusions matter (owner-paid + CC + deposits)

- **Deposits** must be in **N** and matched to bank **בזכות** lines — otherwise Gap cannot close.  
- **Owner paid the provider** never hits the operating account → must **not** sit in unmatched-app or in **N**, or Gap will be wrong forever.  
- **CC merchant rows** do not appear one-for-one on the bank Excel; only the **settlement debit** does. Without a rule, either Gap breaks or spend is counted twice.

### Open product choices (need confirmation)

1. Does success Gap use only **bank-verified** rows in **N**, or all bank-scoped rows in the period?  
   - *Recommendation:* show both; success uses verified (plus explicit exclusions).  
2. Is **B** the file header **היתרה**, last row **היתרה בש״ח**, or balance on a chosen date?  
3. Company operating account only for v1? (*Recommendation: yes.*)  

### Why opening balance matters

Without **O**, a correct books state still shows a large Gap equal to the pre-SimplifAI bank balance. Opening balance makes “Gap → 0” achievable on day one.

---

## 9. Marking transactions as verified (+ אסמכתא)

### Proposal

Add a clear **verification state** on each deposit/expense:

- **Unverified** (default for new bank-scoped manual/PDF/ledger entries)  
- **Verified** (matched to a bank line, or go-live baseline)  
- **CC-pending / CC-verified / CC bank-confirmed** (card path — see §12)  
- **Excluded from bank reconcile**: **owner-paid**, rental-only, resident-paid, or other non-bank — so they don’t pollute unmatched lists or Gap **N**

### Required: attach bank אסמכתא on verify

When a transaction becomes **Verified**, persist the bank line’s **אסמכתא** on that transaction and show it in the UI.

| Field (conceptual) | Source | Purpose |
|--------------------|--------|---------|
| `transaction_ref` | SimplifAI (assigned at create) | **Our unique id** for the row (“SimplifAI אסמכתא”) — always unique |
| `bank_verified_at` | System | When verified |
| `bank_asmachta` | Bank column **אסמכתא** | Bank’s statement id on the verified tx (may repeat across bank lines) |
| Optional: bank date, amount side, short description | Same bank line | Audit / display |

**Why both ids:**

- Bank **אסמכתא** answers “which bank statement line confirmed this?” and is what the client sees on the bank Excel.  
- Our **transaction ref** answers “which SimplifAI row is this?” even when bank אסמכתא is missing, duplicated, or not yet verified.

**Matching:** prefer exact bank **אסמכתא** when the app row already has one; after verify, even amount/date matches get the bank’s אסמכתא written onto them. Identity of the *app* row is always `transaction_ref` (and UUID), never bank אסמכתא alone.

**Uniqueness caveat (from sample file):** in `Bank Account example.xlsx`, bank אסמכתא is present on every line but **not always unique** (40 rows → 37 distinct values; e.g. `99012` repeats). Therefore:

- Always **store bank אסמכתא** on the verified transaction (product requirement).  
- Always assign **`transaction_ref`** at create time (unique in the system).  
- For bank-line match identity, use a **composite fingerprint** such as `(date, amount, asmachta, debit|credit)` or a row hash — not bank אסמכתא alone.  
- UI shows both: **Ref** (ours) always; **אסמכתא** (bank) when verified.

### SimplifAI transaction ref (“our אסמכתא”)

Every deposit and expense gets a human-usable unique reference when created (manual, upload, or import).

| Requirement | Notes |
|-------------|--------|
| Unique | Globally unique across deposits + expenses (or unique per kind with a prefix) |
| Stable | Never reused; survives edits; kept on soft-delete if we add it later |
| Readable | Short enough to say on a call / search in the UI (not only a UUID) |
| Visible | Shown on Transactions table, detail panel, export CSV, and reconcile screens |
| Assigned at create | Including Add expense / Add deposit / PDF confirm / imports |

**Format options (pick at implementation):**

- Prefixed opaque id: `TX-A7K2M9`, `DEP-…` / `EXP-…`  
- Or date-based: `20260708-0042` (still must guarantee uniqueness)  
- UUID remains the internal primary key; **transaction_ref** is the operational identifier.

**Not the same as:** existing `import_key` (idempotency for Excel re-import) or deposit `reference` (free-text / pre-verify receipt notes). Those can remain; `transaction_ref` is the product-facing unique id.

### How verification is set

| Action | Result |
|--------|--------|
| Auto-match + user confirm | Verified + **bank אסמכתא attached** (transaction_ref unchanged) |
| Manual “Link to bank line” | Verified + **bank אסמכתא attached** |
| Manual “Mark verified” without a bank line | Blocked in v1 — verification must carry a bank אסמכתא |
| Unmatch / undo | Back to Unverified; clear bank אסמכתא (keep history in audit if needed) |
| Bank upload creates brand-new tx (true missing) | Created with **new transaction_ref** + Verified + bank אסמכתא |

Display on Transactions:

- Always: **Ref** (`transaction_ref`)  
- Badge: Verified | Unverified | Excluded  
- When verified: **אסמכתא** (bank)  
- Filters / search: by Ref, by bank אסמכתא, Unverified only  

---

## 10. Bank upload behavior redesign

### Today → Tomorrow

| Today | Tomorrow |
|-------|----------|
| Bank row → draft Add/Ignore | Bank row → **Match** / **Add missing** / **Ignore (with reason)** |
| Duplicate warning feels like a problem | Match is the **success** path |
| Confirm often creates more rows | Confirm primarily **links** and sets **Verified** |
| Balance column unused | Balance column drives **B** and Gap |

### Matching rules (v1 suggestion)

Reuse and tighten current duplicate heuristics:

- Same amount  
- Date within ±N days (keep 3 or tighten to 1–2 for bank)  
- Prefer exact **אסמכתא / reference**  
- Description / merchant overlap as secondary score  
- Prefer unverified **bank-scoped** app txs first  
- **Skip** owner-paid / excluded and **paid-by-card merchant** rows (those use CC reconcile + settlement group)  
- Detect CC settlement bank lines (e.g. `לאומי מאסטרקרד`) → link to **CC group**, not a single merchant expense  

One bank line ↔ one app transaction in v1 for normal cash rows (CC settlement is the group case).

### Session output UI (sketch)

1. Summary cards: Matched / Unmatched bank / Unmatched app / Gap  
2. Tables for each bucket with actions  
3. Opening balance editor (if missing or wrong)  
4. “Complete reconcile” enabled only when Gap ≈ 0 **or** user explicitly accepts remaining exceptions  

---

## 11. Owner-paid (and other non-bank expenses)

### Problem (from Zoom)

Sometimes the **owner pays the service provider directly**. That expense is real for property books, but it **must not be calculated into the bank total** / bank reconcile Gap, and it should **not** be expected to appear on the bank Excel.

### Product rules

| Rule | Behavior |
|------|----------|
| Entry | Flag expense as **owner-paid** (existing `paid_by_owner` / Method as today, plus clear UI) |
| Bank match | **Out of scope** — do not list as “unmatched app” for bank reconcile |
| Gap / **N** | **Excluded** from bank-scoped net |
| Property float / reports | May still show for owner/property views (same as today’s company-float exclusions) |
| Verification | Mark **Excluded from bank reconcile** (or “non-bank”) — not “waiting for bank” |

Same idea may apply to **resident-paid (He/She)** and other lanes already outside company float — bank reconcile should reuse that boundary so she is not alerted to “missing from bank” for money that never went through the company account.

---

## 12. Credit cards — two-stage verification (Zoom-agreed direction)

**Agreed flow** (replaces the older A/B/C menu):

### Stage A — Collect receipts flagged “paid by card”

1. Daily: she adds expenses (manual / PDF) and marks them **paid by card**.  
2. Those rows are **not** expected as individual bank debits.  
3. Status: **CC-pending** (unverified against card statement).

### Stage B — Credit card Excel = ground truth for merchant lines

1. Upload credit-card Excel (merchant detail).  
2. System matches CC-pending app rows to CC file lines (date, amount, merchant).  
3. Matches → **CC-verified** (card statement confirmed the receipt).  
4. Unmatched CC file lines / unmatched card-flagged app rows → alerts (high priority, scoped to CC reconcile).

### Stage C — Bank Excel settlement = ground truth for cash leaving the account

1. Bank file includes a debit such as **`לאומי מאסטרקרד`** (CC settlement).  
2. That bank line is **not** matched 1:1 to a single merchant receipt.  
3. Instead it **confirms the group** of **CC-verified** merchant transactions for the relevant **billing / date window**.  
4. Group becomes **bank-confirmed** for that settlement (optional: store settlement **אסמכתא** on the group or on each member).  
5. For **Gap / N**: count CC economic spend **once** — *recommendation:* keep merchant CC amounts in property/ops reporting, but for **bank-scoped Gap** treat the **settlement** as the bank cash event and **do not also add** the sum of merchant lines into **N**.

```text
Receipts (paid by card) ──► CC Excel match ──► CC-verified merchants
                                                    │
Bank: לאומי מאסטרקרד ─────────────────────────────┴──► group confirmed
         │
         └── enters bank balance B (cash out)
```

### What this is *not*

- Uploading CC Excel should **not** blindly create a second full set of expenses if receipts were already entered (same “match = success” idea as bank).  
- Bank CC settlement should **not** look like a duplicate of every merchant expense.

---

## 13. Deposits vs bank total (matching everything up)

**Deposits (inflows)** are first-class in bank reconcile:

- Expected on the bank file as **בזכות** credits.  
- Included in **N** (bank-scoped net).  
- Unmatched deposits after a bank upload → high-priority “app not in bank” (or bank credit not in app).  

**Mechanism so “everything matches” when some app rows never hit the bank:**

| App row type | On bank Excel? | In Gap **N**? | In unmatched-app list? |
|--------------|----------------|---------------|-------------------------|
| Deposit / company expense | Yes (credit/debit) | Yes | Yes if unmatched |
| Owner-paid expense | No | No | No |
| Paid-by-card merchant | No (as individual) | No* (if settlement is the bank event) | No for bank; yes for CC reconcile until CC-verified |
| Bank CC settlement line | Yes (one debit) | Yes as cash event* | Matched to CC **group**, not to one merchant |

\*Exact once-only rule locked in §21.

Without this split, Gap cannot reach 0 even when she did everything right.

**Clarification for bosses:** default assumption is **deposits appear on the bank file as credits** and must be matched. If a specific inflow type never hits the operating account, treat it like owner-paid (**Excluded**), not like a normal deposit — otherwise Gap cannot close.

---

## 14. Opening bank amount — product detail

| Field | Notes |
|-------|--------|
| Amount | Required, ILS |
| As-of date (**D₀**) | Required; usually day before first period she cares about |
| Account | Company operating bank account |
| Note | Optional (“Balance from Leumi on …”) |
| Audit | Who set/changed it and when |

**UX:**

- Prompt on first bank reconcile if missing.  
- Editable under Settings / Bank reconcile header.  
- Changing **O** recalculates Gap (does not rewrite transactions).

**Migration / existing ClientData:**  
At production cutover, set **O** + **D₀**, mark all existing rows ≤ D₀ as Verified (baseline), set last verification date = D₀. New activity after D₀ starts Unverified until bank-confirmed.

---

## 15. Last verification date

| Field | Notes |
|-------|--------|
| Date | Calendar date through which the operating account is considered verified |
| Set at | Go-live cutover (= opening balance as-of **D₀**) |
| Updated when | A bank reconcile session is **completed successfully** (Gap ≈ 0 and no remaining unmatched requiring action — exact rule in §21) |
| Not updated when | Session abandoned; leftovers remain; user only partially matches |

**Dashboard (required in v1, not optional):**

- Show **Last verification date** prominently (e.g. “Bank verified through **DD/MM/YYYY**”).  
- Optional companion metrics: unverified count since that date; open reconcile alerts; current Gap if a session is in progress.  

**Bank reconcile header:** same date + “Verify through …” for the current upload.

---

## 16. High-priority alerts for incomplete verification

When a bank statement is uploaded (or a reconcile session is saved/finished with issues), the system **automatically opens high-priority alerts** so she cannot miss gaps.

| Trigger | Alert (severity: **error** / high) | Cleared when |
|---------|-----------------------------------|--------------|
| Unmatched **bank** line(s) remain | “Bank line(s) not in app” — count + link to reconcile session | Lines matched, added, or explicitly excepted |
| Unmatched **app** transaction(s) in period | “App transaction(s) not in bank” — count + link (**bank-scoped only**; never owner-paid) | Matched, corrected, or explicitly excepted |
| Gap ≠ 0 after she attempts to complete | “Bank balance does not reconcile” — show Gap | Gap within tolerance |
| Unmatched **CC** file lines or unpaid-by-card app rows | “Credit card reconcile incomplete” | Matched or excepted |
| Optional: unverified txs older than N days since last verification | “Unverified activity past due” | Verified or last verification advances past them |

**Behavior notes:**

- Alerts are **automatic** — she should not have to remember to check a reconcile screen.  
- Deep-link into the Bank reconcile session / unmatched lists (same pattern as other alert → Transactions deep links).  
- Dismissing without fixing should be discouraged for these types (or only allow dismiss with an “exception reason” that still audits the leftover).  
- Nav badge / Alerts page already support severity; use **error** for these so they stand out.  

---

## 17. Suggested UI surfaces

1. **Transactions**  
   - Column: **Ref** (`transaction_ref` — our unique id)  
   - Verified / Unverified / Excluded / CC-status badges + filters  
   - Entry flags: **owner-paid**, **paid by card** (clear at Add expense)  
   - Show bank **אסמכתא** on bank-verified rows  
   - Keep Add expense / Add deposit / Import as today for receipts & non-bank files  

2. **Bank reconcile** (new page or strong mode inside Transactions upload)  
   - Upload bank Excel (ground truth for operating account)  
   - Match review for **bank-scoped** rows (deposits + company expenses)  
   - CC settlement lines → confirm **CC date groups** (not 1:1 merchant match)  
   - Owner-paid never appears as unmatched-app  
   - Gap = Bank balance − (Opening + bank-scoped net)  
   - Opening balance + last verification date  
   - Completing with leftovers → auto high-priority alerts  

3. **Credit card reconcile** (mode or sibling flow)  
   - Upload CC Excel  
   - Match **paid-by-card** receipts → CC-verified  
   - Show pending card receipts waiting for next CC file  

4. **Dashboard (v1)**  
   - **Last verification date** (required)  
   - Unverified / CC-pending counts since that date  
   - Open bank-reconcile alert count / Gap hint  

5. **Alerts**  
   - Auto high-priority items for unmatched bank / unmatched app / Gap ≠ 0  
   - CC unmatched (file vs paid-by-card app)  
   - Filterable; deep-link to reconcile  

---

## 18. Data model sketch (implementation later)

Not binding — for feasibility discussion:

- `bank_accounts.opening_balance` + `opening_balance_as_of` (or separate `bank_opening_balances` table)  
- Account- or company-level **`last_verification_date`** (updated on successful reconcile; set at go-live)  
- `deposits` / `expenses`:  
  - **`transaction_ref`** (string, unique, assigned at create — SimplifAI’s own אסמכתא)  
  - `bank_verified_at`, `bank_verified_by`  
  - **`bank_asmachta`** (string — the bank **אסמכתא** attached on verify; not unique by itself)  
  - `bank_match_fingerprint` / `reconcile_session_id`  
  - **`bank_reconcile_exclude`** (owner-paid / non-bank — required for Gap)  
  - **paid-by-card** flag (may reuse `payment_method`) + **`cc_verified_at`**, optional **`cc_settlement_group_id`** / bank settlement fingerprint  
- `bank_reconcile_sessions`: upload id, period, bank_balance_snapshot, opening_used, net_used, gap, status (`in_progress` / `completed` / `completed_with_exceptions`)  
- `bank_reconcile_matches`: session_id, bank_line_fingerprint, **bank_asmachta**, deposit_id or expense_id (and denormalized `transaction_ref`), confidence, user_action  
- `cc_reconcile_sessions` / matches (CC Excel ↔ paid-by-card app rows)  
- `cc_settlement_groups`: billing window + linked bank settlement line + member expense ids  
- Alert keys for reconcile leftovers (e.g. `bank_reconcile:unmatched_bank:{session_id}`, `…:unmatched_app:…`, `…:gap:…`, `cc_reconcile:…`) so they clear when the session is fixed  
- Optional: store raw bank / CC lines so she can reopen a session  

**Go-live helper (ops):** one-shot “cutover” action — set O + D₀, mark all txs ≤ D₀ verified, set last verification date — rather than hand-editing thousands of rows. 

Existing `Expense.reconciled` (ledger column) should **not** be overloaded; keep **bank-verified** + **bank_asmachta** as separate concepts from **transaction_ref**.

Also note: deposits already have a generic `reference` field (sometimes filled from bank import today). Design choice for implementers: either reuse `reference` for bank אסמכתא after verify, or add dedicated `bank_asmachta` so pre-verify receipt notes are not overwritten. **Recommendation:** dedicated `bank_asmachta`, plus separate **`transaction_ref`** for our unique id. Do not overload `import_key` for UI identity.

---

## 19. Phased delivery (proposed)

| Phase | Scope | Outcome |
|-------|--------|---------|
| **P0** | Opening bank amount + **last verification date** on Dashboard; go-live cutover; **transaction_ref**; read bank balance / Gap; **bank-scoped net excludes owner-paid** | She can start production verified; Gap isn’t poisoned by owner-paid |
| **P1** | Bank upload as match/verify; Verified badge; **attach bank אסמכתא**; unmatched lists; **deposits in bank match**; advance last verification date on clean complete | Weekly verification → verification loop works |
| **P2** | **High-priority auto alerts** for unmatched bank / unmatched app / Gap ≠ 0 | She is pushed to fix leftovers |
| **P3** | **Paid-by-card** entry + **CC Excel match → CC-verified**; stop blind duplicate create on CC upload | Card receipts verify against the card file |
| **P4** | Bank **CC settlement → confirm date group**; once-only Gap rule | Settlement confirms the group; no double-count |
| **P5** | Auto-confirm high-confidence matches; polish | Less clicking |
| **P6** | Split one bank line → many txs; richer CC edge cases | Edge cases |

---

## 20. Risks & dependencies

- Matching quality on Hebrew descriptions / missing references.  
- Wrong opening balance → permanent Gap until corrected.  
- Historical ClientData already mixed (ledger + bank + CC) — need a clear “start reconcile from date D₀” story.  
- Property-level float vs company bank: confusing if both called “Balance” — naming must stay distinct (**Company float** vs **Bank balance**).  
- CC billing-window detection (which merchant txs belong to which bank settlement).  
- Tolerance and partial periods (mid-week upload).  

---

## 21. Decisions needed from bosses / client

Please confirm or rewrite:

1. **Equation:** Is `Gap = BankBalance − (Opening + BankScopedNet)` correct, with BankScopedNet including **deposits** and excluding **owner-paid**?  
2. **Net scope:** Verified-only vs all bank-scoped rows for the success check?  
3. **Account scope:** Company operating account only for v1?  
4. **CC Gap once-only:** Confirm Zoom flow — merchant rows out of bank **N**, settlement is the bank cash event; CC Excel verifies merchants; bank settlement confirms the **date group**.  
5. **Duplicates today:** Confirm that “everything duplicated on bank upload” is the desired happy path (= all matched/verified).  
6. **Opening balance + go-live:** Who may edit O / last verification date? Confirm cutover marks **all existing txs ≤ D₀ as Verified**.  
7. **Bank balance (B):** Use file header **היתרה**, **first/latest row’s היתרה בש״ח**, or balance on a chosen date?  
8. **When does last verification date advance?** Only on fully clean session, or also when leftovers are explicitly excepted with a reason?  
9. **Unmatched policy:** Can she “complete” a session with leftovers if she marks exceptions (and do alerts still fire)?  
10. **Bank אסמכתא:** Confirm every bank-verified transaction must store the bank אסמכתא. Confirm composite fingerprint when bank אסמכתא repeats.  
11. **SimplifAI transaction ref:** Confirm every deposit/expense gets our own unique readable id (format preference: `TX-…` vs date-based). Confirm backfill for existing ClientData rows.  
12. **CC detection:** Confirm bank descriptions like `לאומי מאסטרקרד` identify settlement lines that confirm a CC group.  
13. **Owner-paid:** Confirm excluded from bank match lists and Gap **N** (still visible on property/owner views).  
14. **Alerts:** Confirm severity = error/high for unmatched bank, unmatched app, Gap ≠ 0, and CC unmatched; confirm dismiss rules.  

---

## 22. Success criteria (after build)

- At production cutover she can set balance + files, start with **everything verified**, and see **last verification date** on the Dashboard.  
- She works **verification → verification**: after each clean bank reconcile, the date advances.  
- Weekly bank Excel upload mostly **verifies** existing rows instead of creating duplicates.  
- **Deposits** match bank credits and count in Gap; **owner-paid** never breaks Gap or unmatched-app.  
- **Paid-by-card** receipts verify on CC Excel upload; bank CC settlement confirms that **date group** without double-counting.  
- Each transaction has a **unique SimplifAI ref**; bank-verified rows also show **bank אסמכתא**.  
- Missing pieces on either side (app or bank / CC) create **high-priority alerts** automatically until resolved.  
- After a good week: Gap ≈ 0 and unmatched lists empty (or explicitly excepted).  

---

## 23. Appendix A — Excel file structures (inspected)

Source folder: `data/ClientData/`.

### 23.1 `Bank Account example.xlsx` (Leumi account movements)

| | |
|--|--|
| Sheet name (sample) | `תנועות בחשבון 9_7_2026 (1)` |
| Print / save date | `תאריך שמירה/הדפסה: 9/7/2026` |
| **Account snapshot header** | Labels `היתרה` / `מסגרת האשראי` / `נכון לתאריך` → values **114834.88** / **0** / **09.07.26** |
| Movement table title | `תנועות בחשבון` |
| Header row | `תאריך`, `תאריך ערך`, `תיאור`, **`אסמכתא`**, `בחובה`, `בזכות`, **`היתרה בש"ח`**, `תאור מורחב`, `הערה` |
| Sample size | ~40 movement rows in this file |

**How to read a bank line**

- **בחובה** = debit (money out) → expense side of reconcile.  
- **בזכות** = credit (money in) → deposit side. Sample often uses `0` as placeholder (treat 0 as empty).  
- **אסמכתא** = bank reference id to attach on verify (e.g. `206937`, `773848`). Present on all sample rows; **37 unique / 40 rows** (not globally unique).  
- **היתרה בש״ח** = running balance after that row (not zero).  
- **תיאור** = short type (`העברה דיגיטל`, `הע. אינטרנט`, `בנק הפועלים`, **`לאומי מאסטרקרד`**, …).  
- **תאור מורחב** = long text (payee, account numbers, property hints) — useful for matching.

**CC settlement signal in this file:** rows with description **`לאומי מאסטרקרד`** (debit) — candidates for “do not double-count with credit-card merchant expenses.”

**Implication for Gap / opening balance:** the file exposes (1) header snapshot **היתרה** and (2) per-row **היתרה בש״ח**. Design must pick which drives **B** (§21.7). Opening amount **O** remains required so Gap can start at 0 when history predates SimplifAI.

### 23.2 `credit card 1 example.xlsx` (Leumi Mastercard detail)

| | |
|--|--|
| Sheet name (sample) | `BankLeumi 9_7_2026` |
| Card banner | `פרוט עסקאות לכרטיס לאומי מסטרקארד 6947` |
| Period | `לתקופה: יולי 2026` |
| Section | `עסקאות בש"ח במועד החיוב` |
| Header row | `תאריך העסקה`, `שם בית העסק`, `סכום העסקה`, `סוג העסקה`, `פרטים`, **`סכום חיוב`** |
| Sample size | ~11 merchant rows + total row |

**How to read a CC line**

- **No אסמכתא column** on the CC file.  
- **סכום חיוב** posts to the card (positive charge; negative = credit/refund, e.g. `-5.52`).  
- Footer: `סה"כ:` + period total (sample **5115.95**).  
- These are **merchant-level** charges; the **bank** later shows **`לאומי מאסטרקרד`** debit(s) when the card is settled.

**Implication:** CC Excel details card spend; bank Excel verifies cash leaving the operating account. Reconcile rules must treat them differently so net is not doubled.

### 23.3 What we already parse today

`statement_import.py` / `client_import.py` already read bank columns including **אסמכתא**, debit/credit, description — but **do not** use **היתרה** / **היתרה בש״ח** for Gap, and treat likely matches as “duplicates to ignore” rather than “verify + attach אסמכתא.”

---

## 24. Appendix B — related code today (for engineers)

- Bank statement parse / drafts: `backend/app/services/statement_import.py`  
- Upload analyze/confirm: `backend/app/services/document_import.py`, `POST /api/v1/uploads/*`  
- Duplicate attach: `StatementImportService._attach_duplicates` / `_find_duplicate`  
- Company float rules: `backend/app/services/transaction_filters.py`, `running_balance.py`  
- Transactions UI: `frontend/src/pages/TransactionsPage.tsx`, `TransactionUploadPanel.tsx`  
- Ledger `Expense.reconciled` only (not bank-verified)  
- Sample files: `data/ClientData/Bank Account example.xlsx`, `data/ClientData/credit card 1 example.xlsx`

---

**Next step after approval:** turn §19 phases into tickets with UX mock acceptance criteria, then implement P0 → P1.
