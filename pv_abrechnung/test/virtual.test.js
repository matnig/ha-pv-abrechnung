'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolvePeriodReadings } = require('../src/billing/resolver');
const { computeBilling } = require('../src/billing/billing');
const { monthPeriod } = require('../src/billing/periods');

const config = {
  useStatistics: false,
  meters: [
    { id: 'pv', name: 'PV-Erzeugung', entityId: 'sensor.pv', role: 'erzeugung' },
    { id: 'feed', name: 'Einspeisung', entityId: 'sensor.feed', role: 'einspeisung' },
  ],
  virtualMeters: [
    {
      id: 'v1',
      name: 'An Kunde geliefert',
      role: 'lieferung',
      components: [
        { entityId: 'sensor.pv', factor: 1 },
        { entityId: 'sensor.feed', factor: -1 },
      ],
    },
  ],
  tariffs: { lieferung: 0.3, einspeisung: 0.08 },
};
const july = monthPeriod(2026, 6);

// virtueller Verlauf = Erzeugung − Einspeisung, fortlaufend gespeichert
const snapshots = {
  'sensor.pv': { daily: { '2026-06-30': 3000, '2026-07-31': 3800 }, anomalies: [] },
  'sensor.feed': { daily: { '2026-06-30': 1000, '2026-07-31': 1200 }, anomalies: [] },
  'virtual:v1': { daily: { '2026-06-30': 2000, '2026-07-31': 2600 }, anomalies: [] },
};

test('virtueller Zähler „an Kunde geliefert" liefert kWh und Betrag', async () => {
  const resolved = await resolvePeriodReadings(config, snapshots, july, { ha: {} });
  const v = resolved.v1;
  assert.strictEqual(v.source, 'virtual');
  assert.strictEqual(v.anfang, 2000);
  assert.strictEqual(v.ende, 2600);
  assert.strictEqual(v.kwh, 600); // (3800-3000) - (1200-1000) = 800 - 200 = 600

  const billing = computeBilling(config, resolved, july, snapshots);
  const line = billing.lines.find((l) => l.meterId === 'v1');
  assert.strictEqual(line.amount, 180); // 600 * 0.30
  assert.ok(billing.totals.total >= 180 - 16); // inkl. Einspeisungs-Gutschrift
});

test('Zählertausch-Anomalie landet in der Abrechnung (für Mail-Banner)', () => {
  const snapWithSwap = {
    'sensor.pv': {
      daily: { '2026-06-30': 3000, '2026-07-31': 3800 },
      anomalies: [{ type: 'meter_swap', at: new Date(2026, 6, 15).getTime(), name: 'PV-Erzeugung', oldFinal: 3400, newStart: 2 }],
    },
    'sensor.feed': { daily: {}, anomalies: [] },
  };
  const b = computeBilling(config, {}, july, snapWithSwap);
  assert.ok(b.anomalies.some((a) => a.type === 'meter_swap'));
});
