'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { fmtEnergy, axisUnit, niceMax, barChartHtml, buildReportCharts } = require('../src/report/charts');
const { buildPeriodSeries, bucketing } = require('../src/report/periodSeries');
const { weekPeriod, previousWeek, isoWeek, dayPeriod, monthPeriod, yearPeriod } = require('../src/billing/periods');

test('fmtEnergy wählt Wh / kWh / MWh je nach Größe', () => {
  assert.strictEqual(fmtEnergy(0), '0 kWh');
  assert.match(fmtEnergy(0.234), /^234 Wh$/);
  assert.match(fmtEnergy(5.5), /^5,5 kWh$/);
  assert.match(fmtEnergy(1500), /^1,5 MWh$/);
});

test('axisUnit und niceMax liefern lesbare Skalierung', () => {
  assert.deepStrictEqual(axisUnit(0.4), { unit: 'Wh', div: 0.001 });
  assert.deepStrictEqual(axisUnit(12), { unit: 'kWh', div: 1 });
  assert.deepStrictEqual(axisUnit(4000), { unit: 'MWh', div: 1000 });
  assert.strictEqual(niceMax(0), 1);
  assert.strictEqual(niceMax(3.2), 5);
  assert.strictEqual(niceMax(11), 20);
});

test('barChartHtml: mail-tauglich (Tabellen, kein SVG/Flex) und mit Achsenbeschriftung', () => {
  const html = barChartHtml({ labels: ['0h', '1h', '2h'], current: [1, 2, 3], previous: [0.5, 1, 1.5], color: '#16a34a' });
  assert.ok(html.includes('<table'), 'nutzt Tabellen');
  assert.ok(!/<svg|display:\s*flex/i.test(html), 'kein SVG/Flexbox (Outlook-tauglich)');
  assert.ok(html.includes('kWh'), 'Achseneinheit beschriftet');
  assert.ok(html.includes('opacity:0.35'), 'Vorperiode als blasser Balken');
});

test('buildReportCharts rendert je Rolle einen Block mit Summen', () => {
  const html = buildReportCharts({
    granularity: 'hour',
    labels: ['0h', '1h'],
    periodLabel: 'Heute/Berichtstag',
    comparisonLabel: 'Vortag',
    hasPrev: true,
    series: { erzeugung: { name: 'PV', values: [1, 2], prevValues: [1, 1], sum: 3, prevSum: 2 } },
    sunHours: { current: 2, previous: 2 },
  });
  assert.ok(html.includes('PV'), 'Zählername');
  assert.ok(html.includes('Sonnenstunden'));
  assert.ok(html.includes('Verlauf'));
  assert.strictEqual(buildReportCharts(null), '', 'ohne Daten kein Block');
});

test('bucketing: Tag->24h, Woche->7 Tage, Jahr->12 Monate, Monat->Tage', () => {
  const d = bucketing('day', Date.now(), Date.now());
  assert.strictEqual(d.granularity, 'hour');
  assert.strictEqual(d.count, 24);
  const w = bucketing('week', Date.now(), Date.now());
  assert.deepStrictEqual(w.labels, ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);
  const y = bucketing('year', Date.now(), Date.now());
  assert.strictEqual(y.count, 12);
  const m = monthPeriod(2026, 0); // Januar = 31 Tage
  const mb = bucketing('month', m.start.getTime(), m.end.getTime());
  assert.strictEqual(mb.count, 31);
});

test('weekPeriod: Montag bis Montag, ISO-Kalenderwoche im Label', () => {
  const p = weekPeriod(new Date(2026, 6, 25)); // Samstag, 25.07.2026
  assert.strictEqual(p.type, 'week');
  assert.strictEqual(p.start.getDay(), 1, 'beginnt montags');
  assert.strictEqual((p.end - p.start) / 86400000, 7);
  assert.match(p.label, /^KW \d+ \(/);
  const prev = previousWeek(new Date(2026, 6, 25));
  assert.strictEqual((p.start - prev.start) / 86400000, 7);
  assert.strictEqual(isoWeek(new Date(2026, 0, 8)), 2);
});

test('buildPeriodSeries: Tagesbericht -> 24 Stunden-Buckets + Vortagsvergleich', async () => {
  const day = dayPeriod(new Date(2026, 6, 24));
  const t0 = day.start.getTime();
  const y0 = t0 - 86400000;
  const rows = [
    { start: y0 + 10 * 3600000, state: 0 },
    { start: y0 + 11 * 3600000, state: 2 }, // Vortag 11h: +2
    { start: t0 + 10 * 3600000, state: 2 },
    { start: t0 + 11 * 3600000, state: 5 }, // Tag 11h: +3
  ];
  const ha = { statisticsDuringPeriod: async () => ({ 'sensor.pv': rows }) };
  const cfg = { meters: [{ id: 'm', name: 'PV', entityId: 'sensor.pv', role: 'erzeugung', unit: 'kWh' }] };
  const c = await buildPeriodSeries(cfg, day, ha);
  assert.strictEqual(c.granularity, 'hour');
  assert.strictEqual(c.labels.length, 24);
  assert.strictEqual(c.series.erzeugung.values[11], 3);
  assert.strictEqual(c.series.erzeugung.prevValues[11], 2);
  assert.strictEqual(c.comparisonLabel, 'Vortag');
  assert.strictEqual(c.sunHours.current, 1);
});

test('buildPeriodSeries: Jahresbericht -> Monats-Buckets; ohne Zähler null', async () => {
  const ha = { statisticsDuringPeriod: async () => ({ 'sensor.pv': [] }) };
  const cfg = { meters: [{ id: 'm', name: 'PV', entityId: 'sensor.pv', role: 'erzeugung', unit: 'kWh' }] };
  const c = await buildPeriodSeries(cfg, yearPeriod(2026), ha);
  assert.strictEqual(c.granularity, 'month');
  assert.strictEqual(c.labels.length, 12);
  assert.strictEqual(c.comparisonLabel, 'Vorjahr');
  assert.strictEqual(await buildPeriodSeries({ meters: [] }, yearPeriod(2026), ha), null);
});

test('buildPeriodSeries: Einheit Wh wird auf kWh normalisiert', async () => {
  const day = dayPeriod(new Date(2026, 6, 24));
  const t0 = day.start.getTime();
  const rows = [{ start: t0 + 10 * 3600000, state: 1000 }, { start: t0 + 11 * 3600000, state: 3000 }]; // +2000 Wh
  const ha = { statisticsDuringPeriod: async () => ({ 'sensor.pv': rows }) };
  const cfg = { meters: [{ id: 'm', name: 'PV', entityId: 'sensor.pv', role: 'erzeugung', unit: 'Wh' }] };
  const c = await buildPeriodSeries(cfg, day, ha);
  assert.strictEqual(c.series.erzeugung.values[11], 2, '2000 Wh = 2 kWh');
});
