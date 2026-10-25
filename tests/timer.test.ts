import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAntiDriftTimer } from '../client/anti-drift-timer.js';

function fakeFrames(run: (step: (time: number) => void, pending: () => number) => void) {
  const originalNow = Date.now;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  let now = 1000, id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  Date.now = () => now;
  globalThis.requestAnimationFrame = (cb) => { callbacks.set(++id, cb); return id; };
  globalThis.cancelAnimationFrame = (frame) => { callbacks.delete(frame); };
  try {
    run((time) => {
      now = time;
      const current = [...callbacks.values()];
      callbacks.clear();
      current.forEach(cb => cb(time));
    }, () => callbacks.size);
  } finally {
    Date.now = originalNow;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
}

test('delayed frames and background suspension do not accumulate drift', () => {
  fakeFrames((step, pending) => {
    const ticks: number[] = [];
    createAntiDriftTimer(10_000, n => ticks.push(n));
    step(1016); step(4500); step(10_900); step(15_000);
    assert.deepEqual(ticks, [9984, 6500, 100, 0]);
    assert.equal(pending(), 0);
  });
});

test('cancel removes pending frame and is safe inside onTick', () => {
  fakeFrames((step, pending) => {
    let ticks = 0;
    const cancel = createAntiDriftTimer(10_000, () => ticks++);
    cancel(); cancel(); step(2000);
    assert.equal(ticks, 0);
    const stop = createAntiDriftTimer(10_000, () => { ticks++; stop(); });
    step(2016);
    assert.equal(ticks, 1);
    assert.equal(pending(), 0);
  });
});

test('zero and negative durations emit zero once; non-finite durations are rejected', () => {
  fakeFrames((step, pending) => {
    const ticks: number[] = [];
    createAntiDriftTimer(-1, n => ticks.push(n));
    createAntiDriftTimer(0, n => ticks.push(n));
    step(1001);
    assert.deepEqual(ticks, [0, 0]);
    assert.equal(pending(), 0);
    assert.throws(() => createAntiDriftTimer(NaN, () => {}), RangeError);
    assert.throws(() => createAntiDriftTimer(Infinity, () => {}), RangeError);
  });
});
