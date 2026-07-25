'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-assess-'));

const { runAssessment } = require('../src/assess/assess');

const HOUR = 3600000;

/**
 * Synthetisches, aber realistisches Jahr: 20 kWp Süd-Anlage, Gewerbekunde mit Tagesverbrauch,
 * 5 kWh Speicher. Zählerstände als kumulierte Reihen (wie HA-Statistik sie liefert).
 */
function buildHa({ kwp = 20, consumptionKwhPerDay = 40, nightShare = 0.35, withKwpSensor = true, monthFactor = null } = {}) {
  const now = Date.now();
  const endH = Math.floor(now / HOUR);
  const startH = endH - 365 * 24;

  const genRows = [];
  const feedRows = [];
  const gridRows = [];
  let genCum = 5000;
  let feedCum = 2000;
  let gridCum = 8000;

  for (let h = startH; h <= endH; h++) {
    const d = new Date(h * HOUR);
    const hour = d.getHours();
    const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
    // Saisonaler Verlauf + Tagesbogen (season bleibt positiv – auch im Winter gibt es Ertrag)
    const season = 0.58 + 0.42 * Math.sin(((doy - 80) / 365) * 2 * Math.PI);
    const bow = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
    // monthFactor erlaubt es, für einzelne Monate einen Leistungseinbruch zu simulieren
    const mf = monthFactor ? monthFactor(d) : 1;
    const gen = kwp * 0.62 * season * bow * mf; // kWh in dieser Stunde

    // Verbrauch: Tagsüber mehr (Gewerbe), nachts Grundlast
    const nightLoad = (consumptionKwhPerDay * nightShare) / 12;
    const dayLoad = (consumptionKwhPerDay * (1 - nightShare)) / 12;
    const con = hour >= 7 && hour < 19 ? dayLoad : nightLoad;

    const direct = Math.min(gen, con);
    const feed = Math.max(0, gen - con);
    const grid = Math.max(0, con - gen);

    genCum += gen;
    feedCum += feed;
    gridCum += grid;
    const iso = new Date(h * HOUR).toISOString();
    genRows.push({ start: iso, state: genCum });
    feedRows.push({ start: iso, state: feedCum });
    gridRows.push({ start: iso, state: gridCum });
  }

  const data = {
    'sensor.pv': genRows,
    'sensor.feed': feedRows,
    'sensor.grid': gridRows,
  };
  const states = [
    { entity_id: 'sensor.pv', state: '1.2', attributes: { unit_of_measurement: 'kWh' } },
    ...(withKwpSensor ? [{ entity_id: 'sensor.wr_peak_power', state: String(kwp), attributes: { unit_of_measurement: 'kWp', friendly_name: 'Anlagenleistung' } }] : []),
  ];
  return {
    statisticsDuringPeriod: async (ids) => ({ [ids[0]]: data[ids[0]] || [] }),
    listAllStates: async () => states,
    getHaConfig: async () => ({ latitude: 51.76, longitude: 7.89 }),
  };
}

const config = {
  meters: [
    { id: 'm1', name: 'PV', entityId: 'sensor.pv', role: 'erzeugung', unit: 'kWh' },
    { id: 'm2', name: 'Einspeisung', entityId: 'sensor.feed', role: 'einspeisung', unit: 'kWh' },
    { id: 'm3', name: 'Netzbezug', entityId: 'sensor.grid', role: 'netzbezug', unit: 'kWh' },
  ],
  tariffs: { lieferung: 0.22, einspeisung: 0.08, netzbezug: 0.3, einspeisungAnBetreiber: true },
};

// PVGIS-Stub (kein Netzzugriff im Test)
const pvgisFetch = async () => ({
  outputs: { totals: { fixed: { E_y: 1020 } }, monthly: { fixed: Array.from({ length: 12 }, (_, i) => ({ E_m: 85 })) } },
});

test('Gesamtbewertung läuft durch und liefert Ist-Zustand, Varianten und Empfehlung', async () => {
  const ha = buildHa();
  const r = await runAssessment(config, ha, { zielAmortisation: 12, pvgisFetch });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.plant.kwp.value, 20, 'kWp aus HA-Sensor erkannt');
  assert.strictEqual(r.plant.kwp.source, 'sensor');
  assert.ok(r.coverage.fullYear, 'ein Jahr Daten');
  assert.ok(r.ist.jahr.erzeugung > 15000 && r.ist.jahr.erzeugung < 30000, `Jahresertrag unplausibel: ${r.ist.jahr.erzeugung}`);
  assert.ok(r.variants.length >= 5, 'mehrere Varianten');
  assert.ok(r.variants.some((v) => v.art === 'pv') && r.variants.some((v) => v.art === 'battery') && r.variants.some((v) => v.art === 'combo'));
  assert.ok(r.health.gesamt, 'Zustandsnote vorhanden');
  assert.ok(Array.isArray(r.hebel) && r.hebel.length, 'Hebel ohne Investition');
});

