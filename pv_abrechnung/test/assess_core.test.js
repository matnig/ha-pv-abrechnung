'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { simulate, scaleGeneration, revenue } = require('../src/assess/simulate');
const { evaluate, pvInvest, batteryInvest, bestForTarget } = require('../src/assess/economics');
const { estimateKwpFromHourly, estimateCapacityFromSoc, findKwp, findBatteryCapacity, detectPlant } = require('../src/assess/discovery');

// --- Simulation ---

test('simulate ohne Speicher: Direktverbrauch, Rest wird eingespeist bzw. bezogen', () => {
  // Stunde 1: 5 erzeugt / 2 gebraucht -> 2 direkt, 3 Einspeisung
  // Stunde 2: 0 erzeugt / 4 gebraucht -> 4 Netzbezug
  const r = simulate({ generation: [5, 0], consumption: [2, 4], batteryKwh: 0 });
  assert.strictEqual(r.direktverbrauch, 2);
  assert.strictEqual(r.einspeisung, 3);
  assert.strictEqual(r.netzbezug, 4);
  assert.strictEqual(r.eigenverbrauch, 2);
});

test('simulate mit Speicher: Überschuss wird gespeichert und später genutzt (mit Verlusten)', () => {
  const r = simulate({ generation: [5, 0], consumption: [2, 4], batteryKwh: 10, roundTrip: 1, maxChargeKw: 10, maxDischargeKw: 10 });
  assert.strictEqual(r.einspeisung, 0, 'Überschuss geht in den Speicher, nicht ins Netz');
  assert.strictEqual(r.speicherladung, 3);
  assert.strictEqual(r.speicherentladung, 3);
  assert.strictEqual(r.netzbezug, 1, '4 Bedarf − 3 aus Speicher');
  assert.strictEqual(r.eigenverbrauch, 5);
});

test('simulate: Round-Trip-Verluste verringern die nutzbare Energie', () => {
  const r = simulate({ generation: [10, 0], consumption: [0, 10], batteryKwh: 10, roundTrip: 0.81, maxChargeKw: 10, maxDischargeKw: 10 });
  // 9 rein (0,9 von 10 passt in 10 kWh), Entladung mit 0,9 -> ca. 8,1
  assert.ok(r.speicherentladung < r.speicherladung, 'Verluste vorhanden');
  assert.ok(r.speicherverluste > 0);
  assert.ok(r.netzbezug > 0, 'Verluste müssen aus dem Netz gedeckt werden');
});

test('simulate: Kapazitäts- und Ladeleistungsgrenze werden eingehalten', () => {
  const r = simulate({ generation: [100], consumption: [0], batteryKwh: 5, roundTrip: 1, maxChargeKw: 2 });
  assert.strictEqual(r.speicherladung, 2, 'Ladeleistung begrenzt');
  assert.strictEqual(r.einspeisung, 98);
  const r2 = simulate({ generation: [100], consumption: [0], batteryKwh: 5, roundTrip: 1, maxChargeKw: 100 });
  assert.strictEqual(r2.speicherladung, 5, 'Kapazität begrenzt');
});

test('scaleGeneration: lineare Skalierung nach kWp, optional mit fremder Kurvenform', () => {
  assert.deepStrictEqual(scaleGeneration([1, 2, 3], 10, 5), [1.5, 3, 4.5]);
  assert.deepStrictEqual(scaleGeneration([1, 2, 3], 10, 0), [1, 2, 3], 'ohne Zubau unverändert');
  assert.deepStrictEqual(scaleGeneration([1, 1], 10, 2, [0.5, 0]), [2, 1], 'Form je kWp × 2 kWp');
});

test('revenue: Lieferung zählt voll, Einspeisung nur wenn sie dem Betreiber zusteht', () => {
  const bal = { eigenverbrauch: 100, einspeisung: 50, netzbezug: 20 };
  const a = revenue(bal, { lieferung: 0.22, einspeisung: 0.08, netzbezug: 0.3, einspeisungAnBetreiber: true });
  assert.strictEqual(a.erloesLieferung, 22);
  assert.strictEqual(a.erloesEinspeisung, 4);
  assert.strictEqual(a.erloesGesamt, 26);
  const b = revenue(bal, { lieferung: 0.22, einspeisung: 0.08, einspeisungAnBetreiber: false });
  assert.strictEqual(b.erloesEinspeisung, 0, 'Vergütung geht an den Kunden');
  assert.strictEqual(b.erloesGesamt, 22);
});

// --- Wirtschaftlichkeit ---

test('evaluate: statische Amortisation entspricht Investition/Jahresüberschuss', () => {
  const r = evaluate({ invest: 1000, jahresErloesJahr1: 250, laufzeit: 20, zins: 0, preissteigerung: 0, degradation: 0, betriebskosten: 0 });
  assert.strictEqual(r.amortisationStatisch, 4);
  assert.strictEqual(r.amortisationDynamisch, 4, 'ohne Zins identisch');
  assert.strictEqual(r.npv, 4000, '20 × 250 − 1000');
});

