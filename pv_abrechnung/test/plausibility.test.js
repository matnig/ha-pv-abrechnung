'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-plaus-'));

const { checkBalance } = require('../src/meter/plausibility');
const { pollOnce } = require('../src/meter/meterService');

const arten = (f) => f.map((x) => x.type);

// --- Normalfälle: dürfen NICHTS melden -----------------------------------------------------

test('Nacht: alles still -> keine Meldung', () => {
  assert.deepStrictEqual(arten(checkBalance({ erzeugung: 0, einspeisung: 0, netzbezug: 0, verbrauch: 0, akkuKwh: 0, akkuSocProzent: 60 })), []);
});

test('Nacht mit Akku-Entladung: Bezug 0, Verbrauch aus dem Speicher -> keine Meldung', () => {
  const f = checkBalance({ erzeugung: 0, einspeisung: 0, netzbezug: 0, verbrauch: 1.8, akkuKwh: -2.0, akkuSocProzent: 45 });
  assert.deepStrictEqual(arten(f), [], JSON.stringify(f));
});

test('Sonniger Mittag: PV deckt Verbrauch, lädt Akku, speist ein -> keine Meldung', () => {
  const f = checkBalance({ erzeugung: 10, einspeisung: 4, netzbezug: 0, verbrauch: 3, akkuKwh: 3, akkuSocProzent: 80 });
  assert.deepStrictEqual(arten(f), [], JSON.stringify(f));
});

test('Akku-Wandlungsverluste sprengen die Bilanz nicht', () => {
  // 5 kWh rein, nur 4,2 kWh nutzbar gespeichert – 16% Verlust ist normal
  const f = checkBalance({ erzeugung: 5, einspeisung: 0, netzbezug: 0, verbrauch: 0.8, akkuKwh: 4.2, akkuSocProzent: 70 });
  assert.deepStrictEqual(arten(f), [], JSON.stringify(f));
});

test('kleine Mengen (Rauschen) lösen nichts aus', () => {
  const f = checkBalance({ erzeugung: 0, einspeisung: 0.1, netzbezug: 0.1, verbrauch: 0.1, akkuKwh: 0 });
  assert.deepStrictEqual(arten(f), []);
});

// --- Echte Widersprüche: müssen gemeldet werden ---------------------------------------------

test('Einspeisung ohne Quelle (Erzeugung 0, Akku ruht)', () => {
  const f = checkBalance({ erzeugung: 0, einspeisung: 5, netzbezug: 0, verbrauch: 1, akkuKwh: 0, akkuSocProzent: 50 });
  assert.ok(arten(f).includes('bilanz_einspeisung_ohne_quelle'), JSON.stringify(f));
  assert.match(f[0].text, /eingespeist/);
});

test('Erzeugung verschwindet (mit Verbrauchszähler)', () => {
  const f = checkBalance({ erzeugung: 8, einspeisung: 0, netzbezug: 0, verbrauch: 0.5, akkuKwh: 0, akkuSocProzent: 50 });
  assert.ok(arten(f).includes('bilanz_erzeugung_verschwindet'), JSON.stringify(f));
});

test('ohne Verbrauchszähler: PV läuft und trotzdem Netzbezug ist KEIN Widerspruch', () => {
  // Morgens/abends deckt die Erzeugung den Bedarf nicht – der Rest kommt aus dem Netz.
  // An echten Messdaten war das der häufigste Fehlalarm, deshalb wird hier nichts gemeldet.
  const f = checkBalance({ erzeugung: 6, einspeisung: 0, netzbezug: 4, verbrauch: null, akkuKwh: 0, akkuSocProzent: 50 });
  assert.deepStrictEqual(arten(f), [], JSON.stringify(f));
  const klein = checkBalance({ erzeugung: 0.7, einspeisung: 0, netzbezug: 1.7, verbrauch: null, akkuKwh: null });
  assert.deepStrictEqual(arten(klein), [], 'typischer Morgen-Fall');
});

