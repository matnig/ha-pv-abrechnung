'use strict';

// Alle Datumsberechnungen in lokaler Zeit (Container-TZ = HA-TZ).

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function fmt(d) {
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Abrechnungsperiode: [start, end) — end ist exklusiv (Beginn der Folgeperiode).
function dayPeriod(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = addDays(start, 1);
  return { type: 'day', label: fmt(start), start, end };
}

function monthPeriod(year, monthIndex /* 0-11 */) {
  const start = new Date(year, monthIndex, 1);
  const end = new Date(year, monthIndex + 1, 1);
  const label = start.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  return { type: 'month', label, start, end };
}

// Kalenderwoche (Montag 00:00 bis Montag 00:00).
function weekPeriod(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const start = addDays(d, -((d.getDay() + 6) % 7)); // Montag als Wochenstart
  const end = addDays(start, 7);
  return { type: 'week', label: `KW ${isoWeek(start)} (${fmt(start)} – ${fmt(addDays(start, 6))})`, start, end };
}

// ISO-8601-Kalenderwochennummer.
function isoWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + 4 - ((d.getDay() + 6) % 7 + 1)); // Donnerstag der Woche
  const yearStart = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function yearPeriod(year) {
  return { type: 'year', label: String(year), start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) };
}

// „Vorherige" Perioden relativ zu einem Stichtag (für den Scheduler).
function previousDay(ref = new Date()) {
  return dayPeriod(addDays(new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()), -1));
}
function previousMonth(ref = new Date()) {
  const d = new Date(ref.getFullYear(), ref.getMonth() - 1, 1);
  return monthPeriod(d.getFullYear(), d.getMonth());
}
function previousWeek(ref = new Date()) {
  return weekPeriod(addDays(new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()), -7));
}
function previousYear(ref = new Date()) {
  return yearPeriod(ref.getFullYear() - 1);
}

module.exports = {
  toDateStr,
  addDays,
  fmt,
  dayPeriod,
  weekPeriod,
  monthPeriod,
  yearPeriod,
  isoWeek,
  previousDay,
  previousWeek,
  previousMonth,
  previousYear,
};
