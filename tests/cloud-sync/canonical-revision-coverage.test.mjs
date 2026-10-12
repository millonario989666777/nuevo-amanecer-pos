import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// The reload shortcut (status + credit-accounts re-confirm the cached replica) is only sound if
// every change to canonical read data moves the status tuple (mode, promotion_id, authority_epoch,
// revision, financial_revision) or the credit-accounts page. financial_revision counts append-only
// ledgers (readControlSnapshot). This test fails when a Worker write target appears that is not
// classified below, or when a DELETE/UPDATE touches read data: classify it (and bump a ledger in the
// same batch) or make the client fall back to a full read for it.
const SRC = 'tools/cloudflare-lab/src/';
const files = readdirSync(SRC).filter((name) => /^a6-.*\.js$/.test(name));
const source = files.map((name) => readFileSync(SRC + name, 'utf8')).join('\n');

const LEDGER = new Set([
  'canonical_sale_context', 'canonical_financial_operations', 'canonical_expense_operations', 'canonical_product_operations',
  'canonical_inventory_operations', 'canonical_customer_operations', 'canonical_customer_credit_policy_operations',
  'canonical_reconciliation_credits', 'canonical_credit_baseline_adjustments', 'canonical_customer_contacts',
]);
// Written only in the same atomic batch as a ledger row above.
const WITH_LEDGER = new Set([
  'canonical_cash_closures', 'canonical_cash_sessions', 'canonical_financial_events', 'canonical_expenses', 'canonical_credit_installments',
  'canonical_credit_metadata', 'canonical_customer_credit_policies', 'canonical_customer_registry', 'canonical_generic_sale_lines',
  'canonical_inventory_effects', 'canonical_live_customers', 'canonical_live_inventory_effects', 'canonical_live_products',
  'canonical_manual_inventory_movements', 'cash_movements', 'inventory_movements', 'live_credits', 'sale_items', 'sales',
]);
// credit-account.create inserts here WITHOUT a ledger row: the client compares this page itself.
const CHECKED_BY_CLIENT = new Set(['canonical_credit_accounts']);
// Authority control / promotion (moves revision or authority_epoch) and bookkeeping never read by the POS.
const AUTHORITY = new Set(['canonical_control', 'canonical_promotions']);
const BOOKKEEPING = new Set(['canonical_assertions', 'canonical_command_receipts', 'canonical_write_guards']);
const KNOWN = new Set([...LEDGER, ...WITH_LEDGER, ...CHECKED_BY_CLIENT, ...AUTHORITY, ...BOOKKEEPING]);

const targets = (re) => new Set([...source.matchAll(re)].map((m) => m[1]));

test('every canonical INSERT target is classified for the reload shortcut', () => {
  const inserts = targets(/INSERT(?: OR [A-Z]+)? INTO\s+([a-z_]+)/g);
  for (const table of inserts) assert.ok(KNOWN.has(table), `unclassified INSERT target: ${table}`);
  for (const table of LEDGER) if (!['canonical_reconciliation_credits', 'canonical_credit_baseline_adjustments', 'canonical_sale_context'].includes(table)) {
    assert.match(readFileSync(SRC + 'a6-canonical.js', 'utf8'), new RegExp(`'${table}'`), `${table} must be a financial_revision term`);
  }
});

test('no DELETE touches canonical read data; UPDATEs are limited to ledger-batched tables', () => {
  for (const table of targets(/DELETE FROM\s+([a-z_]+)/g)) assert.ok(BOOKKEEPING.has(table), `DELETE on read data: ${table}`);
  const allowedUpdates = new Set(['canonical_control', 'canonical_promotions', 'products', 'canonical_live_products', 'canonical_customer_credit_policies']);
  for (const table of targets(/UPDATE\s+([a-z_]+)\s+SET/g)) assert.ok(allowedUpdates.has(table), `UPDATE without classified ledger batch: ${table}`);
  assert.doesNotMatch(source, /INSERT OR REPLACE INTO|REPLACE INTO|DELETE FROM\s*\$\{/, 'no replace/dynamic delete on canonical data');
  // Dynamic targets are exactly the reviewed ones: promotion import, sale stock and inventory adjust.
  const dynamic = [...source.matchAll(/(?:INSERT INTO|UPDATE)\s*\$\{([a-zA-Z.]+)\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(dynamic, ['effectTable', 'mapped.table', 'productTable', 'stockTable']);
});
