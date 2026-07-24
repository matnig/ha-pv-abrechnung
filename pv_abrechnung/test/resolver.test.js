'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolvePeriodReadings } = require('../src/billing/resolver');
const { monthPeriod } = require('../src/billing/periods');

const config = {
  useStatistics: true,
  meters: [{ id: 'm1', name: 'Wohnung 1', entityId: 'sensor.w1', role: 'verbrauch' }],
  tariffs: { verbrauch: 0.35 },
};
const july = monthPeriod(2026, 6); // 01.07.–01.08.2026

const ms = (y, m, d) => new Date(y, m, d).getTime();

test('Statistics-Pfad: kWh aus change, Anfangs-/Endstand aus state', async () => {
  const ha = {
    statisticsDuringPeriod: async () => ({
      'sensor.w1': [
        { start: ms(2026, 5, 30), state: 1000, sum: 0, change: null }, // Vortag
        { start: ms(2026, 6, 1), state: 1100, sum: 100, change: 100 },
        { start: ms(2026, 6, 31), state: 1200, sum: 200, change: 100 },
      ],
    }),
  };
  const r = await resolvePeriodReadings(config, {}, july, { ha });
  assert.strictEqual(r.m1.source, 'statistics');
  assert.strictEqual(r.m1.anfang, 1000);
  assert.strictEqual(r.m1.ende, 1200);
  assert.strictEqual(r.m1.kwh, 200);
  assert.strictEqual(r.m1.warnings.length, 0);
});

test('Reset im Zeitraum: kWh bleibt reset-sicher, Warnung gesetzt', async () => {
  const ha = {
    statisticsDuringPeriod: async () => ({
      'sensor.w1': [
        { start: ms(2026, 5, 30), state: 1000, change: null },
        { start: ms(2026, 6, 1), state: 50, change: 100 },
        { start: ms(2026, 6, 31), state: 150, change: 100 }, // roher state fällt (Reset), change korrekt
      ],
    }),
  };
  const r = await resolvePeriodReadings(config, {}, july, { ha });
  assert.strictEqual(r.m1.kwh, 200);
  assert.ok(r.m1.warnings.some((w) => /Reset/.test(w)));
});

test('HA nicht erreichbar -> Fallback auf Polling-Snapshots', async () => {
  const ha = { statisticsDuringPeriod: async () => { throw new Error('timeout'); } };
  const snapshots = { 'sensor.w1': { daily: { '2026-06-30': 1000, '2026-07-31': 1200 }, anomalies: [] } };
  const r = await resolvePeriodReadings(config, snapshots, july, { ha });
  assert.strictEqual(r.m1.source, 'poll');
  assert.strictEqual(r.m1.kwh, 200);
  assert.ok(r.m1.warnings.some((w) => /nicht erreichbar/.test(w)));
});

test('keine Statistik-Buckets -> Fallback Polling', async () => {
  const ha = { statisticsDuringPeriod: async () => ({}) };
  const snapshots = { 'sensor.w1': { daily: { '2026-06-30': 500, '2026-07-31': 560 }, anomalies: [] } };
  const r = await resolvePeriodReadings(config, snapshots, july, { ha });
  assert.strictEqual(r.m1.source, 'poll');
  assert.strictEqual(r.m1.kwh, 60);
});

test('useStatistics=false erzwingt Polling', async () => {
  let called = false;
  const ha = { statisticsDuringPeriod: async () => { called = true; return {}; } };
  const snapshots = { 'sensor.w1': { daily: { '2026-06-30': 0, '2026-07-31': 42 }, anomalies: [] } };
  const r = await resolvePeriodReadings({ ...config, useStatistics: false }, snapshots, july, { ha });
  assert.strictEqual(called, false);
  assert.strictEqual(r.m1.kwh, 42);
});
