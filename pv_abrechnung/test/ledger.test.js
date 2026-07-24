'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ledger-'));
const ledger = require('../src/billing/ledger');

const config = { tariffs: { verbrauch: 0.35 }, recipients: ['kunde@example.com'] };
function billingFor(label, total) {
  return {
    period: { type: 'month', label, start: new Date(2026, 5, 1), end: new Date(2026, 6, 1) },
    lines: [{ name: 'Wohnung', entityId: 's.w', role: 'verbrauch', roleLabel: 'Verbrauch', anfang: 100, ende: 100 + total, kwh: total, tariff: 0.35, amount: total * 0.35 }],
    totals: { total },
  };
}

test('Beleg anhängen + Kette prüfen', () => {
  const e1 = ledger.appendReport(billingFor('Juni 2026', 50), config);
  assert.strictEqual(e1.seq, 1);
  assert.strictEqual(e1.prevHash, '0');
  assert.ok(e1.hash && e1.hash.length === 64);
  const e2 = ledger.appendReport(billingFor('Juli 2026', 60), config);
  assert.strictEqual(e2.seq, 2);
  assert.strictEqual(e2.prevHash, e1.hash); // Hash-Kette
  assert.strictEqual(ledger.verify().ok, true);
});

test('findFinalized liefert den Beleg', () => {
  const f = ledger.findFinalized('month', 'Juni 2026');
  assert.ok(f && f.periodLabel === 'Juni 2026');
});

test('nachträgliche Änderung eines Belegs wird erkannt', () => {
  const file = path.join(process.env.DATA_DIR, 'ledger.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data[0].totals.total = 9999; // manipulieren
  fs.writeFileSync(file, JSON.stringify(data));
  const v = ledger.verify();
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.brokenAt, 1);
});

test('buildEntry erzeugt Beleg ohne zu speichern; commit schreibt', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ledger2-'));
  const draft = ledger.buildEntry(billingFor('Mai 2026', 40), config);
  assert.strictEqual(ledger.load().length, 0); // noch nicht gespeichert
  const committed = ledger.commit(draft);
  assert.strictEqual(ledger.load().length, 1);
  assert.strictEqual(committed.seq, 1);
  assert.strictEqual(ledger.verify().ok, true);
});
