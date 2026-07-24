'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computeBilling } = require('../src/billing/billing');
const { monthPeriod } = require('../src/billing/periods');

const config = {
  meters: [
    { id: 'm1', name: 'Wohnung 1', entityId: 'sensor.w1', role: 'verbrauch' },
    { id: 'm2', name: 'Einspeisung', entityId: 'sensor.feed', role: 'einspeisung' },
  ],
  tariffs: { verbrauch: 0.35, einspeisung: 0.08, grundgebuehr: 5 },
};

// Bereits aufgelöste Periodenwerte (kommen sonst aus resolvePeriodReadings).
const resolved = {
  m1: { meterId: 'm1', name: 'Wohnung 1', entityId: 'sensor.w1', role: 'verbrauch', kwh: 200, anfang: 1000, ende: 1200, source: 'statistics', warnings: [] },
  m2: { meterId: 'm2', name: 'Einspeisung', entityId: 'sensor.feed', role: 'einspeisung', kwh: 150, anfang: 500, ende: 650, source: 'statistics', warnings: [] },
};

test('Tarife: Kosten, Einspeisungs-Gutschrift und Grundgebühr', () => {
  const b = computeBilling(config, resolved, monthPeriod(2026, 6));
  const w1 = b.lines.find((l) => l.entityId === 'sensor.w1');
  const feed = b.lines.find((l) => l.entityId === 'sensor.feed');
  assert.strictEqual(w1.amount, 70); // 200 * 0.35
  assert.strictEqual(feed.amount, -12); // -(150 * 0.08)
  assert.strictEqual(b.totals.total, 63); // 70 - 12 + 5
});

test('fehlende aufgelöste Werte -> kein Absturz, Betrag 0', () => {
  const b = computeBilling(config, {}, monthPeriod(2026, 6));
  assert.strictEqual(b.lines.length, 2);
  assert.strictEqual(b.totals.total, 5); // nur Grundgebühr
  assert.ok(b.lines[0].warnings.length > 0);
});

test('erzeugung ist informativ (kein Geldbetrag)', () => {
  const cfg = { meters: [{ id: 'p', name: 'PV', entityId: 'sensor.pv', role: 'erzeugung' }], tariffs: { grundgebuehr: 0 } };
  const b = computeBilling(cfg, { p: { meterId: 'p', role: 'erzeugung', kwh: 500, warnings: [] } }, monthPeriod(2026, 6));
  assert.strictEqual(b.lines[0].amount, 0);
  assert.strictEqual(b.totals.total, 0);
});
