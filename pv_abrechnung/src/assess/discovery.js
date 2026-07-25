'use strict';

// Erkennung der Anlagen-Stammdaten (kWp der Module, nutzbare Speicherkapazität) aus Home
// Assistant. Viele Wechselrichter-/Speicher-Integrationen liefern diese Werte gar nicht,
// deshalb drei Stufen – jede Angabe wird mit Quelle und Zuverlässigkeit zurückgegeben:
//
//   1. Konfiguriert  -> vom Nutzer eingetragen, gilt immer (source: 'config')
//   2. Aus Sensoren  -> passende Entität/Attribut gefunden       (source: 'sensor')
//   3. Geschätzt     -> aus den Messdaten abgeleitet             (source: 'estimate')
//
// Was gar nicht ermittelbar ist, landet in `missing` – die Oberfläche fragt dann danach,
// statt mit erfundenen Werten zu rechnen.

const KWP_HINTS = /(peak|nominal|rated|installed|pv[_-]?power|anlagen(leistung|groesse|größe)|modul(leistung)?|kwp)/i;
const CAP_HINTS = /(battery|akku|speicher|storage|bat)[_-]?.*(capacity|kapazitaet|kapazität|size|energy[_-]?total|rated)|(capacity|kapazit)/i;
const SOC_HINTS = /(soc|state[_-]?of[_-]?charge|ladezustand|battery[_-]?level)/i;
// Begriffe, die eine MOMENTAN-Leistung kennzeichnen (keine Nennleistung). Mit Wortgrenzen,
// damit "ist" nicht in "Nennleistung" oder "Leistung" trifft.
const MOMENTARY_HINTS = /(\bcurrent\b|\bactual\b|\bnow\b|momentan|aktuell|\bist[_-]?wert|\bpower[_-]?now\b|heute|today)/i;

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** kWp-Kandidaten: Einheit kWp/kW(p) bei Namen mit „peak/rated/nominal/installed". */
function findKwp(states) {
  const out = [];
  for (const s of states || []) {
    const a = s.attributes || {};
    const unit = String(a.unit_of_measurement || '').trim();
    const id = s.entity_id || '';
    const name = String(a.friendly_name || '');
    const hay = `${id} ${name}`;

    // 1) Eigene Einheit kWp ist eindeutig.
    if (/^kwp$/i.test(unit)) {
      const v = num(s.state);
      if (v) out.push({ kwp: v, entityId: id, name, via: 'Einheit kWp', confidence: 'hoch' });
      continue;
    }
    // 2) Leistungssensor, dessen Name auf die Nennleistung hinweist (nicht die Momentanleistung).
    // Achtung: Ausschlussbegriffe brauchen Wortgrenzen – ein blosses /ist/ würde auf
    // „Nennleistung" passen und damit praktisch jeden deutschen Leistungssensor verwerfen.
    if (/^(w|kw)$/i.test(unit) && KWP_HINTS.test(hay) && !MOMENTARY_HINTS.test(hay)) {
      const v = num(s.state);
      if (v) out.push({ kwp: /^w$/i.test(unit) ? v / 1000 : v, entityId: id, name, via: `Sensor (${unit})`, confidence: 'mittel' });
      continue;
    }
    // 3) Attribute, die manche Integrationen mitliefern.
    for (const key of Object.keys(a)) {
      if (!/peak|rated|nominal|installed.*power|kwp/i.test(key)) continue;
      const v = num(a[key]);
      if (!v) continue;
      const kwp = v > 1000 ? v / 1000 : v; // W oder kW heuristisch
      if (kwp > 0.5 && kwp < 5000) out.push({ kwp, entityId: id, name, via: `Attribut ${key}`, confidence: 'mittel' });
    }
  }
  return out;
}

/** Speicher-Kapazitäts-Kandidaten (kWh). */
function findBatteryCapacity(states) {
  const out = [];
  for (const s of states || []) {
    const a = s.attributes || {};
    const unit = String(a.unit_of_measurement || '').trim();
    const id = s.entity_id || '';
    const name = String(a.friendly_name || '');
    const hay = `${id} ${name}`;
    const looksBattery = /(battery|akku|speicher|storage|bms)/i.test(hay);

    if (looksBattery && /^(wh|kwh)$/i.test(unit) && /(capacity|kapazit|size|nominal|rated|total|full)/i.test(hay) && !/(charged|discharged|today|daily|total_?in|total_?out)/i.test(hay)) {
      const v = num(s.state);
      if (v) out.push({ kwh: /^wh$/i.test(unit) ? v / 1000 : v, entityId: id, name, via: `Sensor (${unit})`, confidence: 'hoch' });
      continue;
    }
    for (const key of Object.keys(a)) {
      if (!/capacity|kapazit|rated_?energy|nominal_?energy/i.test(key)) continue;
      const v = num(a[key]);
      if (!v) continue;
      const kwh = v > 1000 ? v / 1000 : v;
      if (kwh > 0.5 && kwh < 5000 && (looksBattery || CAP_HINTS.test(key))) {
        out.push({ kwh, entityId: id, name, via: `Attribut ${key}`, confidence: 'mittel' });
      }
    }
  }
  return out;
}

