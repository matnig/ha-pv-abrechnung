'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { fmtEnergy, axisUnit, niceMax, fade, barChartHtml, buildReportCharts } = require('../src/report/charts');
const { buildPeriodSeries, bucketing, bucketDeltas } = require('../src/report/periodSeries');
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
  assert.ok(!/opacity/i.test(html), 'kein opacity (von Outlook ignoriert) – stattdessen hellere Farbe');
  assert.ok(html.includes(fade('#16a34a')), 'Vorperiode als hellere Farbe');
});

test('barChartHtml: Balken haben echte Pixelhöhen (Mail-Clients kollabieren leere Zellen)', () => {
  const html = barChartHtml({ labels: ['a', 'b'], current: [10, 5], color: '#2563eb', height: 100 });
  const heights = [...html.matchAll(/height:(\d+)px;background/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(heights, [100, 50], 'Balkenhöhe proportional zum Wert');
  assert.ok(!/<td[^>]*height="0"/.test(html), 'keine Null-Höhen-Zellen');
});

test('bucketDeltas: 0-Glitch (Tasmota-Reset) erzeugt KEINEN Riesen-Zuwachs', () => {
  // Zählerstand ~37.000 kWh, dazwischen ein Rücksprung auf 0 (Tasmota nach Update)
  const rows = [
    { start: 0, state: 37000 },
    { start: 3600000, state: 37020 }, // +20
    { start: 7200000, state: 0 }, // Glitch -> 0, kein Zuwachs
    { start: 10800000, state: 37040 }, // zurück: darf nur +20 sein, NICHT +37040
    { start: 14400000, state: 37060 }, // +20
  ];
  const deltas = bucketDeltas(rows, 1).map((d) => d.delta);
  assert.deepStrictEqual(deltas, [20, 0, 20, 20]);
  assert.ok(Math.max(...deltas) < 100, 'kein Ausreißer, der die Achse zerstört');
});

test('Chart-Summe stimmt mit der Abrechnungsmenge überein (auch mit Glitches)', async () => {
  const period = monthPeriod(2026, 6);
  const t0 = period.start.getTime();
  // 10 Tage je +20 kWh = 200 kWh, mit einem 0-Glitch dazwischen
  const rows = [];
  let cum = 36800;
  for (let d = 0; d < 11; d++) {
    rows.push({ start: t0 + d * 86400000, state: d === 5 ? 0 : cum });
    if (d !== 5) cum += 20;
  }
  const ha = { statisticsDuringPeriod: async () => ({ 'sensor.grid': rows }) };
  const cfg = { meters: [{ id: 'm', name: 'Netzbezug', entityId: 'sensor.grid', role: 'netzbezug', unit: 'kWh' }] };
  const c = await buildPeriodSeries(cfg, period, ha);
  assert.ok(c.series.netzbezug.sum < 300, `Summe muss ~200 kWh sein, war ${c.series.netzbezug.sum}`);
  assert.ok(Math.max(...c.series.netzbezug.values) < 100, 'kein Tages-Ausreißer');
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
