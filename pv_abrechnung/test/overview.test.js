'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-ov-'));

const { hourlyDeltas, buildOverview } = require('../src/overview/overview');

test('hourlyDeltas: monotone state-Diffs, Rückwärts/Reset -> 0', () => {
  const rows = [
    { start: 0, state: 100 },
    { start: 3600000, state: 102 }, // +2
    { start: 7200000, state: 101 }, // Rücksprung -> 0
    { start: 10800000, state: 105 }, // +4
  ];
  const d = hourlyDeltas(rows, 1);
  assert.deepStrictEqual(d.map((x) => x.delta), [2, 0, 4]);
});

test('buildOverview: teilt heute/gestern, summiert je Rolle, zählt Sonnenstunden', async () => {
  const now = Date.now();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const t0 = todayStart.getTime();
  const y0 = t0 - 86400000;
  // Erzeugungs-Statistik: gestern 3 Sonnenstunden, heute 2 (Stände so, dass Diffs >0,05 kWh sind)
  const rows = [
    { start: y0 + 9 * 3600000, state: 0 },
    { start: y0 + 10 * 3600000, state: 1 }, // gestern 10h: +1
    { start: y0 + 11 * 3600000, state: 2 }, // gestern 11h: +1
    { start: y0 + 12 * 3600000, state: 3 }, // gestern 12h: +1
    { start: t0 + 9 * 3600000, state: 3 },
    { start: t0 + 10 * 3600000, state: 4 }, // heute 10h: +1
    { start: t0 + 11 * 3600000, state: 5 }, // heute 11h: +1
  ];
  const ha = { statisticsDuringPeriod: async () => ({ 'sensor.pv': rows }) };
  const config = { meters: [{ id: 'm', name: 'PV', entityId: 'sensor.pv', role: 'erzeugung', unit: 'kWh' }], virtualMeters: [] };
  const o = await buildOverview(config, {}, ha);
  assert.ok(o.series.erzeugung, 'Erzeugungs-Serie vorhanden');
  assert.strictEqual(o.series.erzeugung.ydaySum, 3);
  assert.strictEqual(o.series.erzeugung.todaySum, 2);
  assert.strictEqual(o.sunHours.yesterday, 3);
  assert.strictEqual(o.sunHours.today, 2);
  assert.strictEqual(o.summary.meters, 1);
});

test('buildOverview: HA-Fehler -> haError gesetzt, bleibt bedienbar', async () => {
  const ha = { statisticsDuringPeriod: async () => { throw new Error('ha down'); } };
  const config = { meters: [{ id: 'm', name: 'PV', entityId: 'sensor.pv', role: 'erzeugung', unit: 'kWh' }], virtualMeters: [] };
  const o = await buildOverview(config, {}, ha);
  assert.match(o.haError, /ha down/);
  assert.strictEqual(o.series.erzeugung.todaySum, 0);
});
