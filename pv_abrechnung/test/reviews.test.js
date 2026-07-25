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

  // bereits bewertet -> unveränderlich (wirft ALREADY_REVIEWED)
  assert.throws(() => reviews.setReview(target.id, { note: 'x', classification: 'kritisch', user: {} }), /bereits bewertet/i);

  // ungültige Einstufung auf FRISCHER Auffälligkeit -> unkritisch (nur kritisch/unkritisch erlaubt)
  const r2 = reviews.setReview('sensor.z#999#stale', { note: '', classification: 'blah', user: {} });
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

test('Incident-Report inkrementell: markReviewsReported blendet bereits dokumentierte aus', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-inc-rep-'));
  writeJson('snapshots.json', {
    'sensor.a': { anomalies: [{ type: 'stale', at: 100, entityId: 'sensor.a', name: 'A' }] },
    'sensor.b': { anomalies: [{ type: 'offline', at: 200, entityId: 'sensor.b', name: 'B' }] },
  });
  const [a1, a2] = reviews.listAnomalies();
  reviews.setReview(a1.id, { classification: 'kritisch', user: { name: 'X' } });
  reviews.setReview(a2.id, { classification: 'unkritisch', user: { name: 'X' } });

  // erster Versand: beide neu
  let neu = reviews.listAnomalies().filter((a) => a.review && !a.review.reportedAt);
  assert.strictEqual(neu.length, 2);
  reviews.markReviewsReported(neu.map((a) => a.id), 5000);

  // zweiter Versand ohne neue Bewertung: keine neuen mehr
  neu = reviews.listAnomalies().filter((a) => a.review && !a.review.reportedAt);
  assert.strictEqual(neu.length, 0);

  // neue Auffälligkeit hinzufügen + bewerten -> nur diese ist beim nächsten Versand dabei
  const snap = require('../src/store/store').readJson('snapshots.json', {});
  snap['sensor.c'] = { anomalies: [{ type: 'stale', at: 300, entityId: 'sensor.c', name: 'C' }] };
  writeJson('snapshots.json', snap);
  const c = reviews.listAnomalies().find((a) => a.entityId === 'sensor.c');
  reviews.setReview(c.id, { classification: 'kritisch', user: { name: 'X' } });
  neu = reviews.listAnomalies().filter((a) => a.review && !a.review.reportedAt);
  assert.strictEqual(neu.length, 1);
  assert.strictEqual(neu[0].entityId, 'sensor.c');
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

test('listAnomaliesInRange filtert nach Zeitbereich, lässt reportedAt unangetastet', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-range-'));
  writeJson('snapshots.json', {
    'sensor.a': { anomalies: [
      { type: 'stale', at: 1000, entityId: 'sensor.a', name: 'A' },
      { type: 'offline', at: 5000, entityId: 'sensor.a', name: 'A' },
      { type: 'reset', at: 9000, entityId: 'sensor.a', name: 'A' },
    ] },
  });
  const inRange = reviews.listAnomaliesInRange(2000, 8000);
  assert.strictEqual(inRange.length, 1);
  assert.strictEqual(inRange[0].type, 'offline');
  // Bereits dokumentierte bleiben im Range-Export enthalten (im Gegensatz zum inkrementellen Versand)
  reviews.setReview(inRange[0].id, { classification: 'kritisch', user: { name: 'X' } });
  reviews.markReviewsReported([inRange[0].id], 6000);
  const again = reviews.listAnomaliesInRange(2000, 8000);
  assert.strictEqual(again.length, 1, 'dokumentierte Einträge bleiben im Zeitraum-Export');
  assert.ok(again[0].review.reportedAt, 'Markierung sichtbar');
  // ... und der inkrementelle Versand sieht sie weiterhin NICHT mehr
  const neu = reviews.listAnomalies().filter((a) => a.review && !a.review.reportedAt);
  assert.strictEqual(neu.length, 0);
});

test('anomaliesCsv: Kopf, Spalten, Bewertung und Excel-taugliches Quoting', () => {
  const csv = reviews.anomaliesCsv(
    [
      { at: 1700000000000, name: 'Zähler "A"', entityId: 'sensor.a', type: 'stale', review: { classification: 'kritisch', note: 'echter; Ausfall', reviewedByName: 'Matteus', reviewedAt: 1700000100000, reportedAt: 1700000200000 } },
      { at: 1700000300000, name: 'B', entityId: 'sensor.b', type: 'offline', review: null },
    ],
    { anlagenName: 'Scharkon', from: 1700000000000, to: 1700001000000, by: 'Matteus' }
  );
  assert.ok(csv.includes('"Anlage";"Scharkon"'));
  assert.ok(csv.includes('Zeitraum'));
  assert.ok(csv.includes('Zeit;Zaehler;EntityId;Typ'), 'Spaltenkopf vorhanden');
  assert.ok(csv.includes('"Zähler ""A"""'), 'Anführungszeichen im Namen korrekt verdoppelt');
  assert.ok(csv.includes('"echter; Ausfall"'), 'Semikolon im Text bleibt in der Zelle');
  assert.ok(csv.includes('"kritisch"') && csv.includes('"nicht bewertet"'));
  assert.ok(csv.split('\r\n').length >= 6, 'CRLF-Zeilen');
});
