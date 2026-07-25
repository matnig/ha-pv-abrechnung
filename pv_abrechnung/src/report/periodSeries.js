'use strict';

// Zeitreihen je Abrechnungsperiode für die Diagramme in Bericht und Oberfläche.
//
// Granularität richtet sich nach der Periode:
//   Tag   -> Stunden (0h..23h)      Woche -> Wochentage (Mo..So)
//   Monat -> Tage (1..31)           Jahr  -> Monate (Jan..Dez)
// Zusätzlich wird die gleich lange Vorperiode als Vergleich geladen (blasse Balken).
//
// Wie überall werden die `state`-Stände der Statistik verwendet und daraus monotone Zuwächse
// gebildet (Rücksprünge/Resets -> 0), damit 0-Glitches die Kurven nicht verfälschen.

const { unitFactorToKwh } = require('../ha/haClient');
const { bucketStartMs } = require('../ha/statistics');

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const ROLES = ['erzeugung', 'verbrauch', 'netzbezug', 'einspeisung'];
const round = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const dayStart = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * Monotone Zuwächse (kWh) aus aufeinanderfolgenden Statistik-Buckets.
 *
 * WICHTIG: Bei einem Rücksprung (Tasmota sendet nach einem Update kurz 0, Zähler-Reset o.ä.)
 * wird der bisherige Stand GEHALTEN und nicht auf den Glitch-Wert gesenkt. Sonst zählt der
 * Rücksprung auf 0 beim nächsten echten Wert als riesiger Zuwachs (z.B. 37 MWh statt 20 kWh)
 * und ein einziger Ausreißer macht die gesamte Kurve unsichtbar. Gleiche Regel wie in
 * ha/statistics.js (dailyCumKwh).
 */
function bucketDeltas(rows, factor) {
  const pts = (rows || [])
    .map((r) => ({ ms: bucketStartMs(r), val: r.state != null ? Number(r.state) : r.sum != null ? Number(r.sum) : null }))
    .filter((p) => p.val != null && Number.isFinite(p.val) && Number.isFinite(p.ms))
    .sort((a, b) => a.ms - b.ms);
  const out = [];
  let running = null; // höchster bisher gesehener Stand (monoton)
  for (const p of pts) {
    const v = p.val * factor;
    if (running == null) {
      running = v;
      continue;
    }
    if (v > running) {
      out.push({ ms: p.ms, delta: v - running });
      running = v; // echter Anstieg -> übernehmen
    } else {
      out.push({ ms: p.ms, delta: 0 }); // Rückwärts-Glitch -> Stand halten
    }
  }
  return out;
}

/** Bucket-Raster (Anzahl, Index-Funktion, Beschriftung) für eine Periode. */
function bucketing(periodType, start, end) {
  if (periodType === 'day') {
    return { granularity: 'hour', count: 24, labels: Array.from({ length: 24 }, (_, i) => `${i}h`), idx: (d) => d.getHours() };
  }
  if (periodType === 'year') {
    return { granularity: 'month', count: 12, labels: MONTHS.slice(), idx: (d) => d.getMonth() };
  }
  if (periodType === 'week') {
    return { granularity: 'day', count: 7, labels: WEEKDAYS.slice(), idx: (d) => (d.getDay() + 6) % 7 };
  }
  // Monat (oder beliebiger Zeitraum): Tage ab Periodenbeginn
  const s = dayStart(start);
  const count = Math.max(1, Math.round((dayStart(end - 1) - s) / 86400000) + 1);
  return {
    granularity: 'day',
    count,
    labels: Array.from({ length: count }, (_, i) => String(new Date(s + i * 86400000).getDate())),
    idx: (d) => Math.round((dayStart(d.getTime()) - s) / 86400000),
  };
}

/**
 * Baut die Diagramm-Daten für eine Periode.
 * @param {object} period  { type, label, start, end }
 * @returns {Promise<object|null>} { granularity, labels, periodLabel, comparisonLabel, hasPrev, series, sunHours }
 */
