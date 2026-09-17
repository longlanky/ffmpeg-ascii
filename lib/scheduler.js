'use strict';

// Deadline scheduler for `play`: keeps ASCII output on pace with the source
// instead of accumulating unbounded lag on slow terminals.
//
// Each decoded frame has a presentation deadline:
//   deadline(i) = startTime + i * 1000/fps
// The caller renders frames on time, skips the expensive render/write when a
// frame is already more than one frame-duration late ('drop'), and sleeps the
// remainder when early. Pure + injectable clock, so it is unit testable.

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * @param {object} args
 * @param {number|null} args.fps - output frames/sec (null/undefined = render everything)
 * @param {number|null} [args.duration] - total media seconds (for progress display)
 * @param {function} [args.clock] - ms time source (default Date.now; inject a fake in tests)
 */
function createScheduler({ fps, duration = null, clock = Date.now } = {}) {
  const rate = Number(fps);
  const paced = Number.isFinite(rate) && rate > 0;
  const frameMs = paced ? 1000 / rate : 0;
  const total = duration != null && Number.isFinite(Number(duration)) ? Number(duration) : null;

  // Clock starts on first decide(), not construction: process spawn and
  // decoder startup latency must not count against the first frames.
  let startTime = null;
  let pausedTotal = 0;
  let pauseBegan = null;
  let rendered = 0;
  let dropped = 0;

  const now = () => (startTime == null ? 0 : clock() - startTime - pausedTotal);

  return {
    /** frames rendered so far (excludes drops) */
    get rendered() {
      return rendered;
    },
    get dropped() {
      return dropped;
    },
    frameMs,

    /**
     * Decide what to do with decoded frame `index` (0-based decode order).
     * Returns { action: 'render'|'drop', waitMs } — caller sleeps waitMs
     * when early, skips render+write on 'drop'. Unpaced schedulers always
     * return 'render' with waitMs 0.
     */
    decide(index) {
      // First frame (re)anchors the clock; decide() is only reached while
      // unpaused, so any pre-start pause bookkeeping is stale — drop it.
      if (startTime == null) {
        startTime = clock();
        pausedTotal = 0;
        pauseBegan = null;
      }
      if (!paced) {
        rendered++;
        return { action: 'render', waitMs: 0 };
      }
      const elapsed = now();
      const deadline = index * frameMs;
      const lateBy = elapsed - deadline;
      if (lateBy > frameMs) {
        dropped++;
        return { action: 'drop', waitMs: 0 };
      }
      const waitMs = Math.max(0, deadline - elapsed);
      rendered++;
      return { action: 'render', waitMs };
    },

    pause() {
      if (pauseBegan == null) pauseBegan = clock();
    },

    resume() {
      if (pauseBegan != null) {
        pausedTotal += clock() - pauseBegan;
        pauseBegan = null;
      }
    },

    /** One-line status for stderr: `00:12/01:30 · eff 19fps · out 142 (dropped 8)`. */
    status() {
      const elapsedSec = now() / 1000;
      const elapsed = formatTime(elapsedSec);
      const totalStr = total != null ? formatTime(total) : '--:--';
      const eff = elapsedSec > 0 ? (rendered / elapsedSec).toFixed(0) : '0';
      return `${elapsed}/${totalStr} · eff ${eff}fps · out ${rendered} (dropped ${dropped})`;
    },
  };
}

module.exports = { createScheduler, formatTime };