test('Akku lädt ohne Quelle -> Kapazität oder Zähler falsch', () => {
  const f = checkBalance({ erzeugung: 0, einspeisung: 0, netzbezug: 0, verbrauch: 0, akkuKwh: 4, akkuSocProzent: 60 });
  assert.ok(arten(f).includes('bilanz_akku_ohne_quelle'), JSON.stringify(f));
  assert.match(f.find((x) => x.type === 'bilanz_akku_ohne_quelle').text, /Akkukapazität/);
});

test('voller Akku, viel Erzeugung, kein Bezug, aber keine Einspeisung -> Meldung', () => {
  const f = checkBalance({ erzeugung: 6, einspeisung: 0, netzbezug: 0, verbrauch: null, akkuKwh: 0, akkuSocProzent: 100 });
  assert.ok(arten(f).includes('bilanz_kein_export_bei_vollem_akku'), JSON.stringify(f));
});

test('voller Akku, aber gleichzeitig Netzbezug -> keine Meldung (Verbrauch erklärt es)', () => {
  const f = checkBalance({ erzeugung: 4, einspeisung: 0, netzbezug: 2, verbrauch: null, akkuKwh: 0, akkuSocProzent: 100 });
  assert.deepStrictEqual(arten(f), [], JSON.stringify(f));
});

test('gleichzeitig beziehen und einspeisen', () => {
  const f = checkBalance({ erzeugung: 5, einspeisung: 3, netzbezug: 3, verbrauch: 5, akkuKwh: 0 });
  assert.ok(arten(f).includes('bilanz_bezug_und_einspeisung'), JSON.stringify(f));
});

test('Gesamtbilanz geht nicht auf (Zähler falsch skaliert)', () => {
  // Erzeugung viel zu hoch gemeldet (Faktor 10) – Zufluss passt nicht zum Abfluss
  const f = checkBalance({ erzeugung: 50, einspeisung: 2, netzbezug: 1, verbrauch: 3, akkuKwh: 1 });
  assert.ok(arten(f).includes('bilanz_stimmt_nicht'), JSON.stringify(f));
});

// --- Hybrid-Wechselrichter: Akku steckt im Erzeugungszähler --------------------------------

test('Hybrid: Einspeisung aus Akku-Entladung ist erklärt (Entladung im Erzeugungswert enthalten)', () => {
  // Nacht: der AC-Zähler zeigt 3 kWh, die aus dem Akku kommen; eingespeist werden 2 kWh.
  const hybrid = checkBalance({ erzeugung: 3, einspeisung: 2, netzbezug: 0, verbrauch: 1, akkuKwh: -3, akkuSocProzent: 40, akkuImPvZaehler: true });
  assert.deepStrictEqual(arten(hybrid), [], JSON.stringify(hybrid));
});

test('Hybrid: Akku-Ladung wird nicht als fehlende Quelle gemeldet (läuft DC-seitig)', () => {
  const hybrid = checkBalance({ erzeugung: 0, einspeisung: 0, netzbezug: 0, verbrauch: 0, akkuKwh: 4, akkuSocProzent: 60, akkuImPvZaehler: true });
  assert.ok(!arten(hybrid).includes('bilanz_akku_ohne_quelle'), JSON.stringify(hybrid));
  // Ohne Hybrid-Kennzeichnung wäre genau das ein Widerspruch:
  const normal = checkBalance({ erzeugung: 0, einspeisung: 0, netzbezug: 0, verbrauch: 0, akkuKwh: 4, akkuSocProzent: 60 });
  assert.ok(arten(normal).includes('bilanz_akku_ohne_quelle'));
});

test('Hybrid ohne Akku-Angabe: Einspeisung im Rahmen der Erzeugung ist plausibel', () => {
  const f = checkBalance({ erzeugung: 5, einspeisung: 4, netzbezug: 0, verbrauch: 1, akkuKwh: null, akkuImPvZaehler: true });
  assert.deepStrictEqual(arten(f), [], JSON.stringify(f));
});

