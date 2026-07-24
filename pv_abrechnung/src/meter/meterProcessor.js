'use strict';

/**
 * Zähler-Validierung / Herzstück der Abrechnung.
 *
 * Ein Energiezähler (kWh, total_increasing) darf physikalisch NIE fallen.
 * Ein deutlicher Abfall öffnet einen `pending`-Zustand ("Störung in Untersuchung"):
 *
 *   - Kommt der Wert auf das alte Niveau zurück  -> "transient" (kurzzeitige Störung, erledigt)
 *   - Bleibt der Wert unten                       -> Störung bleibt offen; der Stand wird GEHALTEN
 *
 * Es gibt KEINE automatische Zählertausch-Erkennung. Ein Zählertausch wird
 * ausschließlich manuell über die Oberfläche bestätigt (`swapMeter`): dann wird
 * der Endstand des alten Zählers als `offset` konserviert und der virtuelle
 * Zähler läuft über effective = offset + raw nahtlos weiter.
 *
 * Die zeitliche Eskalation (10-Min-Untersuchungsmail, 2-Std-Störungsmail) macht
 * der meterService anhand des offenen pending-Zustands – nicht diese Funktion.
 */

const DEFAULTS = {
  resetToleranceKwh: 1, // Abfall größer als dieser Wert = Störung/pending; kleiner = Jitter
  recoverToleranceKwh: 1, // Rückkehr bis auf diesen Abstand zum alten Stand = kurzzeitige Störung
  staleMinutes: 180, // keine Wertänderung so lange = "stale"-Warnung
  maxRateKwhPerHour: 100, // schnellerer Anstieg = "spike"-Warnung (Wert wird trotzdem übernommen)
};

function num(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function freshState() {
  return { offset: 0, lastRaw: null, lastRawTs: null, lastChangeTs: null, effective: null, pending: null };
}

function heldEffective(s) {
  if (s.pending) return s.offset + s.pending.anchorRaw;
  return s.effective;
}

function done(s, effective, updated, anomalies) {
  s.effective = effective;
  return { state: s, effective, updated, anomalies };
}

function resolvePending(s, raw, now, c, anomalies) {
  const p = s.pending;

  // Wert zurück auf altes Niveau -> kurzzeitige Störung, erledigt.
  if (raw >= p.anchorRaw - c.recoverToleranceKwh) {
    s.pending = null;
    s.lastRaw = raw;
    s.lastRawTs = now;
    s.lastChangeTs = now;
    anomalies.push({ type: 'transient', at: now, from: p.anchorRaw, dippedTo: p.base });
    return done(s, s.offset + raw, true, anomalies);
  }

  // Weiterhin niedrig: aktuellen Stand mitführen (für Anzeige/Tausch), Stand HALTEN.
  p.current = raw;
  p.lastTs = now;
  return done(s, s.offset + p.anchorRaw, false, anomalies);
}

/**
 * @param {object|null} prev  bisheriger Zustand (aus dem Store) oder null
 * @param {{raw:*, available?:boolean, now:number}} reading
 * @param {object} [cfg]  Overrides für DEFAULTS
 * @returns {{state:object, effective:number|null, updated:boolean, anomalies:Array}}
 */
function processReading(prev, reading, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const s = prev ? { ...prev, pending: prev.pending ? { ...prev.pending } : null } : freshState();
  const anomalies = [];
  const now = reading.now;

  if (reading.available === false) {
    anomalies.push({ type: 'unavailable', at: now });
    return done(s, heldEffective(s), false, anomalies);
  }
  const raw = num(reading.raw);
  if (raw === null) {
    anomalies.push({ type: 'invalid', at: now, raw: reading.raw });
    return done(s, heldEffective(s), false, anomalies);
  }

  if (s.lastRaw === null) {
    s.lastRaw = raw;
    s.lastRawTs = now;
    s.lastChangeTs = now;
    return done(s, s.offset + raw, true, anomalies);
  }

  // "Hängt/offline" NUR anhand von HA `last_updated` (Gerät meldet nichts mehr) – NICHT anhand
  // eines gleichbleibenden Werts. Ein flacher Energiezähler ist normal (nachts / Akku deckt Last).
  if (reading.lastUpdated != null && now - reading.lastUpdated >= c.staleMinutes * 60000) {
    anomalies.push({ type: 'stale', at: now, sinceUpdate: reading.lastUpdated, minutes: Math.round((now - reading.lastUpdated) / 60000) });
  }

  if (s.pending) {
    return resolvePending(s, raw, now, c, anomalies);
  }

  const delta = raw - s.lastRaw;

  // Deutlicher Abfall -> pending öffnen (Störung in Untersuchung, Stand halten)
  if (delta < -c.resetToleranceKwh) {
    s.pending = { anchorRaw: s.lastRaw, base: raw, since: now, current: raw, lastTs: now };
    anomalies.push({ type: 'drop_detected', at: now, from: s.lastRaw, to: raw });
    return done(s, s.offset + s.lastRaw, false, anomalies);
  }

  // Keine Wertänderung -> völlig normal bei Energiezählern (kein Verbrauch/keine Einspeisung).
  // KEINE stale-Warnung mehr am gleichbleibenden Wert (siehe last_updated-Prüfung oben).
  if (Math.abs(delta) <= 1e-9) {
    s.lastRawTs = now;
    return done(s, s.offset + raw, false, anomalies);
  }

  // Kleiner Abfall innerhalb Toleranz -> Rauschen, Stand halten
  if (delta < 0) {
    anomalies.push({ type: 'jitter', at: now, from: s.lastRaw, to: raw });
    s.lastRawTs = now;
    return done(s, s.offset + s.lastRaw, false, anomalies);
  }

  // Anstieg -> Sprungprüfung, Wert übernehmen
  const hours = s.lastRawTs != null ? Math.max((now - s.lastRawTs) / 3600000, 1e-6) : 1;
  const ratePerHour = delta / hours;
  if (ratePerHour > c.maxRateKwhPerHour) {
    anomalies.push({ type: 'spike', at: now, delta, ratePerHour });
  }
  s.lastRaw = raw;
  s.lastRawTs = now;
  s.lastChangeTs = now;
  return done(s, s.offset + raw, true, anomalies);
}

/**
 * Manuell bestätigter Zählertausch: konserviert den Endstand des alten Zählers
 * als offset, sodass der (virtuelle) Zähler nahtlos weiterläuft.
 * @returns {{state:object, swapped:boolean, oldFinal?:number, newStart?:number, newReading?:number}}
 */
function swapMeter(state, now = Date.now()) {
  if (!state || !state.pending) return { state, swapped: false };
  const p = state.pending;
  const s = { ...state, pending: null, offset: state.offset + p.anchorRaw };
  s.lastRaw = p.current;
  s.lastRawTs = now;
  s.lastChangeTs = now;
  s.effective = s.offset + p.current;
  return { state: s, swapped: true, oldFinal: p.anchorRaw, newStart: p.base, newReading: p.current };
}

module.exports = { processReading, swapMeter, num, freshState, DEFAULTS };
