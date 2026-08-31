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

**Ideal outcome when uploading bank Excel:** almost every bank row **matches** an existing transaction and is **marked Verified** (with bank אסמכתא). That must **not** be labeled or treated as a “duplicate.” The word **duplicate** is reserved for **true duplicate app rows** (same money entered twice in SimplifAI), not for “bank line already has a matching receipt.”

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

**Proposal:** opening bank amount + **last verification date** are first-class settings (same cutover moment), **editable by anyone** in v1 (§21b Q5), visible on Dashboard and Bank reconcile. **Gap tolerance** is a separate admin-editable amount (§21b Q7).

---

## 4. Current product gaps (today)

| Area | Today | Gap |
|------|--------|-----|
| Bank upload | Creates/reviews deposit & expense drafts (`source=bank_statement`); soft matches flagged as **duplicates** with default **Ignore** | Wrong UX — soft match must become **Match → Verified**, not “duplicate” |
| Soft match vs bank | Labeled “Duplicate” | After redesign: **Matched / Verified**. “Duplicate” only if two **app** txs are the same real-world spend |
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
12. Keep manual receipt entry as the daily habit on **Transactions**; bank (and CC) work is periodic on the **Verification** tab.

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
| **Reconcile ignore** | Client action (reason required) that clears a bank line or app tx from blocking complete; audited |
| **Reconcile alert** | High-priority alert when a bank/CC upload leaves unmatched rows and/or Gap outside tolerance; dismiss requires exception reason |
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
> Success when **|Gap| ≤ admin gap tolerance** (configurable ILS amount; see §21b Q7).

### Why exclusions matter (owner-paid + CC + deposits)

- **Deposits** must be in **N** and matched to bank **בזכות** lines — otherwise Gap cannot close.  
- **Owner paid the provider** never hits the operating account → must **not** sit in unmatched-app or in **N**, or Gap will be wrong forever.  
- **CC merchant rows** do not appear one-for-one on the bank Excel; only the **settlement debit** does. Without a rule, either Gap breaks or spend is counted twice.

### Locked choices (see §21b)

1. Success Gap uses **verified-only** net; UI also shows **all bank-scoped** net. Client may **manually ignore** a transaction (with reason).  
2. **B** = latest row **היתרה בש״ח** in the uploaded file.  
3. Company operating account only for v1.  

### Why opening balance matters

Without **O**, a correct books state still shows a large Gap equal to the pre-SimplifAI bank balance. Opening balance makes “Gap → 0” achievable on day one.

---

## 9. Marking transactions as verified (+ אסמכתא)

### Proposal

Add a clear **verification state** on each deposit/expense:

- **Unverified** (default for new bank-scoped manual/PDF/ledger entries)  
- **Verified** (matched to a bank line, or go-live baseline)  
- **Ignored (reconcile)** — client manually ignored this row for bank/CC reconcile **with a reason**; does not block clean complete (§21b Q2)  
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

**Format (locked — §21b Q6):** date-based, e.g. `20260708-0042`, uniqueness guaranteed (sequence or suffix). UUID remains the internal primary key; **transaction_ref** is the operational identifier.

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
| Soft match shown as **Duplicate** (feels like a problem) | Soft match shown as **Matched → confirm → Verified** (success path) |
| Confirm often creates more rows | Confirm primarily **links** and sets **Verified** + bank אסמכתא; **does not** create a second copy |
| “Duplicate” used for bank↔app matches | **Duplicate** only for true duplicate **app** transactions (same spend entered twice) |
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

1. Summary cards: Matched / Unmatched bank / Unmatched app / Ignored / Gap  
2. Show **both** nets: all bank-scoped vs verified-only; success uses verified-only (§21b Q2)  
3. Tables for each bucket with actions including **Ignore (reason required)**  
4. Opening balance editor + **gap tolerance** (admin field)  
5. “Complete reconcile” enabled only when every leftover is matched, added, or ignored — **no silent leftovers** (§21b Q4); then last verification date may advance (§21b Q3)

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

\*Exact once-only rule locked in §21a.6.

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
| Who may edit | **Anyone** with app access (v1 — §21b Q5) |
| Gap tolerance | Separate **admin-editable** `gap_tolerance_amount` (ILS) — §21b Q7 |

**UX:**

