'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { detectPerformanceDrop, monthlyGeneration } = require('../src/assess/trend');

const HOUR = 3600000;
// PVGIS-typische Monatswerte je kWp (Summe ≈ 1.020 kWh/kWp)
const SOLL = [25, 40, 75, 110, 130, 135, 135, 115, 85, 55, 28, 20];

/**
 * Baut ein Stundenprofil über n Monate ab einem Startdatum.
 * @param {function} factor  (jahr, monat) => Faktor auf den Sollertrag (1 = genau Soll)
 */
function build(startDate, monate, kwp, factor) {
  const start = new Date(startDate.getFullYear(), startDate.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(start.getFullYear(), start.getMonth() + monate, 1, 0, 0, 0, 0);
  const gen = [];
  for (let ms = start.getTime(); ms < end.getTime(); ms += HOUR) {
    const d = new Date(ms);
    const m = d.getMonth();
    const tage = new Date(d.getFullYear(), m + 1, 0).getDate();
    const bow = Math.max(0, Math.sin(((d.getHours() - 6) / 12) * Math.PI));
    // Tagesbogen so normieren, dass die Monatssumme dem Soll × Faktor entspricht
    const bogenSummeTag = 7.6394; // Summe von sin über 6..18 Uhr
    const proTag = (SOLL[m] * kwp) / tage;
    gen.push((proTag / bogenSummeTag) * bow * factor(d.getFullYear(), m));
  }
  return { gen, startMs: start.getTime() };
}

test('monthlyGeneration gruppiert nach Kalendermonaten und misst die Abdeckung', () => {
  const { gen, startMs } = build(new Date(2026, 0, 1), 3, 10, () => 1);
  const m = monthlyGeneration(gen, startMs);
  assert.strictEqual(m.length, 3);
  assert.strictEqual(m[0].key, '2026-01');
  assert.ok(m.every((x) => x.abdeckung >= 99), 'volle Monate erkannt');
  assert.ok(Math.abs(m[0].kwh - SOLL[0] * 10) < 5, `Januar sollte ~${SOLL[0] * 10} kWh sein, war ${m[0].kwh}`);
});

test('gesunde Anlage: kein Leistungsabfall gemeldet', () => {
  const { gen, startMs } = build(new Date(2026, 0, 1), 6, 10, () => 1);
  const r = detectPerformanceDrop({ generation: gen, startMs, kwp: 10, sollMonatlichKwhPerKwp: SOLL });
  assert.strictEqual(r.ok, true);
  assert.ok(r.befunde.every((b) => b.art === 'ok' || b.art === 'beobachtung'), JSON.stringify(r.befunde.map((b) => b.art)));
  assert.ok(r.monate.every((m) => m.quoteSoll >= 90), 'Quoten nahe 100%');
});

test('anhaltender Einbruch über mehrere Monate wird als Leistungsabfall gemeldet', () => {
  // Ab dem vierten Monat nur noch 55% des Erwartungswerts (z.B. verschmutzte Module / String weg)
  let i = 0;
  const { gen, startMs } = build(new Date(2026, 0, 1), 6, 10, (jahr, monat) => (monat >= 3 ? 0.55 : 1));
  const r = detectPerformanceDrop({ generation: gen, startMs, kwp: 10, sollMonatlichKwhPerKwp: SOLL });
  const befund = r.befunde.find((b) => b.art === 'leistungsabfall');
  assert.ok(befund, 'Leistungsabfall muss erkannt werden: ' + JSON.stringify(r.befunde));
  assert.strictEqual(befund.schwere, 'kritisch', 'bei ~55% ist es kritisch');
  assert.ok(befund.laufend, 'der Rückgang hält bis zum Ende an');
  assert.ok(befund.monate.length >= 3, 'mehrere Monate betroffen');
  assert.match(befund.text, /Verschmutzung/, 'nennt prüfbare Ursachen');
});

test('einzelner schwacher Monat gilt nur als Beobachtung (Wetter)', () => {
  const { gen, startMs } = build(new Date(2026, 0, 1), 6, 10, (jahr, monat) => (monat === 2 ? 0.7 : 1));
  const r = detectPerformanceDrop({ generation: gen, startMs, kwp: 10, sollMonatlichKwhPerKwp: SOLL });
  assert.ok(!r.befunde.some((b) => b.art === 'leistungsabfall'), 'ein Monat ist kein Befund');
  assert.ok(r.befunde.some((b) => b.art === 'beobachtung'), 'wird aber beobachtet');
});

test('schleichender Rückgang wird als Trend erkannt', () => {
  // Von 100% linear auf 75% über 12 Monate
  const { gen, startMs } = build(new Date(2026, 0, 1), 12, 10, (jahr, monat) => 1 - monat * 0.022);
  const r = detectPerformanceDrop({ generation: gen, startMs, kwp: 10, sollMonatlichKwhPerKwp: SOLL });
  assert.ok(r.trend, 'Trend berechnet');
  assert.ok(r.trend.aenderungProzentpunkte <= -10, `Rückgang erwartet, war ${r.trend.aenderungProzentpunkte}`);
  assert.ok(r.befunde.some((b) => b.art === 'trend'), 'Trend-Befund vorhanden');
});

test('Vorjahresvergleich funktioniert ohne PVGIS (nur eigene Daten)', () => {
  // 24 Monate: das zweite Jahr liefert nur 70% des ersten
  const { gen, startMs } = build(new Date(2025, 0, 1), 24, 10, (jahr) => (jahr === 2026 ? 0.7 : 1));
  const r = detectPerformanceDrop({ generation: gen, startMs, kwp: 10, sollMonatlichKwhPerKwp: null });
  assert.ok(r.verfahren.some((v) => /Vorjahres/.test(v)), 'Vorjahresvergleich aktiv');
  assert.ok(r.verfahren.some((v) => /nicht möglich/.test(v)), 'PVGIS-Vergleich fehlt und wird benannt');
  const befund = r.befunde.find((b) => b.art === 'leistungsabfall');
  assert.ok(befund, 'Abfall gegenüber Vorjahr erkannt: ' + JSON.stringify(r.befunde.map((b) => b.art)));
  assert.ok(r.monate.some((m) => m.quoteVorjahr != null && m.quoteVorjahr < 80));
});

test('ohne kWp und ohne PVGIS: klare Aussage statt Rechnung', () => {
  const { gen, startMs } = build(new Date(2026, 0, 1), 4, 10, () => 1);
  const r = detectPerformanceDrop({ generation: gen, startMs, kwp: null, sollMonatlichKwhPerKwp: null });
  assert.ok(r.verfahren.some((v) => /kWp/.test(v)), 'fehlende kWp wird benannt');
  assert.ok(r.befunde.some((b) => b.art === 'ok'), 'kein erfundener Befund');
  assert.match(r.befunde.find((b) => b.art === 'ok').text, /eingeschränkt/i);
});

test('unvollständige Monate werden nicht bewertet', () => {
  const { gen, startMs } = build(new Date(2026, 0, 1), 2, 10, () => 1);
  // nur die erste Hälfte des Januars behalten -> Abdeckung ~50%
  const halb = gen.slice(0, 15 * 24);
  const r = detectPerformanceDrop({ generation: halb, startMs, kwp: 10, sollMonatlichKwhPerKwp: SOLL });
  assert.strictEqual(r.ok, false, 'kein vollständiger Monat -> keine Bewertung');
  assert.match(r.grund, /vollständig/i);
});
