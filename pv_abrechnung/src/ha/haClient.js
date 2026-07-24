'use strict';

const WebSocket = require('ws');

// Im Add-on: Zugriff über den Supervisor-Proxy mit SUPERVISOR_TOKEN.
// Lokal (Dev): HA_URL + HA_TOKEN (Long-Lived-Token) setzen.
function token() {
  return process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || '';
}

function httpBase() {
  if (process.env.SUPERVISOR_TOKEN) return 'http://supervisor/core/api';
  return (process.env.HA_URL || 'http://homeassistant.local:8123').replace(/\/+$/, '') + '/api';
}

function wsUrl() {
  if (process.env.SUPERVISOR_TOKEN) return 'ws://supervisor/core/websocket';
  const base = (process.env.HA_URL || 'http://homeassistant.local:8123').replace(/\/+$/, '');
  return base.replace(/^http/, 'ws') + '/api/websocket';
}

async function getState(entityId) {
  const res = await fetch(`${httpBase()}/states/${encodeURIComponent(entityId)}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`HA getState(${entityId}) -> HTTP ${res.status}`);
  return res.json();
}

// Alle Entitäten, deren Einheit auf Wh/kWh/MWh endet -> Kandidaten für Energiezähler.
async function listEnergyEntities() {
  const res = await fetch(`${httpBase()}/states`, { headers: { Authorization: `Bearer ${token()}` } });
  if (!res.ok) throw new Error(`HA listStates -> HTTP ${res.status}`);
  const all = await res.json();
  return all
    .filter((s) => /wh$/i.test((s.attributes && s.attributes.unit_of_measurement) || ''))
    .map((s) => ({
      entityId: s.entity_id,
      name: (s.attributes && s.attributes.friendly_name) || s.entity_id,
      unit: s.attributes.unit_of_measurement,
      deviceClass: s.attributes.device_class || null,
      stateClass: s.attributes.state_class || null,
      state: s.state,
    }))
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

module.exports = { getState, listEnergyEntities, statisticsDuringPeriod, httpBase, wsUrl };