- Prompt on first bank reconcile if missing.  
- Editable under Settings / Bank reconcile header (same access as anyone for O).  
- Changing **O** recalculates Gap (does not rewrite transactions).  
- Admin (or settings) UI for **minimum Gap tolerance**.  

**Migration / existing ClientData:**  
At production cutover, set **O** + **D₀**, mark all existing rows ≤ D₀ as Verified (baseline, **no bank אסמכתא required** — §21b Q8), set last verification date = D₀. New activity after D₀ starts Unverified until bank-confirmed.

---

## 15. Last verification date

| Field | Notes |
|-------|--------|
| Date | Calendar date through which the operating account is considered verified |
| Set at | Go-live cutover (= opening balance as-of **D₀**) |
| Updated when | Session is **completed**: every in-scope bank line and bank-scoped app row is matched, added, or **ignored/excepted with reason**, and **|Gap| ≤ admin tolerance** (§21b Q3–Q4, Q7) |
| Not updated when | Session abandoned; any leftover still unresolved (not ignored) |

**Dashboard (required in v1, not optional):**

- Show **Last verification date** prominently (e.g. “Bank verified through **DD/MM/YYYY**”).  
- Optional companion metrics: unverified count since that date; open reconcile alerts; current Gap if a session is in progress.  
- Show both **verified net** and **all bank-scoped net** when Gap is displayed (§21b Q2).  

**Bank reconcile header:** same date + “Verify through …” for the current upload.

---

## 16. High-priority alerts for incomplete verification

When a bank statement is uploaded (or a reconcile session is saved/finished with issues), the system **automatically opens high-priority alerts** so she cannot miss gaps.

| Trigger | Alert (severity: **error** / high) | Cleared when |
|---------|-----------------------------------|--------------|
| Unmatched **bank** line(s) remain | “Bank line(s) not in app” — count + link to reconcile session | Lines matched, added, or **ignored with reason** |
| Unmatched **app** transaction(s) in period | “App transaction(s) not in bank” — count + link (**bank-scoped only**; never owner-paid) | Matched, corrected, or **ignored with reason** |
| Gap ≠ 0 after she attempts to complete | “Bank balance does not reconcile” — show Gap | **|Gap| ≤ admin tolerance** |
| Unmatched **CC** file lines or unpaid-by-card app rows | “Credit card reconcile incomplete” | Matched or ignored with reason |
| Optional: unverified txs older than N days since last verification | “Unverified activity past due” | Verified or last verification advances past them |

**Behavior notes:**

- Alerts are **automatic** — she should not have to remember to check a reconcile screen.  
- Deep-link into the Bank reconcile session / unmatched lists (same pattern as other alert → Transactions deep links).  
- **Dismiss only with an exception reason** (audited) — §21b Q9.  
- Nav badge / Alerts page already support severity; use **error** for these so they stand out.  

---

## 17. Suggested UI surfaces

1. **Transactions**  
   - Daily habit: Add expense / Add deposit / Import receipts & non-bank files  
   - Column: **Ref**; Verified / Unverified / Excluded / CC-status badges + filters  
   - Show bank **אסמכתא** on bank-verified rows  
   - Does **not** host the bank reconcile workspace  

2. **Verification** (**dedicated nav tab** — required end state)  
   - Route e.g. `/verification` with its own top-nav label **Verification**  
   - Opening bank amount, last verification date, gap tolerance, go-live cutover  
   - Upload **bank Excel** (ground truth) → Matched / Unmatched / Ignore / Gap / Complete  
   - Match review for **bank-scoped** rows (deposits + company expenses)  
   - CC settlement lines → confirm **CC date groups**  
   - Credit-card Excel match (section or sub-mode on the same tab)  
   - Owner-paid never appears as unmatched-app  
   - Gap = Bank balance − (Opening + bank-scoped net); show verified vs all nets  
   - **B** = latest row היתרה בש״ח; Gap within **admin tolerance**  
   - Complete only when nothing unresolved remains; then advance date  
   - Alerts deep-link here  

3. **Settings / admin** (optional later)  
   - Gap tolerance / rare ops may also live under Verification for v1  

4. **Dashboard**  
   - Summary only: **Last verification date**, unverified count, open reconcile alerts / Gap hint  
   - CTA → **Verification** tab (not a second full reconcile UI)  

