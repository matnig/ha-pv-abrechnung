'use strict';

// Homogene Tages-Übersicht: stündliche Energie (kWh) je Rolle für HEUTE und GESTERN aus der
// HA-Langzeitstatistik, plus abgeleitete „Sonnenstunden" (Stunden mit nennenswerter PV-Erzeugung)
// und eine kurze Status-Zusammenfassung. Fällt HA aus, wird `haError` gesetzt und leere Serien
// zurückgegeben (die Oberfläche bleibt bedienbar).

const { unitFactorToKwh } = require('../ha/haClient');
const { bucketStartMs } = require('../ha/statistics');
const { openIncidents } = require('../meter/meterService');
const reviews = require('../review/reviews');

const ROLES = ['erzeugung', 'verbrauch', 'netzbezug', 'einspeisung'];
const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function localDayStartMs(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Monotone stündliche Zuwächse (kWh) aus den `state`-Ständen der Statistik-Buckets.
function hourlyDeltas(rows, factor) {
  const pts = (rows || [])
    .map((r) => ({ ms: bucketStartMs(r), val: r.state != null ? Number(r.state) : r.sum != null ? Number(r.sum) : null }))
    .filter((p) => p.val != null && Number.isFinite(p.val) && Number.isFinite(p.ms))
    .sort((a, b) => a.ms - b.ms);
  const out = [];
  let prev = null;
  for (const p of pts) {
    const v = p.val * factor;
    if (prev != null) out.push({ ms: p.ms, delta: v > prev ? v - prev : 0 }); // Rückwärts/Reset -> 0
    prev = v;
  }
  return out;
}

async function buildOverview(config, snapshots, ha) {
  const now = Date.now();
  const todayStart = localDayStartMs(now);
  const ydayStart = todayStart - 86400000;
  const startISO = new Date(ydayStart).toISOString();
  const endISO = new Date(now).toISOString();

  const byRole = {};
  for (const role of ROLES) {
    const m = (config.meters || []).find((x) => x.role === role && x.entityId);
    if (m) byRole[role] = m;
  }

  const series = {};
  let haError = null;
  for (const role of Object.keys(byRole)) {
    const m = byRole[role];
    const factor = unitFactorToKwh(m.unit || 'kWh') || 1;
    let rows = [];
    try {
      const res = await ha.statisticsDuringPeriod([m.entityId], startISO, endISO, 'hour');
      rows = (res && res[m.entityId]) || [];
    } catch (e) {
      haError = String((e && e.message) || e);
    }
    const today = new Array(24).fill(0);
    const yesterday = new Array(24).fill(0);
    for (const d of hourlyDeltas(rows, factor)) {
      const hr = new Date(d.ms).getHours();
      if (d.ms >= todayStart) today[hr] = round(today[hr] + d.delta);
      else if (d.ms >= ydayStart) yesterday[hr] = round(yesterday[hr] + d.delta);
    }
    series[role] = {
      name: m.name,
      today,
      yesterday,
      todaySum: round(today.reduce((a, b) => a + b, 0)),
      ydaySum: round(yesterday.reduce((a, b) => a + b, 0)),
    };
  }

  // Sonnenstunden = Stunden mit nennenswerter PV-Erzeugung (>0,05 kWh).
  const sunH = (arr) => (arr || []).filter((v) => v > 0.05).length;
  const erz = series.erzeugung;
  const sunHours = { today: erz ? sunH(erz.today) : null, yesterday: erz ? sunH(erz.yesterday) : null };

  const anomaliesOpen = reviews.listAnomalies({ snapshots }).filter((a) => !a.review).length;
  const batteries = snapshots._batteries || (snapshots._battery ? [snapshots._battery] : []);

  return {
    at: now,
    roles: Object.keys(byRole),
    series,
    sunHours,
    summary: {
      meters: (config.meters || []).length,
      virtual: (config.virtualMeters || []).length,
      openIncidents: openIncidents().length,
      anomaliesOpen,
      batteries,
    },
    haError,
  };
}

module.exports = { buildOverview, hourlyDeltas };