// --- Integration über pollOnce --------------------------------------------------------------

function ha(states) {
  return async (id) => states[id];
}

test('pollOnce: Akku-Energie aus Ladestand × Kapazität, Widerspruch wird protokolliert', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-plaus-poll-'));
  const config = {
    meters: [
      { id: 'm1', name: 'PV', entityId: 'sensor.pv', role: 'erzeugung' },
      { id: 'm2', name: 'Einspeisung', entityId: 'sensor.feed', role: 'einspeisung' },
      { id: 'm3', name: 'Netzbezug', entityId: 'sensor.grid', role: 'netzbezug' },
    ],
    virtualMeters: [],
    batteries: [{ id: 'b1', name: 'Speicher', entityId: 'sensor.soc', kwh: 10 }],
    meterCfg: {},
  };
  const t0 = Date.now() - 3600000;
  // Basislauf
  let s = { 'sensor.pv': 100, 'sensor.feed': 50, 'sensor.grid': 20, 'sensor.soc': 50 };
  const mk = () => ({
    'sensor.pv': { state: String(s['sensor.pv']), attributes: { unit_of_measurement: 'kWh' } },
    'sensor.feed': { state: String(s['sensor.feed']), attributes: { unit_of_measurement: 'kWh' } },
    'sensor.grid': { state: String(s['sensor.grid']), attributes: { unit_of_measurement: 'kWh' } },
    'sensor.soc': { state: String(s['sensor.soc']), attributes: { unit_of_measurement: '%' } },
  });
  await pollOnce(config, { now: t0, getState: ha(mk()) });

  // 10 Minuten später: 5 kWh eingespeist, aber nichts erzeugt und Akku unverändert -> Widerspruch
  s['sensor.feed'] += 5;
  await pollOnce(config, { now: t0 + 600000, getState: ha(mk()) });

  const snap = require('../src/store/store').readJson('snapshots.json', {});
  const alle = Object.values(snap)
    .filter((e) => e && Array.isArray(e.anomalies))
    .flatMap((e) => e.anomalies);
  const bilanz = alle.filter((a) => String(a.type).startsWith('bilanz_'));
  assert.ok(bilanz.length >= 1, 'Bilanz-Widerspruch muss protokolliert werden: ' + JSON.stringify(alle.map((a) => a.type)));
  assert.ok(bilanz[0].text && bilanz[0].text.length > 40, 'Meldung enthält eine verständliche Erklärung');
});

test('pollOnce: Akku-Zähler haben Vorrang vor der Ladestandsrechnung', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-plaus-poll2-'));
  const config = {
    meters: [
      { id: 'm1', name: 'PV', entityId: 'sensor.pv', role: 'erzeugung' },
      { id: 'm2', name: 'Einspeisung', entityId: 'sensor.feed', role: 'einspeisung' },
      { id: 'm4', name: 'Akku Entladung', entityId: 'sensor.bat_out', role: 'akku_entladen' },
    ],
    virtualMeters: [],
    // Kapazität absichtlich unrealistisch klein: würde die Rechnung über den Ladestand verfälschen
    batteries: [{ id: 'b1', name: 'Speicher', entityId: 'sensor.soc', kwh: 1 }],
    meterCfg: {},
  };
  const t0 = Date.now() - 3600000;
  const s = { 'sensor.pv': 100, 'sensor.feed': 50, 'sensor.bat_out': 10, 'sensor.soc': 50 };
  const mk = () => ({
    'sensor.pv': { state: String(s['sensor.pv']), attributes: { unit_of_measurement: 'kWh' } },
    'sensor.feed': { state: String(s['sensor.feed']), attributes: { unit_of_measurement: 'kWh' } },
    'sensor.bat_out': { state: String(s['sensor.bat_out']), attributes: { unit_of_measurement: 'kWh' } },
    'sensor.soc': { state: String(s['sensor.soc']), attributes: { unit_of_measurement: '%' } },
  });
  await pollOnce(config, { now: t0, getState: ha(mk()) });

  // Akku gibt 4 kWh ab (Zähler), davon gehen 3 kWh ins Netz – laut Zähler plausibel.
  s['sensor.bat_out'] += 4;
  s['sensor.feed'] += 3;
  s['sensor.soc'] = 10;
  await pollOnce(config, { now: t0 + 600000, getState: ha(mk()) });

  const snap = require('../src/store/store').readJson('snapshots.json', {});
  const bilanz = Object.values(snap)
    .filter((e) => e && Array.isArray(e.anomalies))
    .flatMap((e) => e.anomalies)
    .filter((a) => String(a.type).startsWith('bilanz_'));
  assert.deepStrictEqual(bilanz.map((a) => a.type), [], 'mit Akku-Zähler ist der Vorgang erklärt: ' + JSON.stringify(bilanz.map((a) => a.text)));
});