5. **Alerts**  
   - Auto high-priority items for unmatched bank / unmatched app / Gap ≠ 0 / CC unmatched  
   - Dismiss only with exception reason  
   - Deep-link to **Verification** session  

---

## 18. Data model sketch (implementation later)

Not binding — for feasibility discussion:

- `bank_accounts.opening_balance` + `opening_balance_as_of` (or separate `bank_opening_balances` table)  
- Account- or company-level **`last_verification_date`** (updated on successful reconcile; set at go-live)  
- Company/settings **`gap_tolerance_amount`** (ILS, admin-editable — §21b Q7)  
- `deposits` / `expenses`:  
  - **`transaction_ref`** (string, unique, **date-based** e.g. `20260708-0042`, assigned at create)  
  - `bank_verified_at`, `bank_verified_by`  
  - **`bank_asmachta`** (string — the bank **אסמכתא** attached on verify; nullable for cutover baseline — §21b Q8)  
  - `bank_match_fingerprint` / `reconcile_session_id`  
  - **`bank_reconcile_exclude`** (owner-paid / non-bank — required for Gap)  
  - reconcile **ignore** metadata when ignored in a session (reason, who, when) — or store on session line items  
  - **paid-by-card** flag (may reuse `payment_method`) + **`cc_verified_at`**, optional **`cc_settlement_group_id`** / bank settlement fingerprint  
- `bank_reconcile_sessions`: upload id, period, **bank_balance_B** (from latest row היתרה בש״ח), opening_used, verified_net, all_scoped_net, gap, tolerance_used, status (`in_progress` / `completed`)  
- `bank_reconcile_matches` / line actions: session_id, bank_line_fingerprint, **bank_asmachta**, deposit_id or expense_id, confidence, user_action (`match` | `add` | `ignore`), **ignore_reason**  
- `cc_reconcile_sessions` / matches (CC Excel ↔ paid-by-card app rows)  
- `cc_settlement_groups`: billing window + linked bank settlement line + member expense ids  
- Alert keys for reconcile leftovers; dismiss requires **exception reason** (§21b Q9)  
- Optional: store raw bank / CC lines so she can reopen a session  

**Go-live helper (ops):** one-shot “cutover” action — set O + D₀, mark all txs ≤ D₀ verified, set last verification date — rather than hand-editing thousands of rows. 

Existing `Expense.reconciled` (ledger column) should **not** be overloaded; keep **bank-verified** + **bank_asmachta** as separate concepts from **transaction_ref**.

Also note: deposits already have a generic `reference` field (sometimes filled from bank import today). Design choice for implementers: either reuse `reference` for bank אסמכתא after verify, or add dedicated `bank_asmachta` so pre-verify receipt notes are not overwritten. **Recommendation:** dedicated `bank_asmachta`, plus separate **`transaction_ref`** for our unique id. Do not overload `import_key` for UI identity.

---

## 19. Phased delivery (proposed)

| Phase | Scope | Outcome |
|-------|--------|---------|
| **P0** | Opening bank amount + **last verification date**; go-live cutover; **transaction_ref**; **Verification nav tab** + Gap; **bank-scoped net excludes owner-paid** | She has a Verification home; Gap isn’t poisoned by owner-paid |
| **P1** | Bank upload as match/verify **on Verification**; Verified badge; **attach bank אסמכתא**; unmatched lists; **deposits in bank match**; advance last verification date on clean complete | Weekly verification → verification loop works |
| **P2** | **High-priority auto alerts** for unmatched bank / unmatched app / Gap ≠ 0 (deep-link Verification) | She is pushed to fix leftovers |
| **P3** | **Paid-by-card** entry + **CC Excel match → CC-verified** on Verification; stop blind duplicate create on CC upload | Card receipts verify against the card file |
| **P4** | Bank **CC settlement → confirm date group**; once-only Gap rule | Settlement confirms the group; no double-count |
| **P5** | Auto-confirm high-confidence matches; polish Verification IA | Less clicking |
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

## 21. Agreed product rules vs open questions

### 21a. Agreed (do not re-litigate unless bosses change course)

These are **statements** we will build against:

