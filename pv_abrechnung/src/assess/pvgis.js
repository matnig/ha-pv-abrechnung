'use strict';

// PVGIS der EU-Kommission (Joint Research Centre) – kostenlose, quellenfreie Ertragsdaten.
//   PVcalc     : Jahres- und Monatssoll je kWp für Standort/Neigung/Ausrichtung
//   seriescalc : stündliche Ertragsform eines typischen Jahres (für eine ANDERE Dachseite)
//
// Zwei Einsatzzwecke:
//   1. Soll-Ist-Vergleich der bestehenden Anlage (ist der Ertrag am Standort normal?)
//   2. Erweiterung auf einer anderen Ausrichtung, für die keine Messkurve existiert
//
// Ausrichtung (aspect) nach PVGIS-Konvention: 0 = Süd, −90 = Ost, +90 = West, 180 = Nord.
// Ergebnisse werden gecacht, weil sie sich praktisch nicht ändern (Klimamittel).

const { readJson, writeJson } = require('../store/store');

const BASE = 'https://re.jrc.ec.europa.eu/api/v5_2';
const CACHE_FILE = 'pvgis_cache.json';
const CACHE_TTL_MS = 180 * 24 * 3600 * 1000; // halbes Jahr – Klimamittel, ändert sich nicht

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  return Math.round((n + Number.EPSILON) * f) / f;
};

function cacheKey(kind, p) {
  return [kind, round(p.lat, 3), round(p.lon, 3), p.angle, p.aspect, p.loss].join('|');
}

function fromCache(key) {
  const c = readJson(CACHE_FILE, {});
  const hit = c[key];
  if (hit && Date.now() - (hit.at || 0) < CACHE_TTL_MS) return hit.data;
  return null;
}
function toCache(key, data) {
  const c = readJson(CACHE_FILE, {});
  c[key] = { at: Date.now(), data };
  writeJson(CACHE_FILE, c);
}

async function fetchJson(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`PVGIS HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('PVGIS antwortet nicht (Zeitüberschreitung) – kein Internetzugang?');
    throw new Error('PVGIS nicht erreichbar: ' + ((e && e.message) || e));
  } finally {
    clearTimeout(t);
  }
}

/**
 * Jahres-/Monatssoll je kWp.
 * @param {object} p { lat, lon, angle?, aspect?, loss?, fetchImpl? }
 * @returns {Promise<{yearKwhPerKwp:number, monthlyKwhPerKwp:number[], angle:number, aspect:number, source:string}>}
 */
async function yieldPerKwp(p) {
  const q = {
    lat: Number(p.lat),
    lon: Number(p.lon),
    angle: p.angle != null ? Number(p.angle) : 35,
    aspect: p.aspect != null ? Number(p.aspect) : 0,
    loss: p.loss != null ? Number(p.loss) : 14, // Systemverluste in % (PVGIS-Standard)
  };
  if (!Number.isFinite(q.lat) || !Number.isFinite(q.lon)) throw new Error('Standort (Koordinaten) unbekannt');
  const key = cacheKey('PVcalc', q);
  const cached = fromCache(key);
  if (cached) return { ...cached, cached: true };

  const url = `${BASE}/PVcalc?lat=${q.lat}&lon=${q.lon}&peakpower=1&loss=${q.loss}&angle=${q.angle}&aspect=${q.aspect}&outputformat=json`;
  const json = await (p.fetchImpl || fetchJson)(url);
  const totals = json && json.outputs && json.outputs.totals && json.outputs.totals.fixed;
  const monthly = (json && json.outputs && json.outputs.monthly && json.outputs.monthly.fixed) || [];
  if (!totals || !Number.isFinite(Number(totals.E_y))) throw new Error('PVGIS: unerwartete Antwort');
  const data = {
    yearKwhPerKwp: round(Number(totals.E_y), 1),
    monthlyKwhPerKwp: monthly.map((m) => round(Number(m.E_m), 1)),
    angle: q.angle,
    aspect: q.aspect,
    loss: q.loss,
    source: 'PVGIS v5.2 (EU JRC), SARAH3-Klimamittel',
  };
  toCache(key, data);
  return data;
}

/**
 * Stündliche Ertragsform je kWp für ein typisches Jahr (8760 Werte, kWh/kWp).
 * Wird als Kurvenform für eine andere Dachausrichtung genutzt.
 */
async function hourlyShapePerKwp(p) {
  const q = {
    lat: Number(p.lat),
    lon: Number(p.lon),
    angle: p.angle != null ? Number(p.angle) : 35,
    aspect: p.aspect != null ? Number(p.aspect) : 0,
    loss: p.loss != null ? Number(p.loss) : 14,
  };
  const year = p.year || 2020;
  const key = cacheKey('series' + year, q);
  const cached = fromCache(key);
  if (cached) return { ...cached, cached: true };

  const url = `${BASE}/seriescalc?lat=${q.lat}&lon=${q.lon}&startyear=${year}&endyear=${year}&pvcalculation=1&peakpower=1&loss=${q.loss}&angle=${q.angle}&aspect=${q.aspect}&outputformat=json`;
  const json = await (p.fetchImpl || fetchJson)(url, 40000);
  const rows = (json && json.outputs && json.outputs.hourly) || [];
  if (!rows.length) throw new Error('PVGIS: keine Stundenwerte erhalten');
  // P ist die Leistung in W für 1 kWp -> je Stunde entspricht das W*1h = Wh -> /1000 = kWh
  const values = rows.map((r) => round(Number(r.P || 0) / 1000, 4));
  const data = { values, year, angle: q.angle, aspect: q.aspect, source: 'PVGIS v5.2 seriescalc' };
  toCache(key, data);
  return data;
}

/** Ausrichtung in Worten -> PVGIS-aspect. */
function aspectFromDirection(dir) {
  const map = { sued: 0, süd: 0, south: 0, sw: 45, suedwest: 45, südwest: 45, west: 90, so: -45, suedost: -45, südost: -45, ost: -90, east: -90, nord: 180, north: 180 };
  const k = String(dir || '').trim().toLowerCase().replace(/[\s-]/g, '');
  return map[k] != null ? map[k] : 0;
}

module.exports = { yieldPerKwp, hourlyShapePerKwp, aspectFromDirection, BASE, CACHE_FILE };
