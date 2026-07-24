'use strict';

// Gemeinsames Auslesen der HA-Langzeitstatistik als tägliche, monotone Zählerstände.
// Nutzt `state` (echter Zählerstand am Bucket-Ende), Fallback `sum`. `sum` wird von HA bei
// 0-Aussetzern/Resets aufgebläht (jeder Rücksprung addiert den vollen Wert), daher ungeeignet.
// Zusätzlich wird Monotonie erzwungen -> transiente 0-/Rückwärts-Glitches werden abgefangen.

const { toDateStr } = require('../billing/periods');

function bucketStartMs(b) {
  return typeof b.start === 'number' ? b.start : Date.parse(b.start);
}

/**
 * @returns {Promise<Object>} { 'YYYY-MM-DD': kumulierterStandKwh } (monoton steigend)
 */
async function dailyCumKwh(entityId, startISO, endISO, ha, factor = 1) {
  const res = await ha.statisticsDuringPeriod([entityId], startISO, endISO, 'day');
  const rows = (res && res[entityId]) || [];
  const pairs = [];
  for (const r of rows) {
    const raw = r.state != null ? r.state : r.sum;
    if (raw == null) continue;
    pairs.push({ date: toDateStr(new Date(bucketStartMs(r))), val: Number(raw) * factor });
  }
  pairs.sort((a, b) => (a.date < b.date ? -1 : 1));
  const byDate = {};
  let running = null;
  for (const p of pairs) {
    if (running == null || p.val >= running) running = p.val; // Anstieg übernehmen
    byDate[p.date] = running; // Rückwärts-Glitch -> Stand halten
  }
  return byDate;
}

function valueAtOrBefore(map, dateStr) {
  let best = null;
  for (const k of Object.keys(map)) if (k <= dateStr && (best === null || k > best)) best = k;
  return best === null ? null : map[best];
}

module.exports = { dailyCumKwh, valueAtOrBefore, bucketStartMs };