1. **Gap equation:** `Gap = B − (O + N)` where **N** is bank-scoped net: includes **deposits** and company/bank-path expenses; **excludes owner-paid** (and other existing non-bank float exclusions such as resident-paid / rental-only as applicable).  
2. **Bank Excel is ground truth** for cash that hits the operating account: upload primarily **matches and verifies**, not invents a second copy of every row.  
3. **No “duplicate” UX for bank confirmation:** when a bank line matches an existing app transaction, the UI shows **Matched / Verified**, not Duplicate. Confirming sets **Verified** + stores bank **אסמכתא**. A second app row is **not** created.  
4. **“Duplicate” means true app doubles only:** two (or more) SimplifAI transactions that represent the same real-world spend — not “this already exists because the bank file found it.”  
5. **Owner-paid** stays in property/owner views but is **out** of bank match lists and Gap **N**.  
6. **Credit cards (Zoom):** paid-by-card receipts → CC Excel verifies merchants → bank CC settlement (e.g. lines like `לאומי מאסטרקרד`) confirms that **date group**; count CC cash **once** in bank Gap (settlement as bank event; merchant lines not also in bank **N**).  
7. **Every** deposit/expense gets a unique SimplifAI **`transaction_ref`**; bank-verified rows also store **`bank_asmachta`**. Match identity uses a **composite fingerprint** when bank אסמכתא repeats.  
8. Incomplete bank/CC reconcile (unmatched bank, unmatched bank-scoped app, Gap ≠ 0, unmatched CC) raises **high-priority (error) alerts**.  
9. **v1 account scope:** company **operating account** reconcile (not multi-bank treasury).  
10. Go-live cutover sets **O** + **D₀**, marks existing txs ≤ D₀ as baseline Verified, and sets **last verification date = D₀**.  
11. **Verification is its own nav tab** when the feature is complete — the reconcile workspace (settings, bank/CC upload, match, Gap) lives there; Dashboard only summarizes and links in.

### 21b. Decisions locked (answered 2026-08-31)

| # | Decision |
|---|----------|
| **Q1** | **B** = **latest row** **היתרה בש״ח** in the uploaded bank Excel. |
| **Q2** | UI shows **both** nets (all bank-scoped vs verified-only); **success / clean complete uses verified-only net**. Client can **manually ignore** a transaction (with reason) so it no longer blocks match lists / clean complete — ignored rows are treated like an explicit exception for that session (and audited). |
| **Q3** | **Last verification date may advance** after a completed session even if some leftovers were **ignored/excepted with a reason** (not only when the unmatched lists were empty without any ignores). Gap must still be within **admin tolerance**. |
| **Q4** | She **cannot** “complete” a session while unresolved leftovers remain. Everything must be **matched, added, cleared, or explicitly ignored/excepted with a reason** first. (Then Q3 applies for advancing the date.) |
| **Q5** | **Anyone** with access to the app may edit opening bank amount **O** and **last verification date** (v1; tighten roles later if needed). |
| **Q6** | **`transaction_ref` format = date-based** (e.g. `20260708-0042`), uniqueness guaranteed. Backfill existing rows on migrate. |
| **Q7** | Gap “≈ 0” uses an **admin-configurable minimum tolerance amount** (editable setting), not a hard-coded ₪0.01/₪1. Default value at ship TBD (suggest ₪0.01 until admin changes it). |
| **Q8** | Cutover baseline Verified (txs ≤ D₀) **may have no bank אסמכתא** — verified by cutover, not by a bank line. |
| **Q9** | Bank/CC reconcile alerts: **dismiss only with an exception reason** (still audited). |
| **Q10** | No disagreement with §21a recorded. |

### 21c. Implications for build (from Q2–Q4 + Q7)

- **Ignore transaction:** first-class reconcile action (app row and/or bank line) requiring a **reason**; removes it from “blocking unmatched”; does not delete the underlying app tx unless product later says so.  
- **Complete session:** enabled only when every bank line and every bank-scoped app row in scope is matched, added, or ignored/excepted — **no silent leftovers**.  
- **Advance last verification date:** allowed after a completable session where Gap is within **admin tolerance**, including sessions that used ignores/exceptions.  
- **Admin setting:** `gap_tolerance_amount` (ILS) — used wherever Gap ≈ 0 is evaluated.

---

### 21d. Historical question list (answered — kept for audit)

