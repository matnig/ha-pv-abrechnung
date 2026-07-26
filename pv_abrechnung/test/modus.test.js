'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-modus-'));

const { computeBilling } = require('../src/billing/billing');
const { buildHtml, subject } = require('../src/report/report');
const { loadConfig } = require('../src/config');
const { writeJson } = require('../src/store/store');
const { monthPeriod } = require('../src/billing/periods');

const period = monthPeriod(2026, 6);
const resolved = {
  v1: { meterId: 'v1', name: 'Selbst genutzt', entityId: 'virtual:v1', role: 'lieferung', roleLabel: 'Selbst genutzt', anfang: 100, ende: 600, kwh: 500, source: 'virtual', warnings: [] },
  m2: { meterId: 'm2', name: 'Einspeisung', entityId: 'sensor.feed', role: 'einspeisung', roleLabel: 'Einspeisung', anfang: 0, ende: 300, kwh: 300, source: 'statistics', warnings: [] },
  m3: { meterId: 'm3', name: 'Netzbezug', entityId: 'sensor.grid', role: 'netzbezug', roleLabel: 'Netzbezug', anfang: 0, ende: 200, kwh: 200, source: 'statistics', warnings: [] },
};
const meters = [
  { id: 'm2', name: 'Einspeisung', entityId: 'sensor.feed', role: 'einspeisung' },
  { id: 'm3', name: 'Netzbezug', entityId: 'sensor.grid', role: 'netzbezug' },
];
const virtualMeters = [{ id: 'v1', name: 'Selbst genutzt', role: 'lieferung' }];
const tariffs = { lieferung: 0.22, einspeisung: 0.08, netzbezug: 0.35, netzpreis: 0.37, grundgebuehr: 10, einspeiseManagementJahr: 120, einspeisungAnBetreiber: false };

test('Eigenverbrauch: keine Rechnungssumme, sondern Ersparnis + Einspeiseertrag', () => {
  const cfg = { betriebsmodus: 'eigenverbrauch', meters, virtualMeters, tariffs };
  const b = computeBilling(cfg, resolved, period);
  const t = b.totals;
  assert.strictEqual(t.modus, 'eigenverbrauch');
  // 500 kWh selbst genutzt × 0,37 € = 185 €
  assert.strictEqual(t.ersparnisEigenverbrauch, 185);
  // 300 kWh eingespeist × 0,08 € = 24 €
  assert.strictEqual(t.einspeiseErtrag, 24);
  // Nutzen = 185 + 24
  assert.strictEqual(t.total, 209);
  // 200 kWh Netzbezug × 0,37 € = 74 € eigene Kosten (nur informativ, nicht im Nutzen)
  assert.strictEqual(t.netzkosten, 74);
  // Grundgebühr und Einspeisemanagement gelten nur bei Kundenabrechnung
  assert.strictEqual(t.grundgebuehr, 0);
  assert.strictEqual(t.einspeiseManagement, 0);
  assert.strictEqual(t.eigenStrompreis, 0.37);
});

test('Eigenverbrauch: Zeilen tragen die Bedeutung (ersparnis/ertrag/kosten)', () => {
  const cfg = { betriebsmodus: 'eigenverbrauch', meters, virtualMeters, tariffs };
  const b = computeBilling(cfg, resolved, period);
  const byRole = Object.fromEntries(b.lines.map((l) => [l.role, l]));
  assert.strictEqual(byRole.lieferung.art, 'ersparnis');
  assert.strictEqual(byRole.lieferung.amount, 185);
  assert.match(byRole.lieferung.hinweis, /selbst genutzt/i);
  assert.strictEqual(byRole.einspeisung.art, 'ertrag');
  assert.strictEqual(byRole.netzbezug.art, 'kosten');
});

test('Kundenlieferung bleibt unverändert (Regression)', () => {
  const cfg = { betriebsmodus: 'kundenlieferung', meters, virtualMeters, tariffs };
  const b = computeBilling(cfg, resolved, period);
  const t = b.totals;
  assert.strictEqual(t.modus, 'kundenlieferung');
  // Lieferung 500 × 0,22 = 110; Netzbezug 200 × 0,35 = 70; Einspeisung (Kunde bekommt Vergütung)
  // 300 × 0,08 = 24; + Grundgebühr 10 − Einspeisemanagement 120/12 = 10
  assert.strictEqual(t.total, 110 + 70 + 24 + 10 - 10);
  assert.strictEqual(t.grundgebuehr, 10);
  assert.strictEqual(t.einspeiseManagement, 10);
  assert.strictEqual(t.eigenStrompreis, undefined, 'kein Eigenverbrauchsfeld im Kundenmodus');
});

