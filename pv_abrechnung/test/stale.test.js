'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-stale-'));

const { processReading } = require('../src/meter/meterProcessor');
const { pollOnce } = require('../src/meter/meterService');

const MIN = 60000;
const cfg = { staleMinutes: 180 };
const types = (r) => r.anomalies.map((a) => a.type);

test('stillstehender Zähler mit frischem last_reported -> KEIN stale (Kern-Fehlalarm)', () => {
  const now = 1000 * MIN;
  // Wert seit 10 h unverändert (last_updated alt), Sensor meldet aber laufend (last_reported frisch)
  const prev = processReading(null, { raw: 500, now: now - 600 * MIN, lastUpdated: now - 600 * MIN, lastReported: now - 600 * MIN }, cfg).state;
  const r = processReading(prev, { raw: 500, now, lastUpdated: now - 600 * MIN, lastReported: now - 2 * MIN }, cfg);
  assert.ok(!types(r).includes('stale'), 'lebender Sensor darf nicht als stale gemeldet werden');
});

test('echter Ausfall: auch last_reported alt -> stale, aber nur EINMAL pro Phase', () => {
  const now = 1000 * MIN;
  const prev = processReading(null, { raw: 500, now: now - 600 * MIN, lastUpdated: now - 600 * MIN, lastReported: now - 600 * MIN }, cfg).state;
  const r1 = processReading(prev, { raw: 500, now, lastUpdated: now - 600 * MIN, lastReported: now - 600 * MIN }, cfg);
  assert.ok(types(r1).includes('stale'), 'toter Sensor muss gemeldet werden');

  // gleicher Zustand beim nächsten Poll -> keine Flut neuer Einträge
  const r2 = processReading(r1.state, { raw: 500, now: now + 10 * MIN, lastUpdated: now - 600 * MIN, lastReported: now - 600 * MIN }, cfg);
  assert.ok(!types(r2).includes('stale'), 'stale nur einmal pro Hänge-Phase');

  // Sensor meldet wieder -> Phase beendet, danach erneut meldefähig
  const r3 = processReading(r2.state, { raw: 500, now: now + 20 * MIN, lastUpdated: now - 600 * MIN, lastReported: now + 19 * MIN }, cfg);
  assert.ok(!types(r3).includes('stale'));
  const r4 = processReading(r3.state, { raw: 500, now: now + 900 * MIN, lastUpdated: now - 600 * MIN, lastReported: now + 19 * MIN }, cfg);
  assert.ok(types(r4).includes('stale'), 'neue Hänge-Phase wird wieder gemeldet');
});

test('peersActive: anderer Zähler zählt hoch -> stillstehender Zähler löst keinen Alarm aus', () => {
  const now = 1000 * MIN;
  const prev = processReading(null, { raw: 500, now: now - 600 * MIN, lastUpdated: now - 600 * MIN }, cfg).state;
  // altes HA ohne last_reported: nur last_updated verfügbar und alt
  const alone = processReading(prev, { raw: 500, now, lastUpdated: now - 600 * MIN }, cfg);
  assert.ok(types(alone).includes('stale'), 'ohne Peer-Aktivität weiterhin erkennbar');

  const withPeer = processReading(prev, { raw: 500, now, lastUpdated: now - 600 * MIN, peersActive: true }, cfg);
  assert.ok(!types(withPeer).includes('stale'), 'Einspeisung läuft -> stillstehender Netzbezug ist erklärt');
});

test('Integration: PV speist ein, Netzbezug steht -> keine stale-Auffälligkeit am Netzbezug', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-stale-int-'));
  const config = {
    meters: [
      { id: 'm1', name: 'Einspeisung', entityId: 'sensor.feed', role: 'einspeisung' },
      { id: 'm2', name: 'Netzbezug', entityId: 'sensor.grid', role: 'netzbezug' },
    ],
    virtualMeters: [],
    meterCfg: { staleMinutes: 180 },
  };
  const t0 = Date.now();
  const old = new Date(t0 - 600 * MIN).toISOString();
  // Basislinie
  let feed = 10;
  const states = () => ({
    'sensor.feed': { state: String(feed), attributes: { unit_of_measurement: 'kWh' }, last_updated: old, last_changed: old },
    'sensor.grid': { state: '200', attributes: { unit_of_measurement: 'kWh' }, last_updated: old, last_changed: old },
  });
  await pollOnce(config, { now: t0, getState: async (id) => states()[id] });

  // Einspeisung steigt, Netzbezug bleibt konstant (klassische Mittagssituation)
  feed = 12;
  await pollOnce(config, { now: t0 + 10 * MIN, getState: async (id) => states()[id] });

  const snap = require('../src/store/store').readJson('snapshots.json', {});
  const gridAnoms = (snap['sensor.grid'].anomalies || []).map((a) => a.type);
  assert.ok(!gridAnoms.includes('stale'), `Netzbezug darf nicht stale sein, war: ${gridAnoms.join(',')}`);
});