test('Speicher bringt bei hohem Nachtverbrauch mehr als bei reinem Tagverbrauch', async () => {
  const nacht = await runAssessment(config, buildHa({ nightShare: 0.6 }), { pvgisFetch });
  const tag = await runAssessment(config, buildHa({ nightShare: 0.05 }), { pvgisFetch });
  const pick = (r) => r.variants.filter((v) => v.art === 'battery').sort((a, b) => b.kennzahlen.npv - a.kennzahlen.npv)[0];
  const bN = pick(nacht);
  const bT = pick(tag);
  assert.ok(
    bN.wirkung.mehrEigenverbrauchKwhJahr > bT.wirkung.mehrEigenverbrauchKwhJahr,
    `Nachtlast sollte den Speichernutzen erhöhen (${bN.wirkung.mehrEigenverbrauchKwhJahr} vs ${bT.wirkung.mehrEigenverbrauchKwhJahr})`
  );
});

test('PV-Zubau erhöht Erzeugung; Nutzen hängt daran, ob der Kunde die Energie abnimmt', async () => {
  const r = await runAssessment(config, buildHa(), { pvgisFetch });
  const pv = r.variants.filter((v) => v.art === 'pv').sort((a, b) => a.addKwp - b.addKwp);
  assert.ok(pv[0].wirkung.mehrErzeugungKwhJahr > 0);
  // Mehr kWp -> mehr Erzeugung, aber der Zusatznutzen je kWp sinkt (mehr davon wird eingespeist)
  const ersteJeKwp = pv[0].wirkung.mehrEigenverbrauchKwhJahr / pv[0].addKwp;
  const letzteJeKwp = pv[pv.length - 1].wirkung.mehrEigenverbrauchKwhJahr / pv[pv.length - 1].addKwp;
  assert.ok(letzteJeKwp <= ersteJeKwp + 1e-6, 'abnehmender Grenznutzen je zusätzlichem kWp');
  assert.ok(pv[pv.length - 1].wirkung.mehrEinspeisungKwhJahr > pv[0].wirkung.mehrEinspeisungKwhJahr);
});

test('Ziel-Amortisation: strengeres Ziel führt zu keiner oder einer besseren Empfehlung', async () => {
  // Kunde mit hohem Tagbedarf (Gewerbe) – hier lohnt sich Zubau, weil die Energie abgenommen wird
  const ha = buildHa({ consumptionKwhPerDay: 160 });
  const locker = await runAssessment(config, ha, { zielAmortisation: 25, pvgisFetch });
  const streng = await runAssessment(config, ha, { zielAmortisation: 2, pvgisFetch });
  assert.ok(locker.empfehlung, 'bei hohem Bedarf und 25 Jahren muss etwas passen');
  assert.ok(locker.empfehlung.kennzahlen.amortisationDynamisch <= 25);
  assert.ok(streng.empfehlung == null || streng.empfehlung.kennzahlen.amortisationDynamisch <= 2, 'bei 2 Jahren nur, wenn wirklich erfüllt');
});

test('Kunde nimmt Strom ab -> PV-Zubau rentabel; Kunde gesättigt -> ehrlich unrentabel', async () => {
  const viel = await runAssessment(config, buildHa({ consumptionKwhPerDay: 160 }), { zielAmortisation: 15, pvgisFetch });
  const wenig = await runAssessment(config, buildHa({ consumptionKwhPerDay: 20 }), { zielAmortisation: 15, pvgisFetch });
  const pvBest = (r) => r.variants.filter((v) => v.art === 'pv').sort((a, b) => b.kennzahlen.npv - a.kennzahlen.npv)[0];
  assert.ok(pvBest(viel).kennzahlen.npv > pvBest(wenig).kennzahlen.npv, 'hoher Abnahmegrad = höherer Kapitalwert');
  assert.ok(wenig.empfehlung == null || wenig.empfehlung.kennzahlen.npv < pvBest(viel).kennzahlen.npv);
  // Bei gesättigtem Kunden landet der Zubau fast vollständig in der Einspeisung
  const w = pvBest(wenig);
  assert.ok(w.wirkung.mehrEinspeisungKwhJahr > w.wirkung.mehrEigenverbrauchKwhJahr * 5, 'überwiegend Einspeisung');
});

test('statische Amortisation ist Investition/Überschuss des ersten Jahres (ohne Zins/Steigerung)', async () => {
  const { evaluate } = require('../src/assess/economics');
  const r = evaluate({ invest: 6300, jahresErloesJahr1: 326, laufzeit: 25, zins: 3, preissteigerung: 2, degradation: 0.5, betriebskosten: 63 });
  assert.strictEqual(r.amortisationStatisch, 23.95, '6300 / (326−63)');
  assert.strictEqual(r.amortisiertInnerhalbLaufzeit, true, '23,95 < 25 Jahre');
});

