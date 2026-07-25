'use strict';

// Stündliches Jahresprofil aus der HA-Langzeitstatistik – Grundlage jeder Simulation.
//
// Gearbeitet wird mit ECHTEN Messreihen statt Faustformeln: für jede Stunde des
// Betrachtungszeitraums Erzeugung, Netzbezug, Einspeisung und der daraus abgeleitete
// Verbrauch. Damit lässt sich exakt nachrechnen, wo eine zusätzliche kWh landet
// (Kundenlieferung oder Einspeisung) – der entscheidende Punkt für die Wirtschaftlichkeit.
//
// Die Datenlage wird offen ausgewiesen (`coverage`): wie viele Stunden vorhanden sind, wie
// lang der Zeitraum ist und ob er für eine Jahresaussage reicht. Fehlt zu viel, sagt die
// Bewertung das ausdrücklich, anstatt eine Scheingenauigkeit zu erzeugen.

const { unitFactorToKwh } = require('../ha/haClient');
const { bucketDeltas } = require('../report/periodSeries');

const HOUR = 3600000;
const round = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

/**
 * @param {object} config
 * @param {object} ha       haClient (oder Stub mit statisticsDuringPeriod)
 * @param {object} [opts]   { months?:number, now?:number }
 */
async function buildHourlyProfile(config, ha, opts = {}) {
  const months = opts.months || 12;
  const now = opts.now || Date.now();
  const end = new Date(now);
  end.setMinutes(0, 0, 0);
  const start = new Date(end.getTime());
  start.setMonth(start.getMonth() - months);

  const roles = ['erzeugung', 'einspeisung', 'netzbezug', 'verbrauch'];
  const meters = {};
  for (const role of roles) {
    const m = (config.meters || []).find((x) => x.role === role && x.entityId);
    if (m) meters[role] = m;
  }

  const raw = {};
  const errors = [];
  for (const [role, m] of Object.entries(meters)) {
    const factor = unitFactorToKwh(m.unit || 'kWh') || 1;
    try {
      const res = await ha.statisticsDuringPeriod([m.entityId], new Date(start.getTime() - HOUR).toISOString(), end.toISOString(), 'hour');
      raw[role] = bucketDeltas((res && res[m.entityId]) || [], factor); // glitch-sicher (Monotonie)
    } catch (e) {
      errors.push(`${role}: ${(e && e.message) || e}`);
      raw[role] = [];
    }
  }

  // Auf ein gemeinsames Stundenraster legen.
  const startH = Math.floor(start.getTime() / HOUR);
  const endH = Math.floor(end.getTime() / HOUR);
  const len = Math.max(0, endH - startH);
  const mk = () => new Array(len).fill(0);
  const series = { erzeugung: mk(), einspeisung: mk(), netzbezug: mk(), verbrauch: mk() };
  const seen = { erzeugung: 0, einspeisung: 0, netzbezug: 0, verbrauch: 0 };

  for (const role of roles) {
    for (const d of raw[role] || []) {
      const i = Math.floor(d.ms / HOUR) - startH;
      if (i < 0 || i >= len) continue;
      series[role][i] = round(series[role][i] + d.delta);
      if (d.delta > 0) seen[role]++;
    }
  }

  // Verbrauch (Last hinter dem Zähler) ableiten, falls kein eigener Verbrauchszähler existiert:
  //   Verbrauch = Erzeugung − Einspeisung + Netzbezug
  const derivedConsumption = !meters.verbrauch && !!meters.erzeugung;
  if (derivedConsumption) {
    for (let i = 0; i < len; i++) {
      series.verbrauch[i] = round(Math.max(0, series.erzeugung[i] - series.einspeisung[i] + series.netzbezug[i]));
    }
  }

  // Eigenverbrauch je Stunde = Erzeugung − Einspeisung (nie negativ)
  const eigen = mk();
  for (let i = 0; i < len; i++) eigen[i] = round(Math.max(0, series.erzeugung[i] - series.einspeisung[i]));

  const sum = (a) => round((a || []).reduce((x, y) => x + y, 0));
  const hoursWithData = Math.max(seen.erzeugung, seen.netzbezug, seen.einspeisung);
  const days = len / 24;
  const totals = {
    erzeugung: sum(series.erzeugung),
    einspeisung: sum(series.einspeisung),
    netzbezug: sum(series.netzbezug),
    verbrauch: sum(series.verbrauch),
    eigenverbrauch: sum(eigen),
  };

  // Wie belastbar ist die Datenlage?
  const coverage = {
    // Startzeitpunkt des Rasters. Wichtig für Verbraucher: der Index eines Stundenwerts sagt
    // NICHT die Tageszeit – die muss über startMs + i Stunden bestimmt werden (Zeitzone!).
    startMs: startH * HOUR,
    hours: len,
    days: Math.round(days),
    hoursWithData,
    ratio: len ? round(hoursWithData / len) : 0,
    fullYear: days >= 350,
    months: Math.round(days / 30.4),
    start: start.toISOString(),
    end: end.toISOString(),
    derivedConsumption,
    missingRoles: roles.filter((r) => r !== 'verbrauch' && !meters[r]),
    errors,
  };
  // Skalierungsfaktor auf ein Jahr (bei kürzeren Zeiträumen). Bewusst konservativ: nur über
  // die tatsächlich abgedeckte Zeit, mit klarer Kennzeichnung als Hochrechnung.
  coverage.yearFactor = days > 0 ? round(365 / days) : 0;

  return { series, eigenverbrauch: eigen, totals, coverage, meters: Object.keys(meters) };
}

/** Eigenverbrauchsquote und Autarkiegrad aus Summen (in Prozent, eine Dezimalstelle). */
function shares(totals) {
  const eigen = totals.eigenverbrauch || 0;
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  return {
    eigenverbrauchsquote: pct(eigen, totals.erzeugung),
    autarkie: pct(eigen, totals.verbrauch),
  };
}

module.exports = { buildHourlyProfile, shares };
