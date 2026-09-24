# Verification & transactions workflow

Small tasks from the agreed plan. Check a box when that piece is done.

Holding bucket: owner **Needs assignment**, property **UNASSIGNED** (not BUFFER).  
Payback is a separate deposit. Finish only when `|gap| ≤ 0.01`.

---

## Phase A — Holding owner/property and required fields

- [x] A1. Add constants for Needs assignment + UNASSIGNED (backend)
- [x] A2. Ensure that owner/property exist on import/startup (same pattern as BUFFER)
- [x] A3. `add_from_bank` assigns UNASSIGNED and sets `needs_review` + `unassigned_bank`
- [x] A4. Session `can_complete` is false while any added row is still on UNASSIGNED
- [x] A5. Backend create/update expense: require date, amount > 0, property
- [x] A6. Backend create/update deposit: require date, amount > 0, property
- [x] A7. Transactions expense form: required owner (filters properties) + property, date, amount
- [x] A8. Transactions deposit form: same required owner + property, date, amount
- [x] A9. Tests for UNASSIGNED assign, blocked complete, and required fields

## Phase B — Edit + payback on Verification

- [x] B1. Add payback fields on deposit (`is_payback`, optional link to original expense)
- [x] B2. Payback tag on Transactions and verification rows
- [x] B3. After Create, bank-added rows show **Edit**
- [x] B4. Edit dialog: owner, property, section/notes, paid-with, payback (credits). Files stay on Transactions until Phase D.
- [x] B5. Unmatched bank credit: **Create** and **Create payback**
- [x] B6. Tests for create + edit + payback

## Phase C — Alerts

- [x] C1. Alert type for unassigned / needs-handling transactions
- [x] C2. Raise one alert per UNASSIGNED transaction
- [x] C3. Clear the alert when the property is no longer UNASSIGNED
- [x] C4. Alert links to Transactions (or open Verification if a period is in progress)
- [x] C5. Tests for alert create/clear

## Phase D — Multiple files

- [ ] D1. `transaction_attachments` table (kind, transaction_id, upload_id, sort)
- [ ] D2. API: list/add/remove attachments on a deposit or expense
- [ ] D3. Keep `receipt_ref` as the first file so old rows still open
- [ ] D4. Transactions create/edit: multi-file picker
- [ ] D5. Transaction table: file count + preview
- [ ] D6. Verification edit dialog: same multi-file picker
- [ ] D7. Tests for attach / list / preview

## Phase E — Diagnostics, merge, He/She & rental

- [ ] E1. Audit bank candidate filters (rental, He/She, owner-paid, `owner_personal`, card)
- [ ] E2. Near-miss hints on “In the app, not on the statement” (amount/date/text)
- [ ] E3. `merge` / `link_to_app` action: bank line wins date, amount, asmachta
- [ ] E4. UI: Merge from bank-only or app-only row
- [ ] E5. Tests: He/She and rental stay out of lists; merge updates the app row

## Phase F — Finish only when balanced

- [ ] F1. `can_complete` also requires `|gap| ≤ 0.01`
- [ ] F2. Remove **Finish anyway**
- [ ] F3. Copy: period is off by ₪X — create a transaction for that amount
- [ ] F4. Tests: finish blocked when gap is off; allowed at 0

## Phase G — Check in the browser

- [ ] G1. Create from bank → UNASSIGNED → alert
- [ ] G2. Edit to a real property → alert clears
- [ ] G3. Payback on a credit
- [ ] G4. Merge a wrong-amount app row
- [ ] G5. Attach more than one file
- [ ] G6. Finish blocked until gap is 0, then finish succeeds
