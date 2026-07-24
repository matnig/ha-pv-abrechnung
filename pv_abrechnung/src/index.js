'use strict';

const { createServer } = require('./web/server');
const { loadConfig, pollIntervalMinutes } = require('./config');
const { runPoll } = require('./engine');
const scheduler = require('./scheduler/scheduler');

const PORT = Number(process.env.INGRESS_PORT) || 8099;

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
  safePoll();
  setInterval(safePoll, intervalMs);

  scheduler.start();
}

main();
