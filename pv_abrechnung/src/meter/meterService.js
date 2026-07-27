'use strict';

const { readJson, writeJson } = require('../store/store');
const haClient = require('../ha/haClient');
const { processReading, swapMeter } = require('./meterProcessor');
const { checkBalance } = require('./plausibility');
const { toDateStr } = require('../billing/periods');

const SNAP_FILE = 'snapshots.json';
const MAX_ANOMALIES = 500;

function loadSnapshots() {
  return readJson(SNAP_FILE, {});
}
function saveSnapshots(snap) {
  writeJson(SNAP_FILE, snap);
}

const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

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
  // Stände vor diesem Durchlauf – daraus ergeben sich die Zuwächse für die Bilanzprüfung.
  const prevEffective = {};
  for (const m of config.meters || []) {
    if (m.entityId && snap[m.entityId]) prevEffective[m.entityId] = snap[m.entityId].lastEffective;
  }
  const results = [];
  const alerts = [];
  const dayKey = toDateStr(new Date(now));

  // Anhaltender Sensor-Ausfall (unavailable/HA nicht erreichbar) -> Eskalation per Mail,
  // 10 Min „möglicher Fehler", 2 Std „Störung" (analog zum Zählerabfall).
  const trackOffline = (entry, meter, isOutage) => {
    if (!isOutage) {
      entry.offline = null;
      return;
    }
    if (!entry.offline) entry.offline = { since: now, name: meter.name, notifiedInvestigating: false, notifiedFault: false };
    const ageMin = (now - entry.offline.since) / 60000;
    if (ageMin >= investigateAfter && !entry.offline.notifiedInvestigating) {
      alerts.push({ entityId: meter.entityId, name: meter.name, kind: 'offline_investigating', since: entry.offline.since, ageMin: Math.round(ageMin) });
    }
    if (ageMin >= faultAfter && !entry.offline.notifiedFault) {
      alerts.push({ entityId: meter.entityId, name: meter.name, kind: 'offline_fault', since: entry.offline.since, ageMin: Math.round(ageMin) });
    }
  };

  // Phase 1: alle Zählerstände einlesen, noch ohne Bewertung. Nötig, damit die
  // Plausibilitätsprüfung unten weiß, ob ZEITGLEICH ein anderer Zähler hochzählt.
  const fetched = [];
  for (const meter of config.meters || []) {
    if (!meter.entityId) continue;
    const entry = snap[meter.entityId] || { state: null, daily: {}, anomalies: [], incident: null };
    try {
      fetched.push({ meter, entry, st: await getState(meter.entityId), error: null });
    } catch (err) {
      fetched.push({ meter, entry, st: null, error: err });
    }
  }

  // Phase 2: Welche Zähler zählen gerade hoch? Ein stillstehender Zähler ist dadurch erklärt
  // (PV speist ein -> Netzbezug steht still) und darf keinen "stale"-Alarm auslösen.
  const activeIds = new Set();
  for (const f of fetched) {
    if (!f.st) continue;
    const n = Number(String(f.st.state).replace(',', '.'));
    if (!Number.isFinite(n)) continue;
    const rawKwh = n * haClient.unitFactorToKwh((f.st.attributes && f.st.attributes.unit_of_measurement) || '');
    const prevRaw = f.entry.state ? f.entry.state.lastRaw : null;
    if (prevRaw != null && rawKwh > prevRaw + 1e-9) activeIds.add(f.meter.entityId);
  }

  // Phase 3: bewerten.
  for (const f of fetched) {
    const { meter, entry, st } = f;
    if (!st) {
      // HA nicht erreichbar (z.B. transienter 502 direkt nach Add-on-Neustart) -> KEINE
      // "unavailable"-Markierung und NICHT in die Auffälligkeiten schreiben (transient/erwartet):
      // letzten Stand behalten, Zähler überspringen, nur ins Log.
      console.warn(`[poll] ${meter.entityId} übersprungen (HA nicht erreichbar): ${f.error && (f.error.message || f.error)}`);
      entry.outages = (entry.outages || []).concat(now).slice(-1000); // Ausfall (HA nicht erreichbar)
      trackOffline(entry, meter, true);
      snap[meter.entityId] = entry;
      results.push({ entityId: meter.entityId, name: meter.name, effective: entry.lastEffective, updated: false, incident: !!(entry.incident || entry.offline), anomalies: [] });
      continue;
    }

    const unit = (st.attributes && st.attributes.unit_of_measurement) || '';
    const factor = haClient.unitFactorToKwh(unit);
    entry.unit = unit;
    entry.unitFactor = factor;
    const available = !UNAVAILABLE.has(st.state);
    if (!available) entry.outages = (entry.outages || []).concat(now).slice(-1000); // Ausfall (Sensor unavailable)
    trackOffline(entry, meter, !available);
    // Rohwert immer auf kWh normalisieren (Wh/MWh -> kWh), damit alle Berechnungen in kWh laufen.
    const n = Number(String(st.state).replace(',', '.'));
    const rawKwh = available && Number.isFinite(n) ? n * factor : st.state;
    const lu = st.last_updated ? Date.parse(st.last_updated) : st.last_changed ? Date.parse(st.last_changed) : NaN;
    // `last_reported` (HA >= 2024.8) wird bei jedem Melden gesetzt, auch wenn der Wert gleich
    // bleibt -> damit unterscheidet sich "Sensor lebt, Zähler steht still" von "Sensor tot".
    const lr = st.last_reported ? Date.parse(st.last_reported) : NaN;
    const reading = {
      raw: rawKwh,
      available,
      now,
      lastUpdated: Number.isFinite(lu) ? lu : null,
      lastReported: Number.isFinite(lr) ? lr : null,
      peersActive: [...activeIds].some((id) => id !== meter.entityId),
    };

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

  // Optionale Akku-Ladestände (%) – informativ nur für den Status (Fehlalarm-Erkennung),
  // nicht im Bericht. Mehrere Akkus möglich; Einzel-Sensor aus Alt-Config wird migriert.
  const batteries = config.batteries && config.batteries.length
    ? config.batteries
    : config.batterySensor
      ? [{ id: 'bat_legacy', name: 'Akku', entityId: config.batterySensor }]
      : [];
  if (batteries.length) {
    const arr = [];
    for (const b of batteries) {
      if (!b.entityId) continue;
      try {
        const st = await getState(b.entityId);
        const v = Number(String(st.state).replace(',', '.'));
        arr.push({
          id: b.id,
          entityId: b.entityId,
          name: b.name || (st.attributes && st.attributes.friendly_name) || b.entityId,
          value: Number.isFinite(v) ? v : null,
          unit: (st.attributes && st.attributes.unit_of_measurement) || '%',
          kwh: Number(b.kwh) || null, // nutzbare Kapazität – nötig für die Energiebilanz
          ts: now,
        });
      } catch {
        // transient -> letzten bekannten Wert behalten
        const prev = (snap._batteries || []).find((x) => x.entityId === b.entityId);
        if (prev) arr.push({ ...prev, name: b.name || prev.name });
      }
    }
    snap._batteries = arr;
  } else {
    delete snap._batteries;
  }
  delete snap._battery; // altes Einzel-Feld wird nicht mehr gepflegt

  // --- Plausibilitätsprüfung der Energiebilanz ---------------------------------------------
  // Prüft, ob Erzeugung, Einspeisung, Netzbezug, Verbrauch und die Akku-Energie im abgelaufenen
  // Intervall zueinander passen. Das ersetzt die frühere „Wert steht still"-Meldung, die bei
  // Energiezählern zwangsläufig Fehlalarme erzeugt hat.
  const deltas = {};
  for (const meter of config.meters || []) {
    if (!meter.entityId || !meter.role) continue;
    const e = snap[meter.entityId];
    if (!e || !e.state) continue;
    const prevEff = prevEffective[meter.entityId];
    const nowEff = e.lastEffective;
    if (prevEff == null || nowEff == null) continue;
    const d = nowEff - prevEff;
    if (d > 0) deltas[meter.role] = round3((deltas[meter.role] || 0) + d);
  }

  // Akku-Energie im Intervall. Zwei Wege, der genauere gewinnt:
  //   1. Echte Energiezähler des Speichers (Rollen akku_laden / akku_entladen)
  //   2. Sonst gerechnet: ΔLadestand [%] / 100 × nutzbare Kapazität [kWh]
  let akkuKwh = null;
  let akkuQuelle = null;
  let socJetzt = null;
  if (deltas.akku_laden != null || deltas.akku_entladen != null) {
    akkuKwh = round3((deltas.akku_laden || 0) - (deltas.akku_entladen || 0));
    akkuQuelle = 'zaehler';
  }
  const prevBat = snap._batteriesPrev || [];
  for (const b of snap._batteries || []) {
    if (b.value == null) continue;
    socJetzt = socJetzt == null ? b.value : Math.max(socJetzt, b.value);
    if (akkuQuelle === 'zaehler') continue; // Zähler ist genauer
    const kap = Number(b.kwh) || 0;
    const vorher = prevBat.find((x) => x.entityId === b.entityId);
    if (!kap || !vorher || vorher.value == null) continue;
    akkuKwh = round3((akkuKwh || 0) + ((b.value - vorher.value) / 100) * kap);
    akkuQuelle = 'ladestand';
  }

  const dauerMin = snap._lastBalanceTs ? (now - snap._lastBalanceTs) / 60000 : null;
  // Nur prüfen, wenn ein sinnvolles Intervall vorliegt (nicht nach langer Pause, sonst
  // vermischen sich Lade- und Entladephasen und die Bilanz ist zwangsläufig unscharf).
  if (dauerMin != null && dauerMin >= 5 && dauerMin <= 60 && Object.keys(deltas).length) {
    const findings = checkBalance(
      {
        erzeugung: deltas.erzeugung || 0,
        einspeisung: deltas.einspeisung || 0,
        netzbezug: deltas.netzbezug || 0,
        verbrauch: deltas.verbrauch != null ? deltas.verbrauch : null,
        akkuKwh,
        akkuSocProzent: socJetzt,
        dauerMinuten: dauerMin,
        akkuImPvZaehler: config.pvZaehlerUmfang === 'solar_und_akku',
      },
      config.plausibility || {}
    );
    for (const f of findings) {
      // Je Art nur einmal pro Stunde protokollieren – ein Sensorfehler besteht über mehrere
      // Intervalle und soll die Liste nicht zumüllen.
      const key = '_plaus_' + f.type;
      const letzte = snap[key] || 0;
      if (now - letzte < 3600000) continue;
      snap[key] = now;
      const target = (config.meters || []).find((m) => m.role === 'erzeugung') || (config.meters || [])[0];
      const bag = target && snap[target.entityId];
      if (bag) {
        bag.anomalies = (bag.anomalies || []).concat({
          type: f.type,
          at: now,
          entityId: target.entityId,
          name: 'Energiebilanz',
          text: f.text,
          detail: f.detail,
        });
        if (bag.anomalies.length > MAX_ANOMALIES) bag.anomalies = bag.anomalies.slice(-MAX_ANOMALIES);
      }
    }
  }
  snap._batteriesPrev = (snap._batteries || []).map((b) => ({ entityId: b.entityId, value: b.value }));
  snap._lastBalanceTs = now;

  saveSnapshots(snap);
  return { at: now, meters: results, alerts };
}

/** Setzt nach erfolgreichem Mailversand die Benachrichtigungs-Flag + Report-Anomalie. */
function commitAlert(entityId, kind, now = Date.now()) {
  const snap = loadSnapshots();
  const e = snap[entityId];
  if (!e) return;
  if (kind === 'investigating' && e.incident) {
    e.incident.notifiedInvestigating = true;
    e.anomalies.push({ type: 'investigating', at: now, entityId, name: e.incident.name, from: e.incident.oldFinal });
  } else if (kind === 'fault' && e.incident) {
    e.incident.notifiedFault = true;
    e.anomalies.push({ type: 'technical_fault', at: now, entityId, name: e.incident.name, from: e.incident.oldFinal });
  } else if (kind === 'offline_investigating' && e.offline) {
    e.offline.notifiedInvestigating = true;
    e.anomalies.push({ type: 'offline', at: now, entityId, name: e.offline.name });
  } else if (kind === 'offline_fault' && e.offline) {
    e.offline.notifiedFault = true;
    e.anomalies.push({ type: 'offline_fault', at: now, entityId, name: e.offline.name });
  } else {
    return;
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