test('evaluate: Zins verlängert die dynamische Amortisation, Betriebskosten senken den Ertrag', () => {
  const ohne = evaluate({ invest: 1000, jahresErloesJahr1: 250, laufzeit: 20, zins: 0, preissteigerung: 0, degradation: 0, betriebskosten: 0 });
  const mit = evaluate({ invest: 1000, jahresErloesJahr1: 250, laufzeit: 20, zins: 5, preissteigerung: 0, degradation: 0, betriebskosten: 0 });
  assert.ok(mit.amortisationDynamisch > ohne.amortisationDynamisch);
  assert.ok(mit.npv < ohne.npv);
  const opex = evaluate({ invest: 1000, jahresErloesJahr1: 250, laufzeit: 20, zins: 0, preissteigerung: 0, degradation: 0, betriebskosten: 50 });
  assert.strictEqual(opex.amortisationStatisch, 5, '1000 / (250−50)');
});

test('evaluate: unrentable Investition – Amortisation ausserhalb der Laufzeit, negativer Kapitalwert', () => {
  const r = evaluate({ invest: 10000, jahresErloesJahr1: 100, laufzeit: 10, zins: 3, preissteigerung: 0, degradation: 0, betriebskosten: 0 });
  assert.strictEqual(r.amortisationStatisch, 100, '10.000 / 100 = 100 Jahre');
  assert.strictEqual(r.amortisiertInnerhalbLaufzeit, false, 'wird in 10 Jahren nie erreicht');
  assert.strictEqual(r.amortisationDynamisch, null, 'innerhalb der Laufzeit nicht erreicht');
  assert.ok(r.npv < 0);
});

test('evaluate: ohne Überschuss (Betriebskosten fressen den Erlös) gibt es keine Amortisation', () => {
  const r = evaluate({ invest: 5000, jahresErloesJahr1: 100, laufzeit: 20, zins: 3, preissteigerung: 0, degradation: 0, betriebskosten: 120 });
  assert.strictEqual(r.amortisationStatisch, null, 'negativer Cashflow -> keine Amortisation');
  assert.strictEqual(r.amortisiertInnerhalbLaufzeit, false);
});

test('evaluate: IRR plausibel (10 Jahre je 20% der Investition -> ca. 15%)', () => {
  const r = evaluate({ invest: 1000, jahresErloesJahr1: 200, laufzeit: 10, zins: 3, preissteigerung: 0, degradation: 0, betriebskosten: 0 });
  assert.ok(r.irr > 14 && r.irr < 16, `IRR war ${r.irr}`);
});

test('evaluate: Stromgestehungskosten = diskontierte Kosten / diskontierte kWh', () => {
  const r = evaluate({ invest: 10000, jahresErloesJahr1: 500, laufzeit: 20, zins: 0, preissteigerung: 0, degradation: 0, betriebskosten: 0, ertragKwhJahr1: 5000 });
  assert.strictEqual(r.lcoe, 0.1, '10.000 € / (20 × 5.000 kWh)');
});

test('Investitionskosten: Kleinanlagen-Zuschlag, Mengenrabatt bei großen', () => {
  assert.ok(pvInvest(2, 1000) / 2 > 1000, 'unter 3 kWp teurer je kWp');
  assert.strictEqual(pvInvest(20, 1000), 20000);
  assert.ok(pvInvest(40, 1000) / 40 < 1000, 'über 30 kWp günstiger je kWp');
  assert.strictEqual(pvInvest(0, 1000), 0);
  assert.ok(batteryInvest(3, 700) / 3 > 700);
  assert.strictEqual(batteryInvest(10, 700), 7000);
});

test('bestForTarget: wählt unter den Varianten im Ziel die mit dem höchsten Kapitalwert', () => {
  const vs = [
    { label: 'A', kennzahlen: { amortisationDynamisch: 6, npv: 1000 } },
    { label: 'B', kennzahlen: { amortisationDynamisch: 9, npv: 5000 } },
    { label: 'C', kennzahlen: { amortisationDynamisch: 14, npv: 9000 } },
    { label: 'D', kennzahlen: { amortisationDynamisch: null, npv: -100 } },
  ];
  assert.strictEqual(bestForTarget(vs, 10).label, 'B');
  assert.strictEqual(bestForTarget(vs, 5), null, 'kein Treffer -> null');
});

// --- Erkennung ---

