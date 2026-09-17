'use strict';

// Keyboard input for `play`: turns raw stdin bytes into actions.
// Arrow keys arrive as multi-byte escape sequences that may split across
// `data` events, so the parser buffers incomplete sequences. A trailing lone
// ESC is held for `escDelay` ms (it may be a split arrow); if nothing
// follows it resolves as 'quit'. Pure logic with injectable timers — unit
// testable without a TTY.
//
// Actions: 'togglePause' (space/p), 'quit' (q/Ctrl-C/bare ESC),
// 'seekBack' (Left, -5s), 'seekFwd' (Right, +5s).

const SEEK_SECONDS = 5;

function createKeyParser(
  emit,
  { escDelay = 50, setTimer = setTimeout, clearTimer = clearTimeout } = {}
) {
  let pending = ''; // incomplete escape sequence carried across push() calls
  let escTimer = null;

  const disarm = () => {
    if (escTimer != null) {
      clearTimer(escTimer);
      escTimer = null;
    }
  };

  const arm = () => {
    disarm();
    escTimer = setTimer(() => {
      escTimer = null;
      flush();
    }, escDelay);
  };

  const emitChar = (ch) => {
    if (ch === ' ' || ch === 'p') emit('togglePause');
    else if (ch === 'q' || ch === '\u0003') emit('quit');
    // Other printable keys: ignored.
  };

  // Consume a buffer known to contain no leading partial sequence.
  const consume = (s) => {
    if (s === '') return;
    if (s[0] !== '\x1b') {
      emitChar(s[0]);
      consume(s.slice(1));
      return;
    }
    if (s.length === 1 || (s.length === 2 && s[1] === '[')) {
      pending = s; // lone ESC or split CSI — wait for more (or escDelay)
      arm();
      return;
    }
    if (s[1] !== '[') {
      emit('quit'); // Alt+key etc: ESC counts as quit
      consume(s.slice(1));
      return;
    }
    const seq = s.slice(0, 3);
    if (seq === '\x1b[D') emit('seekBack');
    else if (seq === '\x1b[C') emit('seekFwd');
    // Unknown CSI (Up/Down, modified arrows): ignore.
    consume(s.slice(3));
  };

  /** Resolve buffered input: lone ESC → quit, truncated CSI → dropped. */
  const flush = () => {
    disarm();
    if (pending === '') return;
    const hadCsi = pending.length > 1;
    pending = '';
    if (!hadCsi) emit('quit');
  };

  return {
    /** Feed a stdin chunk; emits zero or more actions. */
    push(data) {
      disarm();
      const s = pending + String(data);
      pending = '';
      // Whole buffer is a CSI prefix → keep buffering (armed by consume).
      if (s === '\x1b' || s === '\x1b[') {
        pending = s;
        arm();
        return;
      }
      consume(s);
    },
    flush,
  };
}

module.exports = { createKeyParser, SEEK_SECONDS };
