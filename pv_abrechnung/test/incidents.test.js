'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isoliertes Datenverzeichnis, BEVOR der Store geladen wird.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-inc-'));

const { pollOnce, commitAlert, openIncidents, applySwap } = require('../src/meter/meterService');

const MIN = 60000;
const config = {
  meters: [{ id: 'm1', name: 'Stadtwerke', entityId: 'sensor.sw', role: 'netzbezug' }],
  virtualMeters: [],
  meterCfg: { resetToleranceKwh: 1, recoverToleranceKwh: 1, investigateAfterMinutes: 10, faultAfterMinutes: 120 },
};
const gs = (val) => async () => ({ state: val });

test('Eskalation: 10-Min-Untersuchung und 2-Std-Störung, je genau einmal', async () => {
  await pollOnce(config, { now: 0, getState: gs(150) }); // Basislinie
  let r = await pollOnce(config, { now: 10 * MIN, getState: gs(0) }); // Abfall
  assert.strictEqual(r.alerts.length, 0, 'direkt beim Abfall noch keine Mail');
  assert.strictEqual(openIncidents().length, 1);

  r = await pollOnce(config, { now: 22 * MIN, getState: gs(0) }); // >10 min offen
  assert.strictEqual(r.alerts.length, 1);
  assert.strictEqual(r.alerts[0].kind, 'investigating');
  commitAlert('sensor.sw', 'investigating', 22 * MIN);

  r = await pollOnce(config, { now: 40 * MIN, getState: gs(0) }); // untersuchung schon gemeldet
  assert.strictEqual(r.alerts.length, 0, 'Untersuchungsmail nur einmal');

  r = await pollOnce(config, { now: 130 * MIN, getState: gs(0) }); // >120 min offen
  assert.strictEqual(r.alerts.length, 1);
  assert.strictEqual(r.alerts[0].kind, 'fault');
  commitAlert('sensor.sw', 'fault', 130 * MIN);

  r = await pollOnce(config, { now: 160 * MIN, getState: gs(0) });
  assert.strictEqual(r.alerts.length, 0, 'Störungsmail nur einmal');
});

test('kurzzeitige Störung vor 10 Min -> keine Mail, Störung geschlossen', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-inc2-'));
  await pollOnce(config, { now: 0, getState: gs(150) });
  await pollOnce(config, { now: 3 * MIN, getState: gs(0) }); // Abfall
  const r = await pollOnce(config, { now: 6 * MIN, getState: gs(151) }); // zurück
  assert.strictEqual(r.alerts.length, 0);
  assert.strictEqual(openIncidents().length, 0, 'Störung geschlossen');
});

test('Sensor-Ausfall (unavailable) eskaliert per Mail: 10 Min + 2 Std, Erholung schließt', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-off-'));
  await pollOnce(config, { now: 0, getState: gs(150) });
  let r = await pollOnce(config, { now: 5 * MIN, getState: gs('unavailable') });
  assert.strictEqual(r.alerts.length, 0);
  r = await pollOnce(config, { now: 20 * MIN, getState: gs('unavailable') });
  assert.ok(r.alerts.some((a) => a.kind === 'offline_investigating'));
  commitAlert('sensor.sw', 'offline_investigating', 20 * MIN);
  r = await pollOnce(config, { now: 130 * MIN, getState: gs('unavailable') });
  assert.ok(r.alerts.some((a) => a.kind === 'offline_fault'));
  r = await pollOnce(config, { now: 140 * MIN, getState: gs(151) }); // Erholung
  assert.ok(!r.alerts.some((a) => String(a.kind).startsWith('offline')));
});

test('manueller Zählertausch schließt die Störung und läuft fort', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-inc3-'));
  await pollOnce(config, { now: 0, getState: gs(150) });
  await pollOnce(config, { now: 10 * MIN, getState: gs(0) });
  await pollOnce(config, { now: 20 * MIN, getState: gs(3) }); // neuer Zähler zählt hoch
  assert.strictEqual(openIncidents().length, 1);

  const res = applySwap('sensor.sw', 25 * MIN);
  assert.strictEqual(res.swapped, true);
  assert.strictEqual(res.oldFinal, 150);
  assert.strictEqual(res.state.effective, 153, 'offset 150 + neuer Stand 3');
  assert.strictEqual(openIncidents().length, 0);
});
