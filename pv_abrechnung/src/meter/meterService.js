'use strict';

const { readJson, writeJson } = require('../store/store');
const haClient = require('../ha/haClient');
const { processReading, swapMeter } = require('./meterProcessor');
const { toDateStr } = require('../billing/periods');

const SNAP_FILE = 'snapshots.json';
const MAX_ANOMALIES = 500;

function loadSnapshots() {
  return readJson(SNAP_FILE, {});
}
function saveSnapshots(snap) {
  writeJson(SNAP_FILE, snap);
}

const UNAVAILABLE = new Set(['unavailable', 'unknown', 'none', '', null, undefined]);

/**
 * Liest alle konfigurierten Zähler einmal aus, validiert, pflegt den offenen
 * Störungs-Zustand (incident) und liefert fällige Eskalations-Alarme zurück.
 * Sendet KEINE Mails – das macht der Aufrufer (engine.runPoll).
 * @param {object} config
 * @param {{now?:number, getState?:Function}} [opts]
 */
async function pollOnce(config, opts = {}) {
  const now = opts.now || Date.now();
  const getState = opts.getState || haClient.getState;
  const mc = config.meterCfg || {};
  const investigateAfter = mc.investigateAfterMinutes ?? 10;
  const faultAfter = mc.faultAfterMinutes ?? 120;

  const snap = loadSnapshots();
  const results = [];
  const alerts = [];
  const dayKey = toDateStr(new Date(now));

  for (const meter of config.meters || []) {
    if (!meter.entityId) continue;
    const entry = snap[meter.entityId] || { state: null, daily: {}, anomalies: [], incident: null };

    let st;
    try {
      st = await getState(meter.entityId);
    } catch (err) {
      // HA nicht erreichbar (z.B. transienter 502 direkt nach Add-on-Neustart) -> KEINE
      // "unavailable"-Markierung und NICHT in die Auffälligkeiten schreiben (transient/erwartet):
      // letzten Stand behalten, Zähler überspringen, nur ins Log.
      console.warn(`[poll] ${meter.entityId} übersprungen (HA nicht erreichbar): ${err.message || err}`);
      entry.outages = (entry.outages || []).concat(now).slice(-1000); // Ausfall (HA nicht erreichbar)
      snap[meter.entityId] = entry;
      results.push({ entityId: meter.entityId, name: meter.name, effective: entry.lastEffective, updated: false, incident: !!entry.incident, anomalies: [] });
      continue;
    }

    const unit = (st.attributes && st.attributes.unit_of_measurement) || '';
    const factor = haClient.unitFactorToKwh(unit);
    entry.unit = unit;
    entry.unitFactor = factor;
    const available = !UNAVAILABLE.has(st.state);
    if (!available) entry.outages = (entry.outages || []).concat(now).slice(-1000); // Ausfall (Sensor unavailable)
    // Rohwert immer auf kWh normalisieren (Wh/MWh -> kWh), damit alle Berechnungen in kWh laufen.
    const n = Number(String(st.state).replace(',', '.'));
    const rawKwh = available && Number.isFinite(n) ? n * factor : st.state;
    const lu = st.last_updated ? Date.parse(st.last_updated) : st.last_changed ? Date.parse(st.last_changed) : NaN;
    const reading = { raw: rawKwh, available, now, lastUpdated: Number.isFinite(lu) ? lu : null };

    const out = processReading(entry.state, reading, mc);
    entry.state = out.state;
    entry.lastEffective = out.effective;
    entry.lastTs = now;
    if (out.effective != null) entry.daily[dayKey] = out.effective;
    for (const a of out.anomalies) entry.anomalies.push({ ...a, entityId: meter.entityId, name: meter.name });
    if (entry.anomalies.length > MAX_ANOMALIES) entry.anomalies = entry.anomalies.slice(-MAX_ANOMALIES);

    // Störungs-Lebenszyklus anhand des offenen pending-Zustands
    if (out.state.pending) {
      if (!entry.incident) {
        entry.incident = { since: out.state.pending.since, name: meter.name, notifiedInvestigating: false, notifiedFault: false };
      }
      entry.incident.oldFinal = out.state.pending.anchorRaw;
      entry.incident.current = out.state.pending.current;
      const ageMin = (now - entry.incident.since) / 60000;
      if (ageMin >= investigateAfter && !entry.incident.notifiedInvestigating) {
        alerts.push({ entityId: meter.entityId, name: meter.name, kind: 'investigating', since: entry.incident.since, ageMin: Math.round(ageMin), oldFinal: entry.incident.oldFinal, current: entry.incident.current });
      }
      if (ageMin >= faultAfter && !entry.incident.notifiedFault) {
        alerts.push({ entityId: meter.entityId, name: meter.name, kind: 'fault', since: entry.incident.since, ageMin: Math.round(ageMin), oldFinal: entry.incident.oldFinal, current: entry.incident.current });
      }
    } else if (entry.incident) {
      // pending aufgelöst (Wert zurückgekehrt) -> Störung geschlossen
      entry.incident = null;
    }

    snap[meter.entityId] = entry;
    results.push({ entityId: meter.entityId, name: meter.name, effective: out.effective, updated: out.updated, incident: !!entry.incident, anomalies: out.anomalies.map((a) => a.type) });
  }

  // Virtuelle, fortlaufende Zähler aus den bereinigten Ständen der echten Zähler.
  for (const vm of config.virtualMeters || []) {
    const vkey = 'virtual:' + vm.id;
    const ventry = snap[vkey] || { daily: {}, anomalies: [], isVirtual: true };
    let ok = true;
    for (const comp of vm.components || []) {
      const ce = snap[comp.entityId];
      if (!ce || ce.lastEffective == null) {
        ok = false;
        break;
      }
    }
    if (ok) {
      // Basislinie verhindert negative Absolutwerte (Zähler mit versch. Nullpunkten).
      // Ohne Backfill: aktuelle Stände als Basislinie -> virtueller Zähler startet bei 0.
      if (!ventry.baselinePoll) {
        ventry.baselinePoll = {};
        for (const comp of vm.components) ventry.baselinePoll[comp.entityId] = snap[comp.entityId].lastEffective;
      }
      let eff = 0;
      for (const comp of vm.components) {
        const base = ventry.baselinePoll[comp.entityId] != null ? ventry.baselinePoll[comp.entityId] : snap[comp.entityId].lastEffective;
        eff += Number(comp.factor || 0) * (snap[comp.entityId].lastEffective - base);
      }
      eff = Math.max(0, Math.round((eff + Number.EPSILON) * 1000) / 1000);
      ventry.lastEffective = eff;
      ventry.lastTs = now;
      ventry.daily[dayKey] = eff;
    }
    snap[vkey] = ventry;
  }

  saveSnapshots(snap);
  return { at: now, meters: results, alerts };
}