<details>
<summary>Original Q1–Q10 wording</summary>

**Q1.** Which number is bank balance B for Gap? → **(b)** latest row היתרה בש״ח  

**Q2.** For clean complete, which net N? → **(c)** show both, success = verified-only; **plus manual ignore**  

**Q3.** When may last verification date advance? → **(b)** also when leftovers excepted/ignored with reason  

**Q4.** Complete with leftovers remaining? → **(a)** No — must clear or except/ignore everything first  

**Q5.** Who edits O / last verification date? → **(a)** Anyone  

**Q6.** Ref format? → **(b)** Date-based  

**Q7.** Gap tolerance? → **Admin field** for minimum tolerance amount  

**Q8.** Cutover without אסמכתא OK? → **(a)** Yes  

**Q9.** Alert dismiss? → **(a)** Only with exception reason  

**Q10.** Disagree with §21a? → none recorded  

</details>

---

## 22. Success criteria (after build)

- At production cutover she can set balance + files, start with **everything verified**, and see **last verification date** on the Dashboard.  
- She works **verification → verification**: after each clean bank reconcile, the date advances.  
- Weekly bank Excel upload **verifies** existing rows (Matched → Verified); UI must **not** call those matches “duplicates.”  
- **Duplicate** labeling is reserved for true double-entry of the same spend in the app.  
- **Deposits** match bank credits and count in Gap; **owner-paid** never breaks Gap or unmatched-app.  
- **Paid-by-card** receipts verify on CC Excel upload; bank CC settlement confirms that **date group** without double-counting.  
- Each transaction has a **unique SimplifAI ref**; bank-verified rows also show **bank אסמכתא**.  
- Missing pieces on either side (app or bank / CC) create **high-priority alerts** automatically until resolved.  
- After a good week: Gap within **admin tolerance** and unmatched lists empty (or explicitly **ignored** with reason).  

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

**Implication for Gap / opening balance:** **B** is the **latest row’s היתרה בש״ח** (§21b Q1). Header **היתרה** may still be shown for context but does not drive Gap. Opening amount **O** remains required so Gap can start at 0 when history predates SimplifAI.

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
- Verification UI: `frontend/src/pages/VerificationPage.tsx`, `BankVerificationPanel.tsx`, `BankVerificationSummaryCard.tsx`  
- Gap math: `backend/app/services/bank_reconcile_gap.py`, `GET/POST /api/v1/bank-settings/gap|parse-bank-balance`

---

## 25. Implementation plan (small, testable steps)

**How we work:** one step ≈ one PR. After each step you manually test with the checklist, then push. We do **not** jump ahead to CC settlement until bank verify + Gap feel right to you and your bosses.

**Locked build decisions** (from §21a + §21b):

| Topic | Decision |
|-------|----------|
| Gap | `B − (O + N)`; owner-paid out; deposits in |
| **B** | Latest row **היתרה בש״ח** |
| Success **N** | **Verified-only**; UI also shows all bank-scoped |
| Ignore | Client may **manually ignore** a tx/line **with reason** |
| Complete | **No** complete while unresolved leftovers remain |
| Advance date | After complete; allowed when leftovers were ignored/excepted (§21b Q3) |
| Edit O / last verification | **Anyone** (v1) |
| `transaction_ref` | **Date-based** (`YYYYMMDD-####`), backfill |
| Gap tolerance | **Admin-editable** `gap_tolerance_amount` |
| Cutover Verified | **No אסמכתא required** |
| Alert dismiss | **Only with exception reason** |
| Bank match UX | **Matched / Verified**, never “duplicate” |
| **Verification IA** | End state: **Verification is its own app nav tab** (not buried in Transactions upload or only on Dashboard). Dashboard keeps a short summary + deep link. |

---

### Navigation end state (locked)

When bank reconcile is complete, primary chrome includes a dedicated tab, e.g.:

`Dashboard · … · Transactions · **Verification** · Alerts · …`

**Verification tab owns:**

- Opening bank amount, last verification date, gap tolerance, go-live cutover  
- Bank Excel upload → match / verify / ignore / Gap / complete session  
- Credit-card Excel verify + settlement group confirm (same tab, clear sections or sub-modes)  
- Session leftovers that alerts deep-link into  

