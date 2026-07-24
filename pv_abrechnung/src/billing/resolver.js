'use strict';

const { toDateStr, addDays } = require('./periods');
const haClient = require('../ha/haClient');
const { dailyCumKwh } = require('../ha/statistics');

const ROLE_LABEL = {
  verbrauch: 'Verbrauch',
  netzbezug: 'Netzbezug',
  lieferung: 'Lieferung an Kunde',
  einspeisung: 'Einspeisung (Gutschrift)',
  erzeugung: 'PV-Erzeugung',
};

const DAY_MS = 86400000;

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Größter Tages-Zählerstand mit Datum <= dateStr. Gibt { value, date } zurück.
function valueAtOrBefore(daily, dateStr) {
  let bestKey = null;
  for (const key of Object.keys(daily)) {
    if (key <= dateStr && (bestKey === null || key > bestKey)) bestKey = key;
  }
  return bestKey === null ? { value: null, date: null } : { value: daily[bestKey], date: bestKey };
}

function meterBase(meter) {
  return {
    meterId: meter.id,
    name: meter.name,
    entityId: meter.entityId,
    role: meter.role,
    roleLabel: ROLE_LABEL[meter.role] || meter.role,
  };
}

/**
 * Anfangsstand/Endstand/kWh für eine Periode aus einem täglichen kumulativen Verlauf
 * ({date: kWh}). Fehlt der Stand am Periodenanfang (Zähler/Statistik beginnt erst
 * innerhalb der Periode), wird der FRÜHESTE verfügbare Stand im Zeitraum genutzt
 * (Rumpf-Periode) – so lässt sich der erste angebrochene Monat/Jahr trotzdem abrechnen.
 */
function computeBoundaries(cum, period) {
  const anfangTarget = toDateStr(addDays(period.start, -1)); // Stand am Vortag des Beginns
  const endeTarget = toDateStr(addDays(period.end, -1)); // Stand am letzten Tag
  const startStr = toDateStr(period.start);

  const e = valueAtOrBefore(cum, endeTarget);
  let a = valueAtOrBefore(cum, anfangTarget);
  let fallback = false;
  if (a.value == null) {
    const inPeriod = Object.keys(cum).filter((d) => d >= startStr && d <= endeTarget).sort();
    if (inPeriod.length) {
      a = { value: cum[inPeriod[0]], date: inPeriod[0] };
      fallback = true;
    }
  }

  const warnings = [];
  let kwh = null;
  if (a.value == null || e.value == null) {
    warnings.push('keine Zählerstände im Zeitraum');
  } else {
    kwh = round2(e.value - a.value);
    if (fallback) warnings.push(`Anfangsstand ab erstem verfügbaren Datum ${a.date}`);
    if (kwh < 0) warnings.push('negativer Verbrauch (Datenlücke/Reset?)');
  }
  return { anfang: a.value, anfangDatum: a.date, ende: e.value, endeDatum: e.date, kwh, fallback, warnings };
}

/**
 * Periodenwerte aus HA-Long-Term-Statistics – über den glitch-sicheren, monotonen
 * Zählerstand (`state`), inkl. „frühester verfügbarer Stand"-Fallback.
 * @returns {null|{anfang, anfangDatum, ende, endeDatum, kwh, fallback}}
 */
async function fromStatistics(entityId, period, ha, factor = 1) {
  const startISO = new Date(period.start.getTime() - 2 * DAY_MS).toISOString();
  const endISO = new Date(period.end.getTime()).toISOString();
  const cum = await dailyCumKwh(entityId, startISO, endISO, ha, factor);
  if (!Object.keys(cum).length) return null;
  return computeBoundaries(cum, period);
}

/**
 * Ermittelt je Zähler Anfangsstand/Endstand/kWh für die Periode.
 * Priorität: HA-Statistics (robust, glitch-sicher) -> eigenes Polling (Fallback).
 * @param {object} [opts] { ha } – für Tests injizierbar
 */
async function resolvePeriodReadings(config, snapshots, period, opts = {}) {
  const ha = opts.ha || haClient;
  const useStats = config.useStatistics !== false;
  const out = {};

  for (const meter of config.meters || []) {
    const warnings = [];
    let b = null;
    let source = null;

    if (useStats) {
      try {
        // Einheiten-Faktor: aus dem Poll bekannt, sonst direkt aus HA holen (wichtig für
        // frisch angelegte Zähler, die noch nie gepollt wurden, z.B. in Wh/MWh).
        let factor = (snapshots[meter.entityId] || {}).unitFactor;
        if (factor == null && ha.getState) {
          try {
            const st = await ha.getState(meter.entityId);
            factor = haClient.unitFactorToKwh((st.attributes && st.attributes.unit_of_measurement) || '');
          } catch {
            /* ignore -> Standard 1 */
          }
        }
        b = await fromStatistics(meter.entityId, period, ha, factor || 1);
        if (b) source = 'statistics';
      } catch (err) {
        warnings.push('HA-Statistik nicht erreichbar, Fallback Polling: ' + (err.message || err));
      }
    }

    if (!b) {
      const daily = (snapshots[meter.entityId] || {}).daily || {};
      b = computeBoundaries(daily, period);
      source = 'poll';
    }

    out[meter.id] = {
      ...meterBase(meter),
      anfang: b.anfang,
      anfangDatum: b.anfangDatum,
      ende: b.ende,
      endeDatum: b.endeDatum,
      kwh: b.kwh,
      source,
      warnings: [...warnings, ...b.warnings],
    };
  }

  // Virtuelle Zähler: aus dem gespeicherten (backfill-/poll-)Verlauf; nie negativ.
  for (const vm of config.virtualMeters || []) {
    const daily = (snapshots['virtual:' + vm.id] || {}).daily || {};
    const b = computeBoundaries(daily, period);
    const warnings = [...b.warnings];
    let kwh = b.kwh;
    if (kwh != null && kwh < 0) {
      kwh = 0;
      warnings.push('negativer Rohwert auf 0 gedeckelt (Startdatum/Backfill prüfen)');
    }
    if (b.anfang == null) warnings.push('virtueller Zähler ohne Verlauf – ggf. „Rückwirkend berechnen"');
    out[vm.id] = {
      meterId: vm.id,
      name: vm.name,
      entityId: 'virtual:' + vm.id,
      role: vm.role,
      roleLabel: ROLE_LABEL[vm.role] || vm.role,
      anfang: b.anfang,
      anfangDatum: b.anfangDatum,
      ende: b.ende,
      endeDatum: b.endeDatum,
      kwh,
      source: 'virtual',
      virtual: true,
      warnings,
    };
  }

  return out;
}

module.exports = { resolvePeriodReadings, fromStatistics, computeBoundaries, valueAtOrBefore, round2, ROLE_LABEL };
