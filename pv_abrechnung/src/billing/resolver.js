'use strict';

const { toDateStr, addDays } = require('./periods');
const haClient = require('../ha/haClient');

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

// Größter Tages-Zählerstand mit Datum <= dateStr (aus den bereinigten Polling-Werten).
function valueAtOrBefore(daily, dateStr) {
  let bestKey = null;
  for (const key of Object.keys(daily)) {
    if (key <= dateStr && (bestKey === null || key > bestKey)) bestKey = key;
  }
  return bestKey === null ? { value: null, date: null } : { value: daily[bestKey], date: bestKey };
}

// HA liefert bucket.start je nach Version als ms-Zahl oder ISO-String.
function bucketStartMs(b) {
  return typeof b.start === 'number' ? b.start : Date.parse(b.start);
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
 * Periodenwerte aus HA-Long-Term-Statistics (Tages-Buckets).
 * kWh = Summe der `change`-Werte (reset-sicher, von HA gepflegt) – überlebt
 * Add-on-Downtime, weil der Recorder unabhängig vom Add-on aufzeichnet.
 * Fällt `change` weg (ältere HA-Version), wird die Differenz der `sum`-Werte genutzt.
 * @returns {null|{anfang:number|null, ende:number|null, kwh:number}}
 */
async function fromStatistics(entityId, period, ha) {
  const startISO = new Date(period.start.getTime() - DAY_MS).toISOString(); // ein Tag Vorlauf für Anfangsstand
  const endISO = period.end.toISOString();
  const res = await ha.statisticsDuringPeriod([entityId], startISO, endISO, 'day');
  const buckets = (res && res[entityId]) || [];
  if (!buckets.length) return null;

  const sMs = period.start.getTime();
  const eMs = period.end.getTime();
  let anfang = null;
  let ende = null;
  let kwh = 0;
  let haveChange = false;
  let firstSum = null;
  let lastSum = null;

  for (const b of buckets) {
    const ms = bucketStartMs(b);
    if (ms < sMs && b.state != null) anfang = Number(b.state); // Stand direkt vor Periodenbeginn
    if (ms < eMs && b.state != null) ende = Number(b.state); // Stand am Periodenende
    if (ms >= sMs && ms < eMs) {
      if (b.change != null) {
        kwh += Number(b.change);
        haveChange = true;
      }
      if (b.sum != null) {
        if (firstSum === null) firstSum = Number(b.sum);
        lastSum = Number(b.sum);
      }
    }
  }

  if (!haveChange) {
    if (firstSum != null && lastSum != null) kwh = lastSum - firstSum;
    else return null; // keine verwertbaren Daten
  }
  return { anfang, ende, kwh: round2(kwh) };
}

/**
 * Ermittelt je Zähler Anfangsstand/Endstand/kWh für die Periode.
 * Priorität: HA-Statistics (robust) -> eigenes Polling (Fallback).
 * Reine Datenbeschaffung; die Geldbeträge macht computeBilling.
 * @param {object} [opts] { ha } – für Tests injizierbar
 */
async function resolvePeriodReadings(config, snapshots, period, opts = {}) {
  const ha = opts.ha || haClient;
  const useStats = config.useStatistics !== false;
  const anfangTarget = toDateStr(addDays(period.start, -1));
  const endeTarget = toDateStr(addDays(period.end, -1));
  const out = {};

  for (const meter of config.meters || []) {
    const warnings = [];
    let stats = null;

    if (useStats) {
      try {
        stats = await fromStatistics(meter.entityId, period, ha);
      } catch (err) {
        warnings.push('HA-Statistik nicht erreichbar, Fallback Polling: ' + (err.message || err));
      }
    }

    if (stats && Number.isFinite(stats.kwh)) {
      if (stats.anfang != null && stats.ende != null) {
        const rawDiff = round2(stats.ende - stats.anfang);
        if (Math.abs(rawDiff - stats.kwh) > 0.5) {
          warnings.push('Zähler-Reset im Zeitraum – kWh reset-sicher aus Statistik übernommen');
        }
      }
      if (stats.anfang == null) warnings.push('kein Anfangsstand in Statistik');
      if (stats.ende == null) warnings.push('kein Endstand in Statistik');
      out[meter.id] = {
        ...meterBase(meter),
        anfang: stats.anfang,
        anfangDatum: anfangTarget,
        ende: stats.ende,
        endeDatum: endeTarget,
        kwh: stats.kwh,
        source: 'statistics',
        warnings,
      };
      continue;
    }

    // Fallback: eigene bereinigte Polling-Zählerstände
    const daily = (snapshots[meter.entityId] || {}).daily || {};
    const a = valueAtOrBefore(daily, anfangTarget);
    const e = valueAtOrBefore(daily, endeTarget);
    let kwh = null;
    if (a.value == null || e.value == null) {
      warnings.push('keine Zählerstände im Zeitraum (Polling)');
    } else {
      kwh = round2(e.value - a.value);
      if (kwh < 0) warnings.push('negativer Verbrauch (Datenlücke/Reset?)');
      if (a.date !== anfangTarget) warnings.push(`Anfangsstand vom ${a.date} statt ${anfangTarget}`);
      if (e.date !== endeTarget) warnings.push(`Endstand vom ${e.date} statt ${endeTarget}`);
    }
    out[meter.id] = {
      ...meterBase(meter),
      anfang: a.value,
      anfangDatum: a.date,
      ende: e.value,
      endeDatum: e.date,
      kwh,
      source: 'poll',
      warnings,
    };
  }

  // Virtuelle, fortlaufende Zähler: Stand aus dem gespeicherten virtuellen Verlauf.
  // Der ist per Konstruktion stetig (auch über Zählertausch), daher ist kWh = Ende − Anfang korrekt.
  for (const vm of config.virtualMeters || []) {
    const warnings = [];
    const daily = (snapshots['virtual:' + vm.id] || {}).daily || {};
    const a = valueAtOrBefore(daily, anfangTarget);
    const e = valueAtOrBefore(daily, endeTarget);
    let kwh = null;
    if (a.value == null || e.value == null) warnings.push('virtueller Zähler ohne Verlauf im Zeitraum');
    else kwh = round2(e.value - a.value);
    out[vm.id] = {
      meterId: vm.id,
      name: vm.name,
      entityId: 'virtual:' + vm.id,
      role: vm.role,
      roleLabel: ROLE_LABEL[vm.role] || vm.role,
      anfang: a.value,
      anfangDatum: a.date,
      ende: e.value,
      endeDatum: e.date,
      kwh,
      source: 'virtual',
      virtual: true,
      warnings,
    };
  }

  return out;
}

module.exports = { resolvePeriodReadings, fromStatistics, valueAtOrBefore, round2, ROLE_LABEL };
