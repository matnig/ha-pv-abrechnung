'use strict';

const cron = require('node-cron');
const { loadConfig } = require('../config');
const { runReport } = require('../engine');
const { previousDay, previousWeek, previousMonth, previousYear } = require('../billing/periods');

let task = null;

// Ein täglicher Lauf zur konfigurierten Stunde entscheidet, welche Berichte fällig sind:
//  - Tagesbericht: jeden Tag (für gestern)
//  - Wochenbericht: montags (für die Vorwoche)
//  - Monatsbericht: am 1. des Monats (für den Vormonat)
//  - Jahresbericht: am 1. Januar (für das Vorjahr)
async function tick(now = new Date()) {
  const config = loadConfig();
  const sched = config.schedule || {};
  const jobs = [];

  if (sched.daily) jobs.push(previousDay(now));
  if (sched.weekly && now.getDay() === 1) jobs.push(previousWeek(now));
  if (sched.monthly && now.getDate() === 1) jobs.push(previousMonth(now));
  if (sched.yearly && now.getMonth() === 0 && now.getDate() === 1) jobs.push(previousYear(now));

  const done = [];
  for (const period of jobs) {
    try {
      await runReport(period, { send: true, config });
      done.push({ period: period.label, ok: true });
    } catch (err) {
      done.push({ period: period.label, ok: false, error: String(err.message || err) });
      console.error(`[scheduler] Report ${period.type} ${period.label} fehlgeschlagen:`, err.message);
    }
  }
  return done;
}

function start() {
  const config = loadConfig();
  const hour = Number(config.schedule?.hour ?? 6);
  stop();
  // Minute 0 der konfigurierten Stunde, jeden Tag.
  task = cron.schedule(`0 ${hour} * * *`, () => {
    tick().catch((e) => console.error('[scheduler] tick error', e));
  });
  console.log(`[scheduler] aktiv – täglicher Lauf um ${hour}:00 Uhr`);
  return task;
}

function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { start, stop, tick };