test('Soll-Ist-Vergleich nutzt PVGIS; fehlt PVGIS, wird gewarnt statt geraten', async () => {
  const ha = buildHa();
  const mit = await runAssessment(config, ha, { pvgisFetch });
  assert.ok(mit.ist.soll && mit.ist.soll.yearKwhPerKwp === 1020);
  assert.ok(mit.health.kennzahlen.sollErfuellung > 0, 'Soll-Erfüllung berechnet');

  // Anderer Standort -> anderer Cache-Schlüssel, damit wirklich der Offline-Fall geprüft wird
  // (der Cache aus dem Aufruf oben ist gewolltes Verhalten und würde ihn sonst überdecken).
  const haAndersort = { ...buildHa(), getHaConfig: async () => ({ latitude: 48.14, longitude: 11.58 }) };
  const ohne = await runAssessment(config, haAndersort, { pvgisFetch: async () => { throw new Error('offline'); } });
  assert.strictEqual(ohne.ist.soll, null);
  assert.ok(ohne.warnings.some((w) => /PVGIS/i.test(w)), 'Warnung statt erfundenem Sollwert');
  assert.ok(ohne.ok, 'Bewertung läuft trotzdem durch');
});

test('Fehlende Modulleistung: PV-Varianten entfallen, Lücke wird ausdrücklich benannt', async () => {
  const ha = buildHa({ withKwpSensor: false });
  // Erzeugungsprofil erlaubt eine Schätzung -> dann ist kWp geschätzt, mit Hinweis
  const r = await runAssessment(config, ha, { pvgisFetch });
  if (r.plant.kwp) {
    assert.strictEqual(r.plant.kwp.source, 'estimate');
    assert.ok(r.plant.notes.some((n) => /gesch/i.test(n)), 'Schätzung wird gekennzeichnet');
  } else {
    assert.ok(r.dataGaps.some((g) => g.feld === 'kwp'));
    assert.ok(!r.variants.some((v) => v.art === 'pv'));
  }
});

test('Zu wenig Daten -> klare Absage statt Scheinergebnis', async () => {
  const leer = { statisticsDuringPeriod: async () => ({}), listAllStates: async () => [], getHaConfig: async () => ({}) };
  const r = await runAssessment(config, leer, { pvgisFetch });
  assert.strictEqual(r.ok, false);
  assert.match(r.grund, /zu wenige Messdaten/i);
});

test('Fehlender Lieferpreis wird als Datenlücke gemeldet', async () => {
  const cfg = { ...config, tariffs: { ...config.tariffs, lieferung: 0 } };
  const r = await runAssessment(cfg, buildHa(), { pvgisFetch });
  assert.ok(r.dataGaps.some((g) => g.feld === 'tariffs.lieferung'), 'Lieferpreis-Lücke gemeldet');
});

test('Tagesprofil ist an echten Tagesstunden ausgerichtet (nicht am Array-Index)', async () => {
  // Regression: mit `i % 24` statt der echten Uhrzeit lag die Mittagsspitze irgendwo und die
  // Verschattungs-Heuristik meldete "Mittagsertrag 0% des Maximums".
  const r = await runAssessment(config, buildHa(), { pvgisFetch });
  const prof = r.health.kennzahlen.tagesprofil;
  assert.ok(Array.isArray(prof) && prof.length === 24);
  const maxIdx = prof.indexOf(Math.max(...prof));
  assert.ok(maxIdx >= 10 && maxIdx <= 14, `Erzeugungsmaximum muss mittags liegen, lag bei ${maxIdx} Uhr`);
  assert.strictEqual(prof[2], 0, 'nachts kein Ertrag');
  // Bei einer normalen Sonnenkurve darf KEINE Verschattung gemeldet werden
  assert.ok(!r.health.findings.some((f) => f.thema === 'Tagesverlauf'), 'kein Fehlalarm Verschattung');
});

test('Leistungsbegrenzung wird nur bei echtem Plateau gemeldet', async () => {
  const normal = await runAssessment(config, buildHa(), { pvgisFetch });
  assert.ok(!normal.health.findings.some((f) => f.thema === 'Leistungsbegrenzung'), 'Glockenkurve ist keine Begrenzung');
});

test('Ausfalltage: vollständige Datenreihe ergibt keine Ausfalltage', async () => {
  const r = await runAssessment(config, buildHa(), { pvgisFetch });
  assert.strictEqual(r.health.kennzahlen.ausfalltage, 0, 'lückenlose Reihe hat keine leeren Tage');
});

