'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-rev-'));

const { writeJson } = require('../src/store/store');
const reviews = require('../src/review/reviews');
const { loadConfig } = require('../src/config');
const { pollOnce } = require('../src/meter/meterService');

test('listAnomalies sammelt Auffälligkeiten aus Snapshots und blendet _batteries aus', () => {
  writeJson('snapshots.json', {
    'sensor.a': { anomalies: [{ type: 'stale', at: 1000, entityId: 'sensor.a', name: 'Zähler A' }] },
    'sensor.b': { anomalies: [{ type: 'offline', at: 2000, entityId: 'sensor.b', name: 'Zähler B' }] },
    _batteries: [{ entityId: 'sensor.soc', value: 80 }], // muss übersprungen werden
  });
  const list = reviews.listAnomalies();
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].at, 2000, 'neueste zuerst');
  assert.ok(list.every((a) => a.type !== undefined));
});

test('setReview speichert Text, Einstufung und HA-Nutzer/Zeit; attachReviews heftet an', () => {
  const list = reviews.listAnomalies();
  const target = list.find((a) => a.type === 'stale');
  const r = reviews.setReview(target.id, { note: 'nur Nachtruhe', classification: 'unkritisch', user: { id: 'u1', name: 'Matteus' } });
  assert.strictEqual(r.classification, 'unkritisch');
  assert.strictEqual(r.reviewedByName, 'Matteus');
  assert.ok(r.reviewedAt > 0);

  // ungültige Einstufung -> unkritisch (nur kritisch/unkritisch erlaubt)
  const r2 = reviews.setReview(target.id, { note: '', classification: 'blah', user: {} });
  assert.strictEqual(r2.classification, 'unkritisch');
  assert.strictEqual(r2.reviewedByName, 'Unbekannt');

  const attached = reviews.attachReviews([{ type: 'stale', at: 1000, entityId: 'sensor.a', name: 'Zähler A' }]);
  assert.ok(attached[0].review, 'Review wird per stabiler ID zugeordnet');
});

test('kritisch-Einstufung + Incident-Protokoll', () => {
  const list = reviews.listAnomalies();
  const target = list.find((a) => a.type === 'offline');
  reviews.setReview(target.id, { note: 'echter Ausfall', classification: 'kritisch', user: { id: 'u2', name: 'Admin' } });
  const after = reviews.listAnomalies().find((a) => a.type === 'offline');
  assert.strictEqual(after.review.classification, 'kritisch');

  reviews.logIncidentReport({ at: Date.now(), by: 'Admin', count: 2, critical: 1 });
  const proto = reviews.loadProtocol();
  assert.strictEqual(proto.length, 1);
  assert.strictEqual(proto[0].critical, 1);
});

test('Config migriert Alt-Einzelsensor batterySensor -> batteries[]', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-mig-'));
  writeJson('config.json', { meters: [], batterySensor: 'sensor.soc_alt' });
  const cfg = loadConfig();
  assert.strictEqual(cfg.batteries.length, 1);
  assert.strictEqual(cfg.batteries[0].entityId, 'sensor.soc_alt');
});

test('pollOnce liest mehrere Akkus in snap._batteries', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-bat-'));
  const config = {
    meters: [],
    virtualMeters: [],
    batteries: [
      { id: 'b1', name: 'Speicher 1', entityId: 'sensor.soc1' },
      { id: 'b2', name: 'Speicher 2', entityId: 'sensor.soc2' },
    ],
    meterCfg: {},
  };
  const states = { 'sensor.soc1': { state: '80', attributes: { unit_of_measurement: '%' } }, 'sensor.soc2': { state: '55', attributes: { unit_of_measurement: '%' } } };
  await pollOnce(config, { now: Date.now(), getState: async (id) => states[id] });
  const snap = require('../src/store/store').readJson('snapshots.json', {});
  assert.strictEqual((snap._batteries || []).length, 2);
  assert.strictEqual(snap._batteries[0].value, 80);
  assert.strictEqual(snap._batteries[1].value, 55);
});
