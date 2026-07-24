'use strict';

const haClient = require('../ha/haClient');
const { round2, valueAtOrBefore } = require('../billing/resolver');
const { ROLE_SIGN } = require('../billing/billing');
const { toDateStr } = require('../billing/periods');

function bucketStartMs(b) {
  return typeof b.start === 'number' ? b.start : Date.parse(b.start);
}

function dayKey(ts) {
  return toDateStr(new Date(ts));
}
function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Erwartete Perioden-Buckets (neueste rechts).
function expectedBuckets(granularity, count) {
  const arr = [];
  if (granularity === 'month') {
    const now = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      arr.push({ key: monthKey(d.getTime()), label: d.toLocaleDateString('de-DE', { month: 'short', year: '2-digit' }), start: d });
    }
  } else {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(base);
      d.setDate(d.getDate() - i);
      arr.push({ key: dayKey(d.getTime()), label: d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }), start: d });
    }
  }
  return arr;
}

// kWh je Bucket aus den bereinigten Polling-Tageswerten (Fallback, nur Tagesauflösung sinnvoll).
function seriesFromSnapshots(daily, buckets, granularity) {
  const keyFn = granularity === 'month' ? monthKey : dayKey;
  const map = {};
  for (const b of buckets) map[b.key] = null;
  const dates = Object.keys(daily).sort();
  // Referenz-Anfangsstand: letzter Tageswert VOR dem ersten Bucket
  let prev = null;
  const firstKey = buckets[0].key;
  for (const dstr of dates) {
    if (keyFn(new Date(dstr).getTime()) < firstKey) prev = daily[dstr];
  }
  // pro Bucket: Endstand des Buckets minus Endstand des Vor-Buckets
  for (const b of buckets) {
    // letzter daily-Wert, dessen Datum in diesen Bucket (oder davor) fällt
    let val = null;
    for (const dstr of dates) {
      if (keyFn(new Date(dstr).getTime()) <= b.key) val = daily[dstr];
    }
    if (val != null && prev != null) map[b.key] = round2(val - prev);
    if (val != null) prev = val;
  }
  return map;
}

/**
 * Zeitreihe je Zähler für die Direktansicht (kein Mailversand).
 * @param {object} config
 * @param {{granularity?:'day'|'month', count?:number, ha?:object}} [opts]
 */
async function getSeries(config, opts = {}) {
  const ha = opts.ha || haClient;
  const granularity = opts.granularity === 'month' ? 'month' : 'day';
  const count = Math.min(Math.max(Number(opts.count) || (granularity === 'month' ? 12 : 30), 1), 366);
  const useStats = config.useStatistics !== false;

  const buckets = expectedBuckets(granularity, count);
  const startISO = new Date(buckets[0].start.getTime()).toISOString();
  const endISO = new Date(Date.now() + 86400000).toISOString();
  const keyFn = granularity === 'month' ? monthKey : dayKey;

  const meters = [];
  const totalsByMeter = {};
  const byMeterSeries = {};

  const items = [
    ...(config.meters || []).map((m) => ({ ...m, virtual: false })),
    ...(config.virtualMeters || []).map((v) => ({ ...v, virtual: true, entityId: 'virtual:' + v.id })),
  ];

  for (const meter of items) {
    let map = null;
    let source = meter.virtual ? 'virtual' : 'poll';

    if (meter.virtual) {
      const daily = (opts.snapshots && opts.snapshots['virtual:' + meter.id] && opts.snapshots['virtual:' + meter.id].daily) || {};
      map = seriesFromSnapshots(daily, buckets, granularity);
    } else if (useStats) {
      try {
        const res = await ha.statisticsDuringPeriod([meter.entityId], startISO, endISO, granularity);
        const rows = (res && res[meter.entityId]) || [];
        if (rows.length) {
          map = {};
          for (const b of buckets) map[b.key] = null;
          for (const r of rows) {
            const k = keyFn(bucketStartMs(r));
            if (k in map && r.change != null) map[k] = round2((map[k] || 0) + Number(r.change));
          }
          source = 'statistics';
        }
      } catch {
        map = null;
      }
    }
    if (!map) {
      const daily = (opts.snapshots && opts.snapshots[meter.entityId] && opts.snapshots[meter.entityId].daily) || {};
      map = seriesFromSnapshots(daily, buckets, granularity);
    }

    byMeterSeries[meter.id] = map;
    const sum = round2(Object.values(map).reduce((s, v) => s + (v || 0), 0));
    totalsByMeter[meter.id] = sum;
    meters.push({ id: meter.id, name: meter.name, entityId: meter.entityId, role: meter.role, virtual: !!meter.virtual, source, total: sum });
  }

  // € netto je Periode (ohne Grundgebühr – die gehört zur Abrechnungsperiode)
  const tariffs = config.tariffs || {};
  const periods = buckets.map((b) => {
    const byMeter = {};
    let euro = 0;
    for (const meter of items) {
      const kwh = byMeterSeries[meter.id][b.key];
      byMeter[meter.id] = kwh;
      const sign = ROLE_SIGN[meter.role] ?? 0;
      if (kwh != null && sign !== 0) euro += sign * kwh * Number(tariffs[meter.role] || 0);
    }
    return { key: b.key, label: b.label, byMeter, euro: round2(euro) };
  });

  return { granularity, count, meters, periods, totalsByMeter };
}

module.exports = { getSeries };