test('Preis-Sensitivität nennt die tatsächlich günstigste Variante', async () => {
  const r = await runAssessment(config, buildHa({ consumptionKwhPerDay: 160 }), { pvgisFetch });
  const h = r.hebel.find((x) => x.thema === 'Preis-Sensitivität');
  assert.ok(h, 'Hebel vorhanden');
  const guenstigste = Math.min(...r.variants.map((v) => v.invest));
  assert.ok(h.text.includes(String(Math.round(guenstigste))), `Text muss ${guenstigste} nennen: ${h.text}`);
});

test('freie Dachfläche begrenzt die PV-Varianten und ergänzt die Maximalbelegung', async () => {
  const cfg = { ...config, plant: { freieFlaecheKwp: 7 } };
  const r = await runAssessment(cfg, buildHa(), { pvgisFetch });
  const pv = r.variants.filter((v) => v.art === 'pv');
  assert.ok(pv.length, 'PV-Varianten vorhanden');
  assert.ok(pv.every((v) => v.addKwp <= 7), `alle <= 7 kWp: ${pv.map((v) => v.addKwp)}`);
  assert.ok(pv.some((v) => v.addKwp === 7 && /maximale Dachbelegung/.test(v.label)), 'Maximalbelegung als Variante');
});

test('Wechselrichter-Grenze deckelt den Zubau-Ertrag und erzeugt eine Warnung', async () => {
  // WR = 20 kW = genau die Bestandsanlage -> jeder Zubau wird stark beschnitten
  const mitWr = await runAssessment({ ...config, plant: { wechselrichterKw: 20 } }, buildHa(), { pvgisFetch });
  const ohneWr = await runAssessment(config, buildHa(), { pvgisFetch });
  const big = (r) => r.variants.filter((v) => v.art === 'pv').sort((a, b) => b.addKwp - a.addKwp)[0];
  assert.ok(big(mitWr).wirkung.mehrErzeugungKwhJahr < big(ohneWr).wirkung.mehrErzeugungKwhJahr, 'Deckelung reduziert den Mehrertrag');
  assert.ok(mitWr.warnings.some((w) => /Wechselrichter/.test(w)), 'Warnung mit Verlustangabe');
  assert.strictEqual(mitWr.plant.wechselrichterKw, 20);
});

test('Inbetriebnahme: EEG-Restlaufzeit wird berechnet, baldiges Auslaufen wird zum Hebel', async () => {
  const alt = await runAssessment({ ...config, plant: { inbetriebnahme: '1998-06' } }, buildHa(), { pvgisFetch });
  assert.ok(alt.plant.anlage, 'Anlagendaten vorhanden');
  assert.strictEqual(alt.plant.anlage.eegVerguetungBis, 2018, 'Vergütung endet am 31.12. von IBN+20');
  assert.strictEqual(alt.plant.anlage.eegRestJahre, 0, '1998 + 20 Jahre sind vorbei');
  assert.ok(alt.hebel.some((h) => /ausgelaufen/.test(h.thema)), 'Hinweis auf ausgelaufene Vergütung');

  const juenger = await runAssessment({ ...config, plant: { inbetriebnahme: '2023' } }, buildHa(), { pvgisFetch });
  assert.ok(juenger.plant.anlage.eegRestJahre > 10);
  assert.ok(!juenger.hebel.some((h) => /ausgelaufen|läuft aus/.test(h.thema)));

  const kaputt = await runAssessment({ ...config, plant: { inbetriebnahme: 'irgendwann' } }, buildHa(), { pvgisFetch });
  assert.ok(kaputt.warnings.some((w) => /nicht lesbar/.test(w)), 'unlesbares Datum wird gemeldet');

  const ohne = await runAssessment(config, buildHa(), { pvgisFetch });
  assert.ok(ohne.dataGaps.some((g) => g.feld === 'plant.inbetriebnahme'), 'fehlendes Jahr ist eine Datenlücke');
});

test('Wärmepumpe/Wallbox erzeugen den Lastverschiebungs-Hebel', async () => {
  const mit = await runAssessment({ ...config, plant: { waermepumpe: true, wallbox: true } }, buildHa(), { pvgisFetch });
  const h = mit.hebel.find((x) => /Lastverschiebung/.test(x.thema));
  assert.ok(h, 'Hebel vorhanden');
  assert.match(h.text, /Wärmepumpe und Wallbox/);
  assert.match(h.text, /VOR einer Speicher-Investition/);
  assert.deepStrictEqual(mit.plant.flexLasten, ['Wärmepumpe', 'Wallbox']);

  const ohne = await runAssessment(config, buildHa(), { pvgisFetch });
  assert.ok(!ohne.hebel.some((x) => /Lastverschiebung/.test(x.thema)), 'ohne Angabe kein Hebel');
});
