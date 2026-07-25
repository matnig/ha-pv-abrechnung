'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { weightedRate, rateForExtension, legalNotes, TARIFFS } = require('../src/assess/eeg');
const { evaluate, DEFAULTS } = require('../src/assess/economics');
const { simulate } = require('../src/assess/simulate');

test('weightedRate: anteilig gewichtet über die Schwellen 10/40/100 kW (kein Stufentarif)', () => {
  // 10 kWp -> reine erste Stufe
  assert.strictEqual(weightedRate(10), 0.0778);
  // 20 kWp -> (10 × 7,78 + 10 × 6,73) / 20 = 7,255 ct
  assert.strictEqual(weightedRate(20), 0.0726, 'Mischsatz aus zwei Klassen');
  // 40 kWp -> (10 × 7,78 + 30 × 6,73) / 40 = 6,9925 ct
  assert.strictEqual(weightedRate(40), 0.0699);
  // Volleinspeisung liegt deutlich höher
  assert.ok(weightedRate(10, 'voll') > weightedRate(10, 'ueberschuss'));
  assert.strictEqual(weightedRate(0), 0);
});

test('rateForExtension: Zubau als eigene Anlage fällt in die günstigere Leistungsklasse', () => {
  // Bestand 30 kWp, Zubau 8 kWp, älter als 12 Monate -> eigene Anlage mit 8 kWp
  const eigen = rateForExtension({ addKwp: 8, bestandKwp: 30, zusammenfassen: false });
  // Zusammengefasst wären es 38 kWp -> Mischsatz, also schlechter
  const zusammen = rateForExtension({ addKwp: 8, bestandKwp: 30, zusammenfassen: true });
  assert.ok(eigen.satzBasis > zusammen.satzBasis, 'eigene Anlage = kleinere Klasse = höherer Satz');
  assert.strictEqual(eigen.satzBasis, 0.0778, '8 kWp liegen komplett in der ersten Klasse');
  assert.match(eigen.hinweis, /eigene Anlage/i);
  assert.match(zusammen.hinweis, /zusammengefasst/i);
});

test('rateForExtension: Abschlag für Stunden mit negativem Börsenpreis', () => {
  const r = rateForExtension({ addKwp: 10, negativpreisAbschlagProzent: 8 });
  assert.strictEqual(r.satzBasis, 0.0778);
  assert.strictEqual(r.satzEffektiv, 0.0716, '8% Abschlag');
  const voll = rateForExtension({ addKwp: 10, art: 'voll' });
  assert.strictEqual(voll.negativpreisAbschlagProzent, 15, 'Volleinspeisung ist stärker betroffen');
});

test('rateForExtension: Sätze tragen ihr Gültigkeitsdatum (nicht hart kodiert)', () => {
  const r = rateForExtension({ addKwp: 10 });
  assert.strictEqual(r.gueltigBis, TARIFFS.gueltigBis);
  assert.ok(r.quelle.includes('Bundesnetzagentur'));
});

test('legalNotes: warnt beim Überschreiten der 100-kW-Schwelle und zur 60%-Regel', () => {
  const unter = legalNotes({ bestandKwp: 30, addKwp: 10 });
  assert.ok(!unter.some((n) => /100 kW/.test(n.thema)), 'unter 100 kW keine Direktvermarktungs-Warnung');
  const drueber = legalNotes({ bestandKwp: 95, addKwp: 20 });
  const w = drueber.find((n) => /100 kW/.test(n.thema));
  assert.ok(w && w.schwere === 'warnung');
  assert.ok(drueber.some((n) => /60%/.test(n.text)), '60%-Regel wird als Warnung genannt');
  assert.ok(drueber.some((n) => /Nullsteuersatz/.test(n.text)), 'Umsatzsteuer-Hinweis');
  assert.ok(drueber.some((n) => /getrennt gemessen/i.test(n.text)), 'getrennte Messung');
});

test('evaluate: Ersatzinvestition senkt den Kapitalwert und unterdrückt die mehrdeutige IRR', () => {
  const ohne = evaluate({ invest: 10000, jahresErloesJahr1: 1200, laufzeit: 25, zins: 3, preissteigerung: 2, degradation: 0.4, betriebskosten: 100 });
  const mit = evaluate({
    invest: 10000, jahresErloesJahr1: 1200, laufzeit: 25, zins: 3, preissteigerung: 2, degradation: 0.4, betriebskosten: 100,
    ersatz: [{ jahr: 15, kosten: 3000, was: 'Wechselrichter-Ersatz' }],
  });
  assert.ok(mit.npv < ohne.npv, 'Ersatz mindert den Kapitalwert');
  assert.ok(ohne.irr != null, 'ohne Ersatz ist die IRR eindeutig');
  assert.strictEqual(mit.irr, null, 'mit Ersatz nicht eindeutig -> nicht ausweisen');
  assert.match(mit.irrHinweis, /nicht eindeutig/i);
  assert.strictEqual(mit.ersatzinvestitionen.length, 1);
  const jahr15 = mit.flows.find((f) => f.jahr === 15);
  assert.strictEqual(jahr15.ersatz, 3000, 'Ersatz erscheint im Cashflow des Jahres');
});

test('evaluate: Ersatz ausserhalb der Laufzeit wird ignoriert', () => {
  const r = evaluate({ invest: 1000, jahresErloesJahr1: 200, laufzeit: 10, zins: 3, preissteigerung: 0, degradation: 0, betriebskosten: 0, ersatz: [{ jahr: 15, kosten: 500, was: 'x' }] });
  assert.strictEqual(r.ersatzinvestitionen.length, 0);
  assert.ok(r.irr != null, 'ohne wirksamen Ersatz bleibt die IRR eindeutig');
});

test('simulate: Standby-Verbrauch des Speichers wird bilanziert', () => {
  const ohne = simulate({ generation: [0, 0], consumption: [1, 1], batteryKwh: 10, standbyWatt: 0 });
  const mit = simulate({ generation: [0, 0], consumption: [1, 1], batteryKwh: 10, standbyWatt: 50 });
  assert.strictEqual(mit.speicherStandby, 0.1, '2 × 50 W = 0,1 kWh');
  assert.ok(mit.netzbezug > ohne.netzbezug, 'Standby erhöht den Netzbezug');
  // Ohne Speicher kein Standby
  const keinSpeicher = simulate({ generation: [0], consumption: [1], batteryKwh: 0, standbyWatt: 50 });
  assert.strictEqual(keinSpeicher.speicherStandby, 0);
});

test('Standard-Annahmen entsprechen der Recherche (nominal gerechnet)', () => {
  assert.strictEqual(DEFAULTS.batterieRoundTrip, 85, 'HTW-Messung 83,9% AC-AC');
  assert.strictEqual(DEFAULTS.batterieNutzkapazitaetFaktor, 90);
  assert.strictEqual(DEFAULTS.degradationPv, 0.4);
  assert.strictEqual(DEFAULTS.laufzeitBatterie, 15);
  assert.strictEqual(DEFAULTS.batterieErsatzProzent, 45, 'ISE: 40-50% der Erstinvestition');
  assert.strictEqual(DEFAULTS.betriebskostenPvProKwp, 26, 'ISE: 26 EUR/kWp/a');
  assert.ok(DEFAULTS.kostenPvMarginalProKwp < DEFAULTS.kostenPvProKwp, 'Zubau günstiger als Neuanlage');
});
