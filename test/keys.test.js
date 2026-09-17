'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createKeyParser, SEEK_SECONDS } = require('../lib/keys');

function collector(timer) {
  const actions = [];
  const parser = createKeyParser(
    (a) => actions.push(a),
    timer ? { setTimer: timer.set, clearTimer: timer.clear } : {}
  );
  return { actions, parser };
}

test('space/p pause, q and Ctrl-C quit', () => {
  const { actions, parser } = collector();
  parser.push(' ');
  parser.push('p');
  parser.push('q');
  parser.push('\u0003');
  parser.flush();
  assert.deepEqual(actions, ['togglePause', 'togglePause', 'quit', 'quit']);
});

test('arrow keys seek in one chunk', () => {
  const { actions, parser } = collector();
  parser.push('\x1b[D');
  parser.push('\x1b[C');
  parser.flush();
  assert.deepEqual(actions, ['seekBack', 'seekFwd']);
  assert.equal(SEEK_SECONDS, 5);
});

test('split escape sequences reassemble across chunks', () => {
  const { actions, parser } = collector();
  parser.push('\x1b');
  parser.push('[');
  parser.push('D');
  parser.push('\x1b[C');
  parser.flush();
  assert.deepEqual(actions, ['seekBack', 'seekFwd']);
});

test('unknown CSI sequences are ignored', () => {
  const { actions, parser } = collector();
  parser.push('\x1b[A\x1b[B'); // Up/Down
  parser.push('x'); // ordinary key
  parser.flush();
  assert.deepEqual(actions, []);
});

test('lone ESC resolves as quit after escDelay', () => {
  let fired = null;
  const timer = {
    set: (fn) => {
      fired = fn;
      return 1;
    },
    clear: () => {
      fired = null;
    },
  };
  const { actions, parser } = collector(timer);
  parser.push('\x1b');
  assert.deepEqual(actions, []); // held, not yet quit
  fired();
  assert.deepEqual(actions, ['quit']);
});

test('more bytes cancel the pending lone ESC', () => {
  let fired = null;
  const timer = {
    set: (fn) => {
      fired = fn;
      return 1;
    },
    clear: () => {
      fired = null;
    },
  };
  const { actions, parser } = collector(timer);
  parser.push('\x1b');
  parser.push('[D');
  assert.equal(fired, null); // timer disarmed
  parser.flush();
  assert.deepEqual(actions, ['seekBack']);
});

test('mixed stream parses in order', () => {
  const { actions, parser } = collector();
  parser.push(' \x1b[Dq');
  parser.flush();
  assert.deepEqual(actions, ['togglePause', 'seekBack', 'quit']);
});
