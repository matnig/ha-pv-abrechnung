'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getSeries } = require('../src/stats/stats');

const config = {
  useStatistics: true,
  meters: [
    { id: 'm1', name: 'Wohnung 1', entityId: 'sensor.w1', role: 'verbrauch' },
    { id: 'm2', name: 'Einspeisung', entityId: 'sensor.feed', role: 'einspeisung' },
  ],
  tariffs: { verbrauch: 0.35, einspeisung: 0.08 },
};

function midnight(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return d.getTime();
}

test('Tagesreihe aus Statistics inkl. €-Netto je Tag', async () => {
  const ha = {
    statisticsDuringPeriod: async (ids) => {
      const id = ids[0];
      if (id === 'sensor.w1')
        return { 'sensor.w1': [
          { start: midnight(2), change: 10 },
          { start: midnight(1), change: 12 },
          { start: midnight(0), change: 8 },
        ] };
      return { 'sensor.feed': [
        { start: midnight(2), change: 5 },
        { start: midnight(1), change: 6 },
        { start: midnight(0), change: 4 },
      ] };
    },
  };
  const s = await getSeries(config, { granularity: 'day', count: 3, ha, snapshots: {} });
  assert.strictEqual(s.periods.length, 3);
  assert.strictEqual(s.totalsByMeter.m1, 30);
  assert.strictEqual(s.totalsByMeter.m2, 15);
  // Einspeisung zählt in der Direktansicht nicht (Vorzeichen 0): 8 kWh * 0.35 = 2.8
  assert.strictEqual(s.periods[2].euro, 2.8);
  assert.strictEqual(s.meters[0].source, 'statistics');
});

test('Fallback auf Polling-Snapshots wenn Statistics leer', async () => {
  const ha = { statisticsDuringPeriod: async () => ({}) };
  const snapshots = {
    'sensor.w1': { daily: {}, anomalies: [] },
  };
  // fülle daily für die letzten 3 Tage
  const k = (o) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - o);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  snapshots['sensor.w1'].daily[k(3)] = 100;
  snapshots['sensor.w1'].daily[k(2)] = 110;
  snapshots['sensor.w1'].daily[k(1)] = 125;
  snapshots['sensor.w1'].daily[k(0)] = 130;

  const cfg = { ...config, meters: [config.meters[0]] };
  const s = await getSeries(cfg, { granularity: 'day', count: 3, ha, snapshots });
  assert.strictEqual(s.meters[0].source, 'poll');
  // Differenzen 110->125->130 = 15, 5 (Tag -2 basiert auf 100->110=10)
  assert.strictEqual(s.totalsByMeter.m1, 30);
});