test('pollOnce: dieselbe Art wird höchstens einmal pro Stunde protokolliert', async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-plaus-poll3-'));
  const config = {
    meters: [
      { id: 'm1', name: 'PV', entityId: 'sensor.pv', role: 'erzeugung' },
      { id: 'm2', name: 'Einspeisung', entityId: 'sensor.feed', role: 'einspeisung' },
    ],
    virtualMeters: [],
    batteries: [],
    meterCfg: {},
  };
  const t0 = Date.now() - 7200000;
  const s = { 'sensor.pv': 100, 'sensor.feed': 50 };
  const mk = () => ({
    'sensor.pv': { state: String(s['sensor.pv']), attributes: { unit_of_measurement: 'kWh' } },
    'sensor.feed': { state: String(s['sensor.feed']), attributes: { unit_of_measurement: 'kWh' } },
  });
  await pollOnce(config, { now: t0, getState: ha(mk()) });
  // Vier Intervalle mit demselben Widerspruch
  for (let i = 1; i <= 4; i++) {
    s['sensor.feed'] += 5;
    await pollOnce(config, { now: t0 + i * 600000, getState: ha(mk()) });
  }
  const snap = require('../src/store/store').readJson('snapshots.json', {});
  const bilanz = Object.values(snap)
    .filter((e) => e && Array.isArray(e.anomalies))
    .flatMap((e) => e.anomalies)
    .filter((a) => a.type === 'bilanz_einspeisung_ohne_quelle');
  assert.strictEqual(bilanz.length, 1, `nur eine Meldung pro Stunde, waren ${bilanz.length}`);
});

test('Aufräumen entfernt nur unbewertete Meldungen der genannten Art', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-purge-'));
  const { writeJson, readJson } = require('../src/store/store');
  const reviews = require('../src/review/reviews');
  writeJson('snapshots.json', {
    'sensor.a': {
      anomalies: [
        { type: 'stale', at: 1000, entityId: 'sensor.a', name: 'A' },
        { type: 'stale', at: 2000, entityId: 'sensor.a', name: 'A' },
        { type: 'offline', at: 3000, entityId: 'sensor.a', name: 'A' },
      ],
    },
  });
  // Eine der beiden stale-Meldungen wurde bewertet -> muss erhalten bleiben
  const bewertet = reviews.listAnomalies().find((a) => a.type === 'stale' && a.at === 2000);
  reviews.setReview(bewertet.id, { classification: 'unkritisch', note: 'geprüft', user: { name: 'X' } });

  const r = reviews.purgeUnreviewed(['stale']);
  assert.strictEqual(r.entfernt, 1);
  assert.strictEqual(r.behalten, 1);
  const rest = readJson('snapshots.json', {})['sensor.a'].anomalies.map((a) => `${a.type}@${a.at}`);
  assert.deepStrictEqual(rest, ['stale@2000', 'offline@3000'], 'bewertete und andere Arten bleiben');
});