/** Setzt nach erfolgreichem Mailversand die Benachrichtigungs-Flag + Report-Anomalie. */
function commitAlert(entityId, kind, now = Date.now()) {
  const snap = loadSnapshots();
  const e = snap[entityId];
  if (!e || !e.incident) return;
  if (kind === 'investigating') {
    e.incident.notifiedInvestigating = true;
    e.anomalies.push({ type: 'investigating', at: now, entityId, name: e.incident.name, from: e.incident.oldFinal });
  } else if (kind === 'fault') {
    e.incident.notifiedFault = true;
    e.anomalies.push({ type: 'technical_fault', at: now, entityId, name: e.incident.name, from: e.incident.oldFinal });
  }
  saveSnapshots(snap);
}

/** Offene Störungen für die Oberfläche. */
function openIncidents() {
  const snap = loadSnapshots();
  return Object.entries(snap)
    .filter(([, e]) => e.incident)
    .map(([entityId, e]) => ({ entityId, ...e.incident }));
}

/** Manuell bestätigter Zählertausch über die Oberfläche. */
function applySwap(entityId, now = Date.now()) {
  const snap = loadSnapshots();
  const e = snap[entityId];
  if (!e || !e.state) return { swapped: false, error: 'Zähler unbekannt' };
  const res = swapMeter(e.state, now);
  if (!res.swapped) return { swapped: false, error: 'keine offene Störung' };
  const incidentName = (e.incident && e.incident.name) || entityId;
  e.state = res.state;
  e.lastEffective = res.state.effective;
  e.daily[toDateStr(new Date(now))] = res.state.effective;
  e.incident = null;
  e.anomalies.push({ type: 'meter_swap', at: now, entityId, name: incidentName, oldFinal: res.oldFinal, newStart: res.newStart, manual: true });
  saveSnapshots(snap);
  return res;
}

module.exports = { pollOnce, loadSnapshots, saveSnapshots, commitAlert, openIncidents, applySwap, SNAP_FILE };