test('findKwp: erkennt kWp-Einheit und Nennleistungs-Sensoren, ignoriert Momentanleistung', () => {
  const states = [
    { entity_id: 'sensor.anlage_peak_power', state: '12.5', attributes: { unit_of_measurement: 'kWp', friendly_name: 'Peak' } },
    { entity_id: 'sensor.wr_rated_power', state: '10000', attributes: { unit_of_measurement: 'W', friendly_name: 'Rated Power' } },
    { entity_id: 'sensor.pv_current_power', state: '3400', attributes: { unit_of_measurement: 'W', friendly_name: 'Aktuelle Leistung' } },
  ];
  const found = findKwp(states);
  assert.ok(found.some((f) => f.kwp === 12.5 && f.confidence === 'hoch'));
  assert.ok(found.some((f) => f.kwp === 10), 'W wird zu kW umgerechnet');
  assert.ok(!found.some((f) => f.entityId === 'sensor.pv_current_power'), 'Momentanleistung ist keine Nennleistung');
});

test('findKwp: deutsche Sensornamen mit "Leistung" werden erkannt (kein Substring-Treffer auf "ist")', () => {
  // Regressionstest: ein Ausschlussmuster /ist/ ohne Wortgrenze trifft "Nennleistung"
  // (Nennle-IST-ung) und hätte praktisch jeden deutschen Leistungssensor verworfen.
  const states = [
    { entity_id: 'sensor.wr_rated_power', state: '32000', attributes: { unit_of_measurement: 'W', friendly_name: 'Wechselrichter Nennleistung' } },
    { entity_id: 'sensor.anlagenleistung', state: '15', attributes: { unit_of_measurement: 'kW', friendly_name: 'Installierte Anlagenleistung' } },
  ];
  const found = findKwp(states);
  assert.ok(found.some((f) => f.kwp === 32), 'Nennleistung in W erkannt');
  assert.ok(found.some((f) => f.kwp === 15), 'Anlagenleistung in kW erkannt');
});

test('findKwp: Momentanleistung wird trotz Treffer-Begriffen ausgeschlossen', () => {
  const states = [
    { entity_id: 'sensor.pv_power_now', state: '5000', attributes: { unit_of_measurement: 'W', friendly_name: 'PV Power now' } },
    { entity_id: 'sensor.pv_leistung_aktuell', state: '4200', attributes: { unit_of_measurement: 'W', friendly_name: 'PV Leistung aktuell' } },
    { entity_id: 'sensor.pv_power_today', state: '30', attributes: { unit_of_measurement: 'kW', friendly_name: 'PV Power today' } },
  ];
  assert.strictEqual(findKwp(states).length, 0, 'Momentan-/Tageswerte sind keine Nennleistung');
});

test('findBatteryCapacity: erkennt Kapazität, ignoriert Energiezähler des Speichers', () => {
  const states = [
    { entity_id: 'sensor.battery_capacity', state: '9.8', attributes: { unit_of_measurement: 'kWh', friendly_name: 'Battery Capacity' } },
    { entity_id: 'sensor.battery_charged_today', state: '4.2', attributes: { unit_of_measurement: 'kWh', friendly_name: 'Battery Charged Today' } },
  ];
  const found = findBatteryCapacity(states);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].kwh, 9.8);
});

test('estimateKwpFromHourly / estimateCapacityFromSoc: plausible Schätzung, sonst null', () => {
  const hours = new Array(200).fill(0).map((_, i) => (i % 24 >= 10 && i % 24 <= 13 ? 7.8 : 0.5));
  const kwp = estimateKwpFromHourly(hours);
  assert.ok(kwp > 8 && kwp < 12, `kWp-Schätzung war ${kwp}`);
  assert.strictEqual(estimateKwpFromHourly([1, 2]), null, 'zu wenig Daten -> null');

  assert.strictEqual(estimateCapacityFromSoc([{ socPct: 50, kwh: 5 }, { socPct: 80, kwh: 8 }]), 10);
  assert.strictEqual(estimateCapacityFromSoc([{ socPct: 5, kwh: 0.4 }]), null, 'zu kleine Hübe -> unbrauchbar');
});

test('detectPlant: Config schlägt Sensor, fehlende Angaben werden gemeldet statt erfunden', () => {
  const states = [{ entity_id: 'sensor.anlage_peak', state: '11', attributes: { unit_of_measurement: 'kWp' } }];
  const withCfg = detectPlant({ plant: { kwp: 15 } }, states);
  assert.strictEqual(withCfg.kwp.value, 15);
  assert.strictEqual(withCfg.kwp.source, 'config');

  const fromSensor = detectPlant({}, states);
  assert.strictEqual(fromSensor.kwp.value, 11);
  assert.strictEqual(fromSensor.kwp.source, 'sensor');

  const nothing = detectPlant({}, []);
  assert.strictEqual(nothing.kwp, null);
  assert.ok(nothing.missing.some((m) => m.field === 'kwp'), 'fehlendes kWp wird gemeldet');
  assert.strictEqual(nothing.hasBattery, false, 'ohne SoC-Sensor kein Speicher angenommen');
});