async function buildPeriodSeries(config, period, ha) {
  const meters = {};
  for (const role of ROLES) {
    const m = (config.meters || []).find((x) => x.role === role && x.entityId);
    if (m) meters[role] = m;
  }
  if (!Object.keys(meters).length) return null;

  const startMs = new Date(period.start).getTime();
  const endMs = Math.min(new Date(period.end).getTime(), Date.now());
  const span = new Date(period.end).getTime() - startMs;
  const prevStartMs = startMs - span;
  const b = bucketing(period.type, startMs, new Date(period.end).getTime());
  // Etwas früher laden, damit der erste Bucket einen Vorgängerwert für das Delta hat.
  const lead = b.granularity === 'hour' ? 3600000 : b.granularity === 'day' ? 86400000 : 31 * 86400000;
  const fetchStartISO = new Date(prevStartMs - lead).toISOString();
  const fetchEndISO = new Date(endMs).toISOString();

  const series = {};
  let haError = null;
  for (const [role, m] of Object.entries(meters)) {
    const factor = unitFactorToKwh(m.unit || 'kWh') || 1;
    let rows = [];
    try {
      const res = await ha.statisticsDuringPeriod([m.entityId], fetchStartISO, fetchEndISO, b.granularity);
      rows = (res && res[m.entityId]) || [];
    } catch (e) {
      haError = String((e && e.message) || e);
    }
    const values = new Array(b.count).fill(0);
    const prevValues = new Array(b.count).fill(0);
    for (const d of bucketDeltas(rows, factor)) {
      const dt = new Date(d.ms);
      if (d.ms >= startMs && d.ms < endMs) {
        const i = b.idx(dt);
        if (i >= 0 && i < b.count) values[i] = round(values[i] + d.delta);
      } else if (d.ms >= prevStartMs && d.ms < startMs) {
        // Vorperiode auf dasselbe Raster legen (Tag 1 vs. Tag 1, Stunde 0 vs. Stunde 0).
        const i = period.type === 'month' ? Math.round((dayStart(d.ms) - dayStart(prevStartMs)) / 86400000) : b.idx(dt);
        if (i >= 0 && i < b.count) prevValues[i] = round(prevValues[i] + d.delta);
      }
    }
    const sum = round(values.reduce((a, x) => a + x, 0));
    const prevSum = round(prevValues.reduce((a, x) => a + x, 0));
    series[role] = { name: m.name, values, prevValues, sum, prevSum: prevSum > 0 ? prevSum : 0 };
  }

  // Sonnenstunden (Stunden mit nennenswerter PV-Erzeugung). Beim Tagesbericht liegen die
  // Stundendaten schon vor; für Woche/Monat einmalig stündlich nachladen. Beim Jahr zu viele
  // Buckets -> weggelassen.
  let sunHours = null;
  const erzMeter = meters.erzeugung;
  if (erzMeter) {
    if (b.granularity === 'hour') {
      sunHours = {
        current: series.erzeugung.values.filter((v) => v > 0.05).length,
        previous: series.erzeugung.prevValues.filter((v) => v > 0.05).length,
      };
    } else if (period.type === 'week' || period.type === 'month') {
      try {
        const factor = unitFactorToKwh(erzMeter.unit || 'kWh') || 1;
        const res = await ha.statisticsDuringPeriod([erzMeter.entityId], new Date(prevStartMs - 3600000).toISOString(), fetchEndISO, 'hour');
        const deltas = bucketDeltas((res && res[erzMeter.entityId]) || [], factor);
        sunHours = {
          current: deltas.filter((d) => d.ms >= startMs && d.ms < endMs && d.delta > 0.05).length,
          previous: deltas.filter((d) => d.ms >= prevStartMs && d.ms < startMs && d.delta > 0.05).length,
        };
      } catch {
        /* optional – ohne Sonnenstunden weiter */
      }
    }
  }

  const comparisonLabel = { day: 'Vortag', week: 'Vorwoche', month: 'Vormonat', year: 'Vorjahr' }[period.type] || 'Vorperiode';
  const hasPrev = Object.values(series).some((s) => s.prevSum > 0);
  return {
    granularity: b.granularity,
    labels: b.labels,
    periodLabel: period.type === 'day' ? 'Heute/Berichtstag' : period.label,
    comparisonLabel,
    hasPrev,
    series,
    sunHours,
    haError,
  };
}

module.exports = { buildPeriodSeries, bucketDeltas, bucketing };
