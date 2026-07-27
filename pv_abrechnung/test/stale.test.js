'use strict';

// Regressionstest gegen die Fehlalarm-Flut „Wert stand still".
//
// Grundlage sind Messreihen einer echten Anlage über 26 Tage: dort blieben die Zählerstände
// regelmäßig sehr lange konstant, ohne dass etwas defekt war – PV nachts 10-12 h, Netzbezug
// bis 36 h (Akku deckte die Last), Einspeisung bis 42 h (trübes Wetter). Die frühere Prüfung
// „Wert seit X Minuten unverändert" erzeugte daraus 89 Meldungen. Ein Energiezähler zählt nur,
// wenn Energie fließt – Stillstand ist deshalb kein Fehlersignal und wird nicht mehr gemeldet.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-stale-'));

const { processReading } = require('../src/meter/meterProcessor');
const { pollOnce } = require('../src/meter/meterService');

const MIN = 60000;
const types = (r) => r.anomalies.map((a) => a.type);

test('lange konstanter Zählerstand löst keine Meldung aus – auch ohne last_reported', () => {
  const now = 3000 * MIN;
  let state = processReading(null, { raw: 500, now: 0, lastUpdated: 0 }, {}).state;
  // 50 Stunden derselbe Wert, Zeitstempel bleibt alt (so verhalten sich viele Integrationen)
  for (let t = 10 * MIN; t <= now; t += 10 * MIN) {
    const r = processReading(state, { raw: 500, now: t, lastUpdated: 0, lastReported: null }, {});
    state = r.state;
    assert.ok(!types(r).includes('stale'), `keine Stillstand-Meldung (bei Minute ${t / MIN})`);
  }
});

test('nachts stillstehende PV erzeugt keine Meldung (Kernfall der Fehlalarme)', () => {
  // Tagsüber zählt der Zähler, nachts nicht – über mehrere Tage.
  let state = null;
  let raw = 1000;
  let lastUpdated = 0;
  const gemeldet = [];
  for (let stunde = 0; stunde < 24 * 5; stunde++) {
    const t = stunde * 60 * MIN;
    const tages = stunde % 24;
    if (tages >= 8 && tages <= 18) {
      raw += 3; // Ertrag
      lastUpdated = t;
    }
    const r = processReading(state, { raw, now: t, lastUpdated, lastReported: null }, {});
    state = r.state;
    for (const a of r.anomalies) gemeldet.push(a.type);
  }
  assert.deepStrictEqual([...new Set(gemeldet)], [], `keine Auffälligkeiten erwartet, waren: ${gemeldet}`);
});

test('echte Ausfälle werden weiterhin erkannt: unavailable und Zählerabfall', () => {
  let state = processReading(null, { raw: 500, now: 0, lastUpdated: 0 }, {}).state;
  const un = processReading(state, { raw: 'unavailable', available: false, now: 10 * MIN }, {});
  assert.ok(types(un).includes('unavailable'), 'Sensor nicht verfügbar wird gemeldet');
  const drop = processReading(state, { raw: 0, now: 20 * MIN, lastUpdated: 20 * MIN }, {});
  assert.ok(types(drop).includes('drop_detected'), 'Zählerabfall wird gemeldet');
});

test('Integration: eine Woche Nachtstillstand über pollOnce erzeugt keine Auffälligkeit', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-stale-int-'));
  const config = {
    meters: [
      { id: 'm1', name: 'PV', entityId: 'sensor.pv', role: 'erzeugung' },
      { id: 'm2', name: 'Netzbezug', entityId: 'sensor.grid', role: 'netzbezug' },
    ],
    virtualMeters: [],
    batteries: [],
    meterCfg: {},
  };
  const t0 = Date.UTC(2026, 5, 1, 0, 0, 0);
  let pv = 1000;
  let grid = 500;
  let pvChanged = t0;
  let gridChanged = t0;
  for (let stunde = 0; stunde < 24 * 7; stunde++) {
    const now = t0 + stunde * 3600000;
    const h = new Date(now).getUTCHours();
    if (h >= 8 && h <= 18) {
      pv += 4;
      pvChanged = now;
    } else if (h >= 19 || h <= 5) {
      grid += 0.5; // nachts etwas Bezug
      gridChanged = now;
    }
    const states = {
      'sensor.pv': { state: String(pv), attributes: { unit_of_measurement: 'kWh' }, last_updated: new Date(pvChanged).toISOString() },
      'sensor.grid': { state: String(grid), attributes: { unit_of_measurement: 'kWh' }, last_updated: new Date(gridChanged).toISOString() },
    };
    await pollOnce(config, { now, getState: async (id) => states[id] });
  }
  const snap = require('../src/store/store').readJson('snapshots.json', {});
  for (const id of ['sensor.pv', 'sensor.grid']) {
    const arten = (snap[id].anomalies || []).map((a) => a.type);
    assert.deepStrictEqual([...new Set(arten)], [], `${id} sollte unauffällig sein, war: ${arten}`);
  }
});