**Dashboard owns (summary only):** “Bank verified through …”, unverified count, link **Open Verification**.

**Transactions owns:** daily receipt entry; Ref + Verified badges; not the reconcile workspace.

**Interim (Step 2):** bank settings live on Dashboard until the Verification tab is introduced in **Step 3**.

---

### Step 0 — Freeze shared vision (no code)

**Status: done** (answers recorded in §21b, 2026-08-31).

**Next:** Step 1.

---

### Step 1 — Schema: identity + bank-verify fields

**Status: implemented (pending your manual test + push)**

**Build**

- Add `transaction_ref` (unique, **date-based** `YYYYMMDD-####`) on deposits + expenses; generate on create; backfill migration.  
- Add bank-verify fields (do **not** reuse `Expense.reconciled`): e.g. `bank_verified_at`, `bank_asmachta` (nullable), exclude flags as needed.  
- Add company-level `opening_balance`, `opening_balance_as_of`, `last_verification_date`, and **`gap_tolerance_amount`**.

**You test**

1. Migrate local DB; app still boots.  
2. Create Add expense / Add deposit → each has a visible **Ref**.  
3. Existing rows have refs after backfill (spot-check Transactions).  
4. Company float / Dashboard still behave as before (no Gap UI yet).

**Push when:** refs show in API + Transactions table; no regressions on float.

---

### Step 2 — Opening balance + last verification date (Dashboard interim)

**Status: implemented (pending your manual test + push)**

**Build**

- API to get/set opening bank amount + as-of date + last verification date.  
- **Interim UI on Dashboard:** “Bank verified through …” + opening amount + cutover (until Verification tab exists in Step 3).  
- Simple **go-live cutover** action: set O + D₀, mark all txs with `transaction_date ≤ D₀` as bank-verified (baseline), set last verification = D₀.  
  - For baseline, `bank_asmachta` may be null (“cutover verified”) — product note in UI.

**You test**

1. Set opening balance + D₀.  
2. Run cutover → Dashboard shows last verification = D₀.  
3. Old txs ≤ D₀ show Verified; a new expense after D₀ shows Unverified.  
4. Company float still separate from “Bank verified through”.

**Push when:** cutover is repeatable on a fresh DB / demo data without breaking Transactions.

**Follow-up in Step 3:** move this UI onto the **Verification** tab; leave only a summary card on Dashboard.

---

### Step 3 — Verification tab + bank-scoped Gap (read-only)

**Status: implemented (pending your manual test + push)**

**Build**

- Add top-nav tab **Verification** (`/verification`) — primary home for bank/CC reconcile work (§17).  
- Move opening balance / last verification / gap tolerance / cutover from Dashboard into this tab.  
- Dashboard: keep a compact summary (“Bank verified through …”, unverified count) + link to Verification.  
- Service: compute **N** (bank-scoped net after D₀), parse **B** from a bank Excel upload **without** changing match behavior yet (or paste B manually).  
- Show **Gap = B − (O + N)** on the **Verification** tab.  
- Confirm owner-paid (and existing float exclusions) are **out** of **N**.

**You test**

1. Nav shows **Verification**; settings/cutover work there (not only on Dashboard).  
2. Dashboard summary still accurate and links to the tab.  
3. With known O and a sample bank file, Gap number is explainable on paper.  
4. Toggle/create an owner-paid expense → Gap **does not** move.  
5. Add a company expense / deposit → Gap moves as expected.  
6. Labeling never confuses Gap with company-float Balance.

**Push when:** Verification tab is the place you open for bank work; Gap number trusted with sample file.

---

### Step 4 — Bank upload = match / verify (core loop)

**Status: implemented (pending your manual test + push)**

**Build**

- On the **Verification** tab: reuse parse + duplicate heuristics; high-confidence soft match → **proposed Match** (not “duplicate” / not default Ignore).  
- Reconcile session UI: Matched / Unmatched bank / Unmatched app / Gap.  
- Confirm match → set Verified + store **bank אסמכתא** (composite fingerprint for match identity).  
- Unmatched bank → Add missing (creates tx + Verified + אסמכתא) or **Ignore with reason**.  
- Unmatched app → fix or **Ignore with reason**.  
- Skip owner-paid from unmatched-app.  
- Deposits match credits (בזכות).  
- Show verified net + all-scoped net; **B** from latest היתרה בש״ח; Gap vs **admin tolerance**.  
- Gap **Net through date** defaults to the **earliest** movement date in the uploaded bank Excel.  
- **Complete** only when nothing unresolved remains → advance `last_verification_date`.

