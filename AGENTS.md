# AGENTS.md — ffmpeg-ascii

Node CLI (`main.js` entrypoint, `lib/` helpers). Zero runtime deps except `commander@14`. Requires external `ffmpeg` + `ffprobe` on PATH (or `FFMPEG_PATH`/`FFPROBE_PATH`).

## Run
- Install: `npm ci` (lockfile IS committed — do not re-ignore it); needs `ffmpeg`/`ffprobe` binaries.
- Play: `node main.js play <input>` · single frame: `node main.js render <input>` (images render once; stills bypass streaming).
- Tests: `npm test` (`node --test test/`, pure unit tests, no ffmpeg needed). No lint/typecheck. CI (`.github/workflows/ci.yml`) runs `npm ci && npm test` on Node 20/22 with apt ffmpeg.

## Architecture notes (not obvious from filenames)
- `lib/video.js`: `getVideoInfo()` probes via `ffprobe -select_streams v:0 ... -of json` (`parseFfprobeJson`); `decodeBGRAStream()` spawns `ffmpeg -re? -i <in> -map 0:v:0 -an -sn -vf scale=W:H:flags=bicubic[,fps=N] -f rawvideo -pix_fmt bgra -` with stderr-tail capture. No `sed` anywhere (legacy Unix-only pipe is gone).
- `lib/frames.js`: `chunksToRawFramesOfSize()` queue-based reassembly into exact `w*h*4` frames (no per-chunk concat); trailing partials dropped, never yielded. `getFrameSize()` fits terminal via `charAspect` (~0.43 legacy fudge, overridable); explicit `--width/--height` skip fitting.
- `lib/ascii.js`: `asciiFromBGRA()` single-pass BGRA→ASCII LUT, intensity `(r+g+b)` matching legacy `asciify-pixel` ramp `" .,:;i1tfLCG08@"`; truecolor FG `\x1b[38;2;…m` per same-color run + one trailing full reset (`\x1b[0m`) when `--color` (default), opt-in Bayer `--dither` (±½ ramp step, clamped at extremes); `halfCellsFromBGRA()` pairs 2 pixel rows per `▀` cell (fg=top/bg=bottom, main.js decodes h*2 rows, aspect fudge halved); `stripAnsi()` for `--output` files.
- `lib/diff.js`: pure cell-grid diff (`diffGrids` → cursor-addressed `runsToAnsi`, bg-aware for half-block grids); `main.js` repaints only changed cells on display (`--no-diff` disables, >60% changed falls back to full draw, `--output` files always full frames); scheduler presentation clock anchors on first decoded frame (spawn latency must not cause opening drops).
- `lib/audio.js`: optional `--audio` spawns companion `ffplay -nodisp -autoexit` (or mpv) alongside video decode; `hasAudioStream()` skips silently-streamless inputs with a warning; argv protocol picked by player-binary substring. Pause uses SIGSTOP/SIGCONT (POSIX only); ffplay maps SIGTERM→exit 123, so `killAudio` intent is tracked explicitly — don't "fix" the 123.
- `lib/scheduler.js`: pure deadline scheduler (`createScheduler({fps, duration, clock})`, fake clock in tests); `decide(i)` → render (+waitMs sleep when early) or drop (>1 frame late). `main.js` recreates it per decode spawn (resize restarts at frame 0) and freezes it on pause; `--stats` ticks `status()` to stderr 1/s + final line. `let` declared in a `try` body is NOT visible in `finally` — keep `statsTimer` at function scope.
- `main.js`: commander wiring only — `play` streams with cursor hide/show + clear, `space`/`q`/arrow controls (parsed by `lib/keys.js`, which buffers split escape sequences — bare ESC resolves as quit after 50ms), `SIGWINCH` respawn (restarts from frame 0), `←`/`→` seek ∓5s via decode+audio `-ss` respawn at `seekOffset` (scheduler takes an `offset` so `--stats` stays truthful; never add the offset twice — `elapsed()` already includes it), `--loop` via `-stream_loop -1`; exports `playStream/renderOnce/resolveRenderOptions` for reuse. Guarded `require.main === module` so tests can require without parsing argv.

## Conventions / gotchas
- Commit `package-lock.json`; only `node_modules` is gitignored.
- `process.stdout.columns/rows` fall back to 80x24 when piped; frame bytes guarded by 64 MiB cap.
- Brightness is per-channel -255..255 (×3 on 0..765 intensity); contrast (0, 5].
- `render` uses `-frames:v 1` + `realtime:false`; `play` always `-re` unless overridden in lib opts.
