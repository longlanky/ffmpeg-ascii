'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler, formatTime } = require('../lib/scheduler');

function fakeClock(start = 1000) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => {
    t += ms;
  };
  return clock;
}

test('formatTime renders mm:ss', () => {
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(65), '01:05');
  assert.equal(formatTime(3599), '59:59');
});

test('unpaced scheduler renders everything with no wait', () => {
  const s = createScheduler({ fps: null });
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(s.decide(i), { action: 'render', waitMs: 0 });
  }
  assert.equal(s.rendered, 5);
  assert.equal(s.dropped, 0);
});

test('clock starts on first frame, not construction', () => {
  const clock = fakeClock();
  const s = createScheduler({ fps: 10, clock });
  clock.advance(5000); // spawn + decoder startup latency
  assert.deepEqual(s.decide(0), { action: 'render', waitMs: 0 });
  assert.equal(s.dropped, 0);
  clock.advance(100);
  assert.deepEqual(s.decide(1), { action: 'render', waitMs: 0 });
});

test('pre-start pause does not shift the anchored clock', () => {
  const clock = fakeClock();
  const s = createScheduler({ fps: 10, clock });
  s.pause();
  clock.advance(5000);
  s.resume();
  assert.deepEqual(s.decide(0), { action: 'render', waitMs: 0 });
  assert.equal(s.dropped, 0);
});

test('on-time frames render with no wait', () => {
  const clock = fakeClock();
  const s = createScheduler({ fps: 10, clock }); // 100ms frames
  assert.deepEqual(s.decide(0), { action: 'render', waitMs: 0 });
  clock.advance(100);
  assert.deepEqual(s.decide(1), { action: 'render', waitMs: 0 });
});

test('early frames report sleep remainder', () => {
  const clock = fakeClock();
  const s = createScheduler({ fps: 10, clock });
  s.decide(0);
  clock.advance(250); // frame 3's deadline is 300ms
  assert.deepEqual(s.decide(3), { action: 'render', waitMs: 50 });
});

test('late frames drop and count', () => {
  const clock = fakeClock();
  const s = createScheduler({ fps: 10, clock });
  s.decide(0);
  clock.advance(350); // frame 1 deadline 100ms, late by 250 > 100ms tolerance
  assert.deepEqual(s.decide(1), { action: 'drop', waitMs: 0 });
  assert.equal(s.dropped, 1);
  assert.equal(s.rendered, 1);
});

test('boundary lateness within one frame still renders', () => {
  const clock = fakeClock();
  const s = createScheduler({ fps: 10, clock });
  s.decide(0);
  clock.advance(150); // frame 1 deadline 100ms, late by 50 <= 100ms
  const d = s.decide(1);
  assert.equal(d.action, 'render');
  assert.equal(d.waitMs, 0);
});

test('pause freezes deadlines', () => {
  const clock = fakeClock();
  const s = createScheduler({ fps: 10, clock });
  s.decide(0);
  s.pause();
  clock.advance(5000); // wall clock moves while paused
  s.resume();
  clock.advance(100);
  assert.deepEqual(s.decide(1), { action: 'render', waitMs: 0 });
  assert.equal(s.dropped, 0);
});

test('status line shows progress and counters', () => {
  const clock = fakeClock();
  const s = createScheduler({ fps: 10, duration: 90, clock });
  s.decide(0);
  clock.advance(2000);
  s.decide(1); // late by 1900ms -> drop
  const st = s.status();
  assert.match(st, /00:02\/01:30/);
  assert.match(st, /out 1 \(dropped 1\)/);
  assert.match(st, /eff \d+fps/);
});

test('status without duration shows placeholder', () => {
  const s = createScheduler({ fps: 5 });
  assert.match(s.status(), /--:--/);
});
