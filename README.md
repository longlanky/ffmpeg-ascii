# ffmpeg-ascii
`ffmpeg-ascii` takes an input video, converts it into ASCII frames, and prints them to screen.

![](https://user-images.githubusercontent.com/706138/107308123-e8212380-6a3c-11eb-9922-6c22f81ed1b5.gif)

*Example output https://i.imgur.com/V7nvQe7.gif*

### Installation

Clone this repo and `npm install`. Requires Node >= 18 and the `ffmpeg` + `ffprobe` executables on PATH ([install ffmpeg](https://ffmpeg.org/download.html) first — it ships `ffprobe`).

### Usage

```sh
node main.js play <input-video> [options]
node main.js render <input> [options]   # single frame to stdout (images or first video frame)
```

Or via the linked bin after `npm link`: `ffmpeg-ascii play <input-video>`.

Common options (both commands):

| Option | Default | Notes |
| --- | --- | --- |
| `-W, --width <n>`, `-H, --height <n>` | fit terminal | explicit size skips aspect fitting |
| `--fps <n>` | source rate | caps output frame rate |
| `--chars <string>` | `" .,:;i1tfLCG08@"` | dark → bright ramp |
| `--color` / `--no-color` | color | ANSI truecolor foreground per character |
| `--invert` | off | reverse ramp (negative image) |
| `--contrast <n>` | `1` | range (0, 5] |
| `--brightness <n>` | `0` | per-channel offset -255..255 |
| `--char-aspect <n>` | `~0.43` | character cell ratio override |
| `--no-fit` | fit | use raw terminal size |
| `--ffmpeg/--ffprobe <path>` | PATH / env | override binaries (`FFMPEG_PATH`, `FFPROBE_PATH`) |

`play` extras: `--loop`, `--output <file>` (plain-text frames, form-feed separated), `--no-display` (requires `--output`), `--audio` (see below), `--stats` (progress + effective fps on stderr).
`render` extras: `--output <file>` writes the frame instead of stdout.

### Audio

`play` can play sound alongside the ASCII video via a companion player (video stays the timing source; sync is approximate):

```sh
node main.js play clip.mp4 --audio
node main.js play clip.mp4 --audio --volume 50
node main.js play clip.mp4 --audio --audio-player mpv   # or AUDIO_PLAYER env
```

`--audio-player`/`--volume` imply `--audio`. Files without an audio stream print a warning and play silently. Pause (`space`) suspends the audio process too (SIGSTOP/SIGCONT, POSIX only). Still images ignore `--audio` with a warning.

Examples:

```sh
node main.js play clip.mp4
node main.js play clip.mp4 --width 100 --no-color --chars " .:-=+*#%@"
node main.js play clip.mp4 --fps 12 --contrast 1.2 --loop
node main.js render photo.png --width 80 > frame.txt
node main.js play clip.mp4 --output frames.txt --no-display
```

Playback keys (interactive terminal): `space` pause/resume, `q` quit. Resizing the terminal respawns the decoder at the new size (restarts from the beginning).

Playback stays on pace with the source: frames more than one frame-duration late are dropped (not rendered) so slow terminals can't accumulate lag — `--stats` shows `elapsed/total · effective fps · rendered (dropped N)`. Pause freezes presentation timestamps, so resume doesn't mass-drop.

### Development

```sh
npm test   # node --test test/ (no ffmpeg needed for unit tests)
```

Single-frame manual check: `node main.js render <file> --width 16 --no-color`.

### Backstory
*I initially started by looking at [ASCII-Video](https://github.com/fossage/ASCII-Video) as a way
to play videos in the terminal, but it is designed to pre-process all of the frames and store them
in an inefficent data format. After pulling bits of it apart I was left with `asciify-pixel` and
`commander` as dependencies.*
