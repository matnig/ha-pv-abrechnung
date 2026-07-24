'use strict';

const { createServer } = require('./web/server');
const { loadConfig, pollIntervalMinutes } = require('./config');
const { runPoll } = require('./engine');
const haClient = require('./ha/haClient');
const scheduler = require('./scheduler/scheduler');

const PORT = Number(process.env.INGRESS_PORT) || 8099;

// Einmaliger Selbsttest der HA-API beim Start – schreibt das Ergebnis klar ins Protokoll,
// damit Verbindungs-/Berechtigungsprobleme sofort sichtbar sind (ohne Klick in der UI).
async function haSelfCheck() {
  const relevant = Object.keys(process.env).filter((k) => /token|hassio|supervisor|ingress/i.test(k));
  console.log(`[startup] Token-Env vorhanden: SUPERVISOR_TOKEN=${process.env.SUPERVISOR_TOKEN ? 'ja' : 'nein'}, HASSIO_TOKEN=${process.env.HASSIO_TOKEN ? 'ja' : 'nein'}`);
  console.log(`[startup] Relevante Env-Variablen: ${relevant.join(', ') || '(keine)'}`);
  console.log(`[startup] API-Basis: ${haClient.httpBase()}`);
  try {
    const list = await haClient.listEnergyEntities();
    console.log(`[startup] HA-API OK – ${list.length} Energie-Entitäten (Wh/kWh/MWh oder device_class energy) gefunden`);
  } catch (err) {
    console.error(`[startup] HA-API NICHT erreichbar: ${err && err.message ? err.message : err}`);
  }
}

async function safePoll() {
  try {
    const r = await runPoll();
    const flagged = r.meters.filter((m) => m.anomalies.length || m.incident);
    if (flagged.length) console.log(`[poll] ${flagged.length} Zähler auffällig:`, flagged.map((m) => `${m.name}:${m.incident ? 'STÖRUNG' : m.anomalies.join(',')}`).join(' | '));
    if (r.alerts.length) console.log(`[poll] ${r.alerts.length} Alarm-Mail(s) ausgelöst`);
  } catch (err) {
    console.error('[poll] Fehler:', err.message);
  }
}

function main() {
  const app = createServer();
  app.listen(PORT, '0.0.0.0', () => console.log(`[web] PV-Abrechnung läuft auf Port ${PORT}`));

  const intervalMs = pollIntervalMinutes() * 60000;
  console.log(`[poll] Intervall: ${pollIntervalMinutes()} min`);
  haSelfCheck();
  safePoll();
  setInterval(safePoll, intervalMs);

  scheduler.start();
}

main();
