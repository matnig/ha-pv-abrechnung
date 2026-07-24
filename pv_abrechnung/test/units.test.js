'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { isEnergyUnit, unitFactorToKwh } = require('../src/ha/haClient');
const { fromStatistics } = require('../src/billing/resolver');
const { monthPeriod } = require('../src/billing/periods');

test('isEnergyUnit akzeptiert Wh, kWh, MWh (case-insensitiv, getrimmt)', () => {
  for (const u of ['Wh', 'wh', 'kWh', 'KWH', 'MWh', ' kWh ']) assert.ok(isEnergyUnit(u), u);
  for (const u of ['W', 'kW', '%', '', 'V', null]) assert.ok(!isEnergyUnit(u), String(u));
});

test('unitFactorToKwh rechnet auf kWh um', () => {
  assert.strictEqual(unitFactorToKwh('Wh'), 0.001);
  assert.strictEqual(unitFactorToKwh('kWh'), 1);
  assert.strictEqual(unitFactorToKwh('MWh'), 1000);
  assert.strictEqual(unitFactorToKwh('unbekannt'), 1);
});

test('fromStatistics normalisiert Roh-Einheit auf kWh (Wh -> ×0.001)', async () => {
  const ms = (y, m, d) => new Date(y, m, d).getTime();
  const ha = {
    statisticsDuringPeriod: async () => ({
      'sensor.wh': [
        { start: ms(2026, 5, 30), state: 1000000, change: null }, // 1.000.000 Wh
        { start: ms(2026, 6, 1), state: 1100000, change: 100000 }, // +100.000 Wh
        { start: ms(2026, 6, 31), state: 1200000, change: 100000 },
      ],
    }),
  };
  const r = await fromStatistics('sensor.wh', monthPeriod(2026, 6), ha, unitFactorToKwh('Wh'));
  assert.strictEqual(r.kwh, 200); // 200.000 Wh -> 200 kWh
  assert.strictEqual(r.anfang, 1000); // 1.000.000 Wh -> 1000 kWh
  assert.strictEqual(r.ende, 1200);
});

test('meterService normalisiert Poll-Werte in Wh auf kWh', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-unit-'));
  const { pollOnce, loadSnapshots } = require('../src/meter/meterService');
  const config = { meters: [{ id: 'm1', name: 'Wh-Zähler', entityId: 'sensor.wh', role: 'verbrauch' }], virtualMeters: [], meterCfg: {} };
  const gs = (val) => async () => ({ state: val, attributes: { unit_of_measurement: 'Wh' } });

  await pollOnce(config, { now: 0, getState: gs('5000') }); // 5000 Wh = 5 kWh
  await pollOnce(config, { now: 3600000, getState: gs('6000') }); // 6000 Wh = 6 kWh
  const snap = loadSnapshots();
  assert.strictEqual(snap['sensor.wh'].lastEffective, 6);
  assert.strictEqual(snap['sensor.wh'].unit, 'Wh');
  assert.strictEqual(snap['sensor.wh'].unitFactor, 0.001);
});
