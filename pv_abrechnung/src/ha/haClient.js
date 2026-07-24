'use strict';

const WebSocket = require('ws');

// Im Add-on: Zugriff über den Supervisor-Proxy mit SUPERVISOR_TOKEN.
// Lokal (Dev): HA_URL + HA_TOKEN (Long-Lived-Token) setzen.
// Der Supervisor stellt den Add-on-Token je nach Version als SUPERVISOR_TOKEN
// (neu) oder HASSIO_TOKEN (alt) bereit – beide akzeptieren.
function supervisorToken() {
  return process.env.SUPERVISOR_TOKEN || process.env.HASSIO_TOKEN || '';
}

function token() {
  return supervisorToken() || process.env.HA_TOKEN || '';
}

function httpBase() {
  if (supervisorToken()) return 'http://supervisor/core/api';
  return (process.env.HA_URL || 'http://homeassistant.local:8123').replace(/\/+$/, '') + '/api';
}

function wsUrl() {
  if (supervisorToken()) return 'ws://supervisor/core/websocket';
  const base = (process.env.HA_URL || 'http://homeassistant.local:8123').replace(/\/+$/, '');
  return base.replace(/^http/, 'ws') + '/api/websocket';
}

// Authentifizierter Fetch mit Timeout, damit ein hängender Supervisor-Aufruf nicht
// die ganze Anfrage blockiert (sonst leerer 502 vom Ingress-Proxy).
async function authedFetch(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { Authorization: `Bearer ${token()}` }, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`HA-Anfrage Zeitüberschreitung nach ${timeoutMs / 1000}s`);
    throw new Error('HA nicht erreichbar: ' + (e && e.message ? e.message : String(e)));
  } finally {
    clearTimeout(t);
  }
}

async function getState(entityId, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500));
    let res;
    try {
      res = await authedFetch(`${httpBase()}/states/${encodeURIComponent(entityId)}`);
    } catch (e) {
      lastErr = e; // Netzwerk/Timeout -> erneut versuchen
      continue;
    }
    if (res.ok) return res.json();
    // 502/503/504 = HA/Proxy transient nicht bereit -> erneut versuchen; 401/404 sofort werfen.
    if ([502, 503, 504].includes(res.status)) {
      lastErr = new Error(`HA getState(${entityId}) -> HTTP ${res.status}`);
      continue;
    }
    throw new Error(`HA getState(${entityId}) -> HTTP ${res.status}`);
  }
  throw lastErr;
}

// Energie-Einheit? Akzeptiert Wh, kWh und MWh (case-insensitiv, mit/ohne Leerzeichen).
function isEnergyUnit(unit) {
  return /^(wh|kwh|mwh)$/i.test(String(unit || '').trim());
}

// Umrechnungsfaktor der Einheit auf kWh (Grundlage aller Berechnungen).
function unitFactorToKwh(unit) {
  const u = String(unit || '').trim().toLowerCase();
  if (u === 'wh') return 0.001;
  if (u === 'mwh') return 1000;
  return 1; // kWh oder unbekannt -> als kWh behandeln
}

// Kandidaten für Energiezähler: Einheit Wh/kWh/MWh ODER device_class "energy".
async function listEnergyEntities() {
  const res = await authedFetch(`${httpBase()}/states`);
  if (!res.ok) throw new Error(`HA /states -> HTTP ${res.status} ${res.statusText || ''}`.trim());
  const all = await res.json();
  if (!Array.isArray(all)) throw new Error('Unerwartete Antwort von HA (/states ist keine Liste)');
  return all
    .filter((s) => {
      const a = s.attributes || {};
      return isEnergyUnit(a.unit_of_measurement) || a.device_class === 'energy';
    })
    .map((s) => {
      const a = s.attributes || {};
      return {
        entityId: s.entity_id,
        name: a.friendly_name || s.entity_id,
        unit: a.unit_of_measurement || '',
        deviceClass: a.device_class || null,
        stateClass: a.state_class || null,
        state: s.state,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * HA Long-Term-Statistics für einen Zeitraum (Fallback / Backfill, überlebt Add-on-Downtime).
 * Liefert je statistic_id Perioden-Buckets mit { start, state, sum }.
 */
function statisticsDuringPeriod(statisticIds, startISO, endISO, period = 'day') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('HA ws timeout')), 15000);

    ws.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: token() }));
      } else if (msg.type === 'auth_ok') {
        ws.send(
          JSON.stringify({
            id: 1,
            type: 'recorder/statistics_during_period',
            start_time: startISO,
            end_time: endISO,
            statistic_ids: statisticIds,
            period,
          })
        );
      } else if (msg.type === 'auth_invalid') {
        clearTimeout(timer);
        finish(reject, new Error('HA auth invalid'));
      } else if (msg.type === 'result') {
        clearTimeout(timer);
        if (msg.success) finish(resolve, msg.result || {});
        else finish(reject, new Error((msg.error && msg.error.message) || 'statistics error'));
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      finish(reject, e);
    });
  });
}

module.exports = { getState, listEnergyEntities, statisticsDuringPeriod, isEnergyUnit, unitFactorToKwh, httpBase, wsUrl };
