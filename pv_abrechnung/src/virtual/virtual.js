'use strict';

// Virtuelle Zähler als fortlaufender, NICHT-negativer Rechen-Zähler.
//
// Problem: Echte Zähler haben unterschiedliche Nullpunkte (z.B. Einspeisezähler
// zählt länger als der PV-Zähler). Die absolute Differenz ist daher sinnlos/negativ.
// Lösung: Ein Startdatum als Basislinie. Der virtuelle Wert ist die Summe der
// FAKTORISIERTEN ZUWÄCHSE aller Komponenten seit dem Startdatum, bei 0 gedeckelt:
//   V(d) = max(0, Σ factor_i · (cum_i(d) − cum_i(start)))
// cum_i = reset-sicherer kumulierter Wert aus der HA-Langzeitstatistik (`sum`),
// in kWh normalisiert. So ist V(start)=0 und wächst monoton – nie negativ.

const haClient = require('../ha/haClient');
const { toDateStr } = require('../billing/periods');

function bucketStartMs(b) {
  return typeof b.start === 'number' ? b.start : Date.parse(b.start);
}
function round3(n) {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}
function valueAtOrBefore(map, dateStr) {
  let best = null;
  for (const k of Object.keys(map)) if (k <= dateStr && (best === null || k > best)) best = k;
  return best === null ? null : map[best];
}

async function unitFactor(entityId, ha, snapshots) {
  const snap = snapshots && snapshots[entityId];
  if (snap && snap.unitFactor != null) return snap.unitFactor;
  try {
    const st = await ha.getState(entityId);
    return haClient.unitFactorToKwh((st.attributes && st.attributes.unit_of_measurement) || '');
  } catch {
    return 1;
  }
}

// Kumulierte Tageswerte (kWh) einer Komponente aus der LTS: { 'YYYY-MM-DD': cumKwh }.
async function componentDailyCum(entityId, startISO, endISO, ha, snapshots) {
  const res = await ha.statisticsDuringPeriod([entityId], startISO, endISO, 'day');
  const rows = (res && res[entityId]) || [];
  const factor = await unitFactor(entityId, ha, snapshots);
  const byDate = {};
  for (const r of rows) {
    if (r.sum == null) continue;
    byDate[toDateStr(new Date(bucketStartMs(r)))] = Number(r.sum) * factor;
  }
  return byDate;
}

// Frühestes Datum, an dem ALLE Komponenten Statistikdaten haben.
async function earliestCommonDate(components, ha, snapshots) {
  const now = new Date();
  const startISO = new Date(now.getFullYear() - 6, 0, 1).toISOString();
  const endISO = new Date(now.getTime() + 86400000).toISOString();
  let latestOfFirsts = null;
  for (const comp of components || []) {
    const cum = await componentDailyCum(comp.entityId, startISO, endISO, ha, snapshots);
    const dates = Object.keys(cum).sort();
    if (!dates.length) return null; // eine Komponente ohne Statistik
    const first = dates[0];
    if (latestOfFirsts === null || first > latestOfFirsts) latestOfFirsts = first;
  }
  return latestOfFirsts;
}

/**
 * Berechnet den virtuellen Zähler rückwirkend aus der HA-Statistik und speichert
 * den Tagesverlauf (nicht-negativ) in die Snapshots.
 * @returns {{startDate, earliest, days, first, last, currentStand}}
 */
async function backfillVirtual(vm, ha, snapshots) {
  const comps = vm.components || [];
  if (!comps.length) throw new Error('Virtueller Zähler ohne Komponenten');
  const now = new Date();

  const earliest = await earliestCommonDate(comps, ha, snapshots);
  let startDate = vm.startDate || earliest;
  if (!startDate) throw new Error('Keine Statistik für die Komponenten vorhanden');
  if (earliest && startDate < earliest) startDate = earliest; // nicht vor die ersten sinnvollen Werte

  const startISO = new Date(new Date(startDate + 'T00:00:00').getTime() - 86400000).toISOString();
  const endISO = new Date(now.getTime() + 86400000).toISOString();

  const cum = {};
  for (const comp of comps) cum[comp.entityId] = await componentDailyCum(comp.entityId, startISO, endISO, ha, snapshots);

  const baseline = {};
  for (const comp of comps) baseline[comp.entityId] = valueAtOrBefore(cum[comp.entityId], startDate) ?? 0;

  const allDates = new Set();
  for (const comp of comps) for (const d of Object.keys(cum[comp.entityId])) if (d >= startDate) allDates.add(d);
  const sortedDates = [...allDates].sort();

  const daily = {};
  for (const d of sortedDates) {
    let v = 0;
    let ok = true;
    for (const comp of comps) {
      const c = valueAtOrBefore(cum[comp.entityId], d);
      if (c == null) {
        ok = false;
        break;
      }
      v += Number(comp.factor || 0) * (c - baseline[comp.entityId]);
    }
    if (ok) daily[d] = Math.max(0, round3(v));
  }

  // Poll-Baseline, damit das Live-Polling nahtlos an den Backfill anschließt:
  // baselinePoll_i = effective_now_i − (cum_now_i − baseline_i)
  const baselinePoll = {};
  const today = toDateStr(now);
  for (const comp of comps) {
    const eff = (snapshots[comp.entityId] || {}).lastEffective;
    const cumNow = valueAtOrBefore(cum[comp.entityId], today);
    if (eff != null && cumNow != null) baselinePoll[comp.entityId] = eff - (cumNow - baseline[comp.entityId]);
  }

  const vkey = 'virtual:' + vm.id;
  const ventry = snapshots[vkey] || { isVirtual: true, anomalies: [] };
  ventry.daily = { ...(ventry.daily || {}), ...daily };
  ventry.baselinePoll = baselinePoll;
  ventry.startDate = startDate;
  const last = sortedDates.length ? sortedDates[sortedDates.length - 1] : null;
  if (last != null) ventry.lastEffective = daily[last];
  snapshots[vkey] = ventry;

  return { startDate, earliest, days: Object.keys(daily).length, first: sortedDates[0] || null, last, currentStand: ventry.lastEffective ?? null };
}

module.exports = { backfillVirtual, earliestCommonDate, componentDailyCum, valueAtOrBefore, round3 };