/** SoC-Sensoren (%) – nötig, um die Speichergröße aus Messdaten zu schätzen. */
function findSocSensors(states) {
  return (states || [])
    .filter((s) => {
      const a = s.attributes || {};
      return String(a.unit_of_measurement || '').trim() === '%' && (SOC_HINTS.test(s.entity_id || '') || SOC_HINTS.test(String(a.friendly_name || '')) || a.device_class === 'battery');
    })
    .map((s) => ({ entityId: s.entity_id, name: (s.attributes || {}).friendly_name || s.entity_id, value: num(s.state) }));
}

/**
 * kWp aus Messdaten schätzen: höchste je gemessene Stunden-Energie der Erzeugung.
 * Eine Stunde mit E kWh bedeutet mindestens E kW Durchschnittsleistung; im deutschen
 * Sommermittag erreichen Anlagen etwa 70-85% ihrer Nennleistung im Stundenmittel.
 * @param {number[]} hourlyKwh
 */
function estimateKwpFromHourly(hourlyKwh, factor = 0.78) {
  const vals = (hourlyKwh || []).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => b - a);
  if (vals.length < 24) return null;
  // Nicht das absolute Maximum (Ausreißer), sondern das 99,5%-Perzentil der Spitzenstunden.
  const peak = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.005))];
  if (!peak) return null;
  return Math.round((peak / factor) * 10) / 10;
}

/**
 * Nutzbare Speicherkapazität aus SoC-Verlauf + geladener/entladener Energie schätzen:
 * kWh_nutzbar ≈ Energie zwischen zwei SoC-Ständen / (ΔSoC/100).
 * @param {Array<{socPct:number, kwh:number}>} pairs  Ladehübe: SoC-Änderung und dabei bewegte Energie
 */
function estimateCapacityFromSoc(pairs) {
  const cands = (pairs || [])
    .filter((p) => p && Math.abs(p.socPct) >= 20 && p.kwh > 0)
    .map((p) => p.kwh / (Math.abs(p.socPct) / 100))
    .filter((v) => Number.isFinite(v) && v > 0.5 && v < 5000)
    .sort((a, b) => a - b);
  if (!cands.length) return null;
  return Math.round(cands[Math.floor(cands.length / 2)] * 10) / 10; // Median
}

/**
 * Stammdaten zusammenstellen. Konfigurierte Werte haben Vorrang, dann Sensoren, dann Schätzung.
 * @param {object} config
 * @param {Array} states       HA-States (haClient.listAllStates())
 * @param {object} [hints]     { generationHourlyKwh?:number[], socPairs?:Array }
 */
function detectPlant(config, states, hints = {}) {
  const plant = config.plant || {};
  const kwpCands = findKwp(states);
  const capCands = findBatteryCapacity(states);
  const missing = [];
  const notes = [];

  let kwp = null;
  if (num(plant.kwp)) {
    kwp = { value: num(plant.kwp), source: 'config', via: 'manuell eingetragen', confidence: 'hoch' };
  } else if (kwpCands.length) {
    const best = kwpCands.sort((a, b) => (a.confidence === 'hoch' ? -1 : 1) - (b.confidence === 'hoch' ? -1 : 1))[0];
    kwp = { value: best.kwp, source: 'sensor', via: `${best.name} (${best.via})`, entityId: best.entityId, confidence: best.confidence };
  } else {
    const est = estimateKwpFromHourly(hints.generationHourlyKwh);
    if (est) {
      kwp = { value: est, source: 'estimate', via: 'aus der höchsten gemessenen Stundenerzeugung abgeleitet', confidence: 'niedrig' };
      notes.push('Die Modulleistung (kWp) wurde aus den Messwerten geschätzt – für belastbare Zahlen bitte im Feld „Modulleistung" eintragen.');
    } else {
      missing.push({ field: 'kwp', label: 'Modulleistung der Anlage (kWp)', why: 'Ohne kWp lässt sich eine Erweiterung nicht hochrechnen.' });
    }
  }

  let capacity = null;
  const socSensors = findSocSensors(states);
  if (num(plant.batteryKwh)) {
    capacity = { value: num(plant.batteryKwh), source: 'config', via: 'manuell eingetragen', confidence: 'hoch' };
  } else if (capCands.length) {
    const best = capCands[0];
    capacity = { value: best.kwh, source: 'sensor', via: `${best.name} (${best.via})`, entityId: best.entityId, confidence: best.confidence };
  } else {
    const est = estimateCapacityFromSoc(hints.socPairs);
    if (est) {
      capacity = { value: est, source: 'estimate', via: 'aus Ladehüben (SoC-Änderung vs. Energie) abgeleitet', confidence: 'niedrig' };
      notes.push('Die Speichergröße wurde aus dem Ladeverhalten geschätzt – für belastbare Zahlen bitte eintragen.');
    } else if (socSensors.length) {
      missing.push({ field: 'batteryKwh', label: 'Nutzbare Speicherkapazität (kWh)', why: 'Ein Akku-Ladestand ist vorhanden, die Kapazität ist aus HA aber nicht ablesbar.' });
    }
    // Kein SoC-Sensor und keine Kapazität -> es gibt vermutlich keinen Speicher: kein Mangel.
  }

  return {
    kwp,
    batteryKwh: capacity,
    hasBattery: !!(capacity && capacity.value > 0) || socSensors.length > 0,
    socSensors,
    candidates: { kwp: kwpCands, batteryKwh: capCands },
    missing,
    notes,
  };
}

module.exports = { detectPlant, findKwp, findBatteryCapacity, findSocSensors, estimateKwpFromHourly, estimateCapacityFromSoc };
