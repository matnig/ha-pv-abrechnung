'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { processReading, swapMeter, num, freshState } = require('../src/meter/meterProcessor');

const MIN = 60000;
const H = 3600000;

function feed(readings) {
  let s = freshState();
  let last;
  for (const r of readings) {
    last = processReading(s, r);
    s = last.state;
  }
  return { state: s, last };
}

test('num parst Komma und ungültiges', () => {
  assert.strictEqual(num('12,5'), 12.5);
  assert.strictEqual(num('unavailable'), null);
});

test('normaler Anstieg zählt hoch', () => {
  const { last } = feed([{ raw: 100, now: 0 }, { raw: 105, now: H }]);
  assert.strictEqual(last.effective, 105);
  assert.strictEqual(last.anomalies.length, 0);
});

test('Abfall öffnet pending und hält den Stand (keine Auto-Entscheidung)', () => {
  const { last } = feed([{ raw: 100, now: 0 }, { raw: 150, now: H }, { raw: 0, now: 2 * H }]);
  assert.strictEqual(last.effective, 150);
  assert.strictEqual(last.updated, false);
  assert.strictEqual(last.anomalies[0].type, 'drop_detected');
  assert.ok(last.state.pending, 'pending ist offen');
});

test('kurzzeitige Störung: Wert kommt zurück -> transient', () => {
  const { last } = feed([
    { raw: 100, now: 0 },
    { raw: 150, now: H },
    { raw: 0, now: 2 * H },
    { raw: 152, now: 2 * H + 5 * MIN },
  ]);
  assert.strictEqual(last.effective, 152);
  assert.strictEqual(last.anomalies[0].type, 'transient');
  assert.strictEqual(last.state.pending, null);
});

test('bleibt der Wert unten, bleibt pending offen (KEIN automatischer Tausch)', () => {
  const { last, state } = feed([
    { raw: 100, now: 0 },
    { raw: 150, now: H },
    { raw: 2, now: 2 * H },
    { raw: 5, now: 2 * H + 30 * MIN },
    { raw: 9, now: 2 * H + 300 * MIN }, // auch nach 5h weiterhin pending
  ]);
  assert.ok(state.pending, 'kein Auto-Tausch, pending bleibt offen');
  assert.strictEqual(last.effective, 150, 'Stand wird gehalten');
  assert.strictEqual(state.pending.current, 9);
});

test('manueller Zählertausch konserviert den Stand und läuft fort', () => {
  const { state } = feed([
    { raw: 100, now: 0 },
    { raw: 150, now: H },
    { raw: 2, now: 2 * H },
    { raw: 9, now: 2 * H + 60 * MIN },
  ]);
  const res = swapMeter(state, 2 * H + 61 * MIN);
  assert.strictEqual(res.swapped, true);
  assert.strictEqual(res.oldFinal, 150);
  assert.strictEqual(res.newReading, 9);
  assert.strictEqual(res.state.effective, 159, 'offset 150 + neuer Stand 9');
  assert.strictEqual(res.state.pending, null);
  // danach zählt es normal weiter
  const next = processReading(res.state, { raw: 12, now: 3 * H });
  assert.strictEqual(next.effective, 162);
});

test('swapMeter ohne offene Störung tut nichts', () => {
  const { state } = feed([{ raw: 100, now: 0 }, { raw: 110, now: H }]);
  const res = swapMeter(state, 2 * H);
  assert.strictEqual(res.swapped, false);
});

test('stale, unavailable, jitter, spike weiterhin korrekt', () => {
  const stale = processReading({ offset: 0, lastRaw: 100, lastRawTs: 0, lastChangeTs: 0, effective: 100, pending: null }, { raw: 100, now: 200 * MIN }, { staleMinutes: 180 });
  assert.strictEqual(stale.anomalies[0].type, 'stale');

  const un = feed([{ raw: 100, now: 0 }, { raw: 'x', available: false, now: H }]).last;
  assert.strictEqual(un.effective, 100);
  assert.strictEqual(un.anomalies[0].type, 'unavailable');

  const jit = feed([{ raw: 100, now: 0 }, { raw: 99.7, now: H }]).last;
  assert.strictEqual(jit.effective, 100);
  assert.strictEqual(jit.anomalies[0].type, 'jitter');

  const spike = processReading({ offset: 0, lastRaw: 100, lastRawTs: 0, lastChangeTs: 0, effective: 100, pending: null }, { raw: 600, now: H }, { maxRateKwhPerHour: 100 });
  assert.strictEqual(spike.anomalies[0].type, 'spike');
  assert.strictEqual(spike.effective, 600);
});