test('Bericht: Betreff und Summenblock je Modus', () => {
  const mk = (modus) => {
    const b = computeBilling({ betriebsmodus: modus, meters, virtualMeters, tariffs }, resolved, period);
    b.stammdaten = { anlagenName: 'Testanlage', betreiber: 'Betreiber', kunde: 'Kunde XY' };
    b.tariffs = tariffs;
    b.showInfoStats = true;
    return b;
  };
  const eigen = mk('eigenverbrauch');
  const kunde = mk('kundenlieferung');

  assert.match(subject(eigen), /^PV-Anlage Testanlage/, 'ohne Abrechnung kein „PV-Abrechnung"');
  assert.match(subject(kunde), /^PV-Abrechnung Testanlage/);

  const hEigen = buildHtml(eigen);
  assert.match(hEigen, /Nutzen der Anlage im Zeitraum/);
  assert.match(hEigen, /Eingesparter Strombezug/);
  assert.ok(!/<b>Summe<\/b>/.test(hEigen), 'keine Rechnungssumme');
  assert.ok(!hEigen.includes('Kunde XY'), 'Kundendaten werden nicht gedruckt');
  assert.match(hEigen, /PV-Anlagenbericht/);

  const hKunde = buildHtml(kunde);
  assert.match(hKunde, /<b>Summe<\/b>/);
  assert.ok(hKunde.includes('Kunde XY'));
  assert.ok(!/Nutzen der Anlage/.test(hKunde));
});

test('Config: Betriebsmodus wird normalisiert und hat einen sicheren Standard', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-modus2-'));
  writeJson('config.json', { meters: [] });
  assert.strictEqual(loadConfig().betriebsmodus, 'kundenlieferung', 'Bestandskonfigurationen bleiben im Abrechnungsmodus');

  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-modus3-'));
  writeJson('config.json', { meters: [], betriebsmodus: 'eigenverbrauch' });
  assert.strictEqual(loadConfig().betriebsmodus, 'eigenverbrauch');

  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-modus4-'));
  writeJson('config.json', { meters: [], betriebsmodus: 'quatsch' });
  assert.strictEqual(loadConfig().betriebsmodus, 'kundenlieferung', 'unbekannter Wert -> sicherer Standard');
});

test('Akku-Entitätsliste liefert Prozent-Sensoren, keine Energiezähler', () => {
  const { filterBatteryEntities } = require('../src/ha/haClient');
  const states = [
    { entity_id: 'sensor.hausspeicher_soc', state: '64', attributes: { unit_of_measurement: '%', device_class: 'battery', friendly_name: 'Hausspeicher Ladezustand' } },
    { entity_id: 'sensor.akku_ladestand', state: '80', attributes: { unit_of_measurement: '%', friendly_name: 'Akku Ladestand' } },
    { entity_id: 'sensor.handy_battery', state: '55', attributes: { unit_of_measurement: '%', device_class: 'battery', friendly_name: 'Handy Battery' } },
    // darf NICHT erscheinen: Energiezähler und Prozentwerte ohne Akku-Bezug
    { entity_id: 'sensor.pv_ertrag', state: '1234', attributes: { unit_of_measurement: 'kWh', device_class: 'energy', friendly_name: 'PV Ertrag' } },
    { entity_id: 'sensor.speicher_energie', state: '9.8', attributes: { unit_of_measurement: 'kWh', friendly_name: 'Speicher Kapazität' } },
    { entity_id: 'sensor.luftfeuchte', state: '52', attributes: { unit_of_measurement: '%', device_class: 'humidity', friendly_name: 'Luftfeuchte' } },
  ];
  {
    const list = filterBatteryEntities(states);
    const ids = list.map((e) => e.entityId);
    assert.ok(ids.includes('sensor.hausspeicher_soc'), 'device_class battery mit %');
    assert.ok(ids.includes('sensor.akku_ladestand'), 'Name mit Ladestand');
    assert.ok(!ids.includes('sensor.pv_ertrag'), 'Energiezähler gehören nicht in die Akku-Liste');
    assert.ok(!ids.includes('sensor.speicher_energie'), 'kWh-Sensor ist kein Ladestand');
    assert.ok(!ids.includes('sensor.luftfeuchte'), 'Prozent ohne Akku-Bezug wird ausgeschlossen');
    assert.ok(list.every((e) => e.unit === '%'));
  }
});