**You test (happy path)**

1. Enter a few receipts that exist in the sample bank file.  
2. On **Verification**, upload bank Excel → those rows appear under Matched (not as errors).  
3. Confirm → Verified + אסמכתא on the tx; Ref unchanged.  
4. Gap → ~0; Complete → last verification date advances (Dashboard summary updates).  
5. Re-upload same file → no duplicate expense rows created for already-verified matches.

**You test (unhappy path)**

6. Leave one unmatched bank line **without** ignore → cannot complete.  
7. Ignore that line with a reason → can complete if Gap within tolerance; date may advance.  
8. Unmatched app (company expense not in file) stays visible until matched or ignored.

**Push when:** weekly “verification → verification” works with sample data and feels right in a boss demo.

---

### Step 5 — High-priority reconcile alerts

**Status: implemented (pending your manual test + push)**

**Build**

- Auto-create error alerts for unmatched bank, unmatched app (bank-scoped), Gap ≠ 0.  
- Auto-create error alerts for unmatched CC charges and unmatched paid-by-card app rows.  
- Deep-link to the **Verification** session (not Transactions upload).  
- Clear when fixed.  
- Dismiss requires an **exception reason** (stored on the alert action).

**You test**

1. Incomplete session → Alerts badge shows errors.  
2. Fix matches / Gap on Verification → alerts clear.  
3. Owner-paid never generates “not in bank”.

**Push when:** alerts are noisy enough to notice, not spammy on every partial click.

---

### Step 6 — Paid-by-card entry + CC Excel verify

**Status: implemented (pending your manual test + push)**

**Build**

- Clear **paid by card** on Add expense (use / align `payment_method=credit_card`).  
- CC-pending status; bank reconcile ignores these as individual bank debits.  
- On **Verification** tab: CC upload path **match** existing paid-by-card rows first (same “match = success” mindset); stop default mass create-when-duplicate.  
- Mark **CC-verified**.

**You test**

1. Add two card receipts → CC-pending; Gap/bank unmatched unchanged.  
2. Upload `credit card 1 example.xlsx` on Verification → matches → CC-verified.  
3. Unmatched CC lines still visible.  
4. Re-upload → no duplicate expenses for matched merchants.

**Push when:** card receipts verify against CC file without polluting bank Gap.

---

### Step 7 — Bank CC settlement confirms date group

**Status: implemented (pending your manual test + push)**

**Build**

- On **Verification** (bank session): detect settlement lines (e.g. `לאומי מאסטרקרד`).  
- Link settlement → group of CC-verified txs in the billing window.  
- Bank Gap: settlement is cash event; merchant CC amounts not also in **N**.  
- Optional: store settlement אסמכתא on the group.

**You test**

1. CC-verified merchants for a period; bank file with Mastercard debit.  
2. Settlement matches group; Gap still closes.  
3. Merchant amounts + settlement do not double-count in **N**.

**Push when:** full Zoom CC story works end-to-end on sample files.

---

### Step 8 — Polish (only after Steps 4–7 feel solid)

- Auto-confirm very high-confidence matches.  
- Exception reasons + complete-with-exceptions policy.  
- Search by Ref / אסמכתא; filters.  
- Split one bank line → many txs (if still needed).  
- Polish Verification tab IA (bank vs CC sections) once workflows are stable.

---

### Demo / git cadence (suggested)

| After step | Good demo for bosses |
|------------|----------------------|
| 1 | “Every row has our Ref” |
| 2 | “Verified through date + cutover” (Dashboard interim) |
| **3** | **“Verification tab” + Gap we trust** |
| **4** | **Main vision: bank Excel verifies receipts on Verification** |
| 5 | “Leftovers chase you via Alerts → Verification” |
| 6–7 | “Cards don’t break the bank story” |

**Start here:** Step 7 manual test (Steps 1–7 implemented). Next: **Step 8 (polish)** only after 4–7 feel solid.

**Out of scope until later steps:** multi-bank, OCR perfection, replacing management-ledger import, auto-pay vendors.


