'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { backfillVirtual, earliestCommonDate } = require('../src/virtual/virtual');

const ms = (y, m, d) => new Date(y, m, d).getTime();

// Mock-HA: LTS-Tageswerte (sum) je Entität, Einheit kWh.
function mockHa(sumsByEntity) {
  return {
    getState: async () => ({ attributes: { unit_of_measurement: 'kWh' } }),
    statisticsDuringPeriod: async (ids) => {
      const id = ids[0];
      return { [id]: (sumsByEntity[id] || []).map((r) => ({ start: r.start, sum: r.sum })) };
    },
  };
}

const vm = {
  id: 'v1',
  name: 'An Kunde geliefert',
  role: 'lieferung',
  startDate: '2026-07-01',
  components: [
    { entityId: 'sensor.prod', factor: 1 },
    { entityId: 'sensor.feed', factor: -1 },
  ],
};

test('backfill: Basislinie am Startdatum, delivered = Δprod − Δfeed, nie negativ', async () => {
  const ha = mockHa({
    'sensor.prod': [
      { start: ms(2026, 5, 30), sum: 1000 },
      { start: ms(2026, 6, 1), sum: 1010 },
      { start: ms(2026, 6, 2), sum: 1030 },
    ],
    'sensor.feed': [
      { start: ms(2026, 5, 30), sum: 500 },
      { start: ms(2026, 6, 1), sum: 505 },
      { start: ms(2026, 6, 2), sum: 512 },
    ],
  });
  const snapshots = {};
  const r = await backfillVirtual(vm, ha, snapshots);
  assert.strictEqual(r.startDate, '2026-07-01');
  const daily = snapshots['virtual:v1'].daily;
  assert.strictEqual(daily['2026-07-01'], 0, 'am Startdatum 0');
  // 2026-07-02: (1030-1010) - (512-505) = 20 - 7 = 13
  assert.strictEqual(daily['2026-07-02'], 13);
  assert.strictEqual(r.currentStand, 13);
});

test('backfill deckelt negativen virtuellen Wert auf 0', async () => {
  const ha = mockHa({
    'sensor.prod': [
      { start: ms(2026, 6, 1), sum: 1000 },
      { start: ms(2026, 6, 2), sum: 1005 }, // +5
    ],
    'sensor.feed': [
      { start: ms(2026, 6, 1), sum: 500 },
      { start: ms(2026, 6, 2), sum: 520 }, // +20 -> delivered = 5-20 = -15 -> 0
    ],
  });
  const snapshots = {};
  await backfillVirtual(vm, ha, snapshots);
  assert.strictEqual(snapshots['virtual:v1'].daily['2026-07-02'], 0);
});

test('earliestCommonDate = spätestes der ersten Datumswerte', async () => {
  const ha = mockHa({
    'sensor.prod': [{ start: ms(2026, 5, 30), sum: 1 }],
    'sensor.feed': [{ start: ms(2026, 5, 25), sum: 1 }],
  });
  const earliest = await earliestCommonDate(vm.components, ha, {});
  assert.strictEqual(earliest, '2026-06-30');
});
