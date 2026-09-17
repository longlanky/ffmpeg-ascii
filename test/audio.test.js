'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveAudioPlayer,
  audioRequested,
  validateVolume,
  buildAudioArgs,
} = require('../lib/audio');

test('resolveAudioPlayer prefers explicit, then env, then ffplay', () => {
  assert.equal(resolveAudioPlayer({ audioPlayer: '/usr/bin/mpv' }), '/usr/bin/mpv');
  const prev = process.env.AUDIO_PLAYER;
  process.env.AUDIO_PLAYER = 'mpv';
  try {
    assert.equal(resolveAudioPlayer({}), 'mpv');
    assert.equal(resolveAudioPlayer({ audioPlayer: 'ffplay' }), 'ffplay');
  } finally {
    if (prev == null) delete process.env.AUDIO_PLAYER;
    else process.env.AUDIO_PLAYER = prev;
  }
  delete process.env.AUDIO_PLAYER;
  assert.equal(resolveAudioPlayer({}), 'ffplay');
});

test('audioRequested is true for any audio flag', () => {
  assert.equal(audioRequested({}), false);
  assert.equal(audioRequested({ audio: true }), true);
  assert.equal(audioRequested({ audioPlayer: 'mpv' }), true);
  assert.equal(audioRequested({ volume: 50 }), true);
});

test('validateVolume accepts 0..100 only', () => {
  assert.equal(validateVolume(0), 0);
  assert.equal(validateVolume('75'), 75);
  assert.throws(() => validateVolume(-1), /volume/);
  assert.throws(() => validateVolume(101), /volume/);
  assert.throws(() => validateVolume('loud'), /volume/);
});

test('buildAudioArgs for ffplay', () => {
  assert.deepEqual(buildAudioArgs('clip.mp4', {}), {
    player: 'ffplay',
    args: ['-nodisp', '-autoexit', '-loglevel', 'error', 'clip.mp4'],
  });
  assert.deepEqual(buildAudioArgs('clip.mp4', { loop: true, volume: 50 }).args, [
    '-nodisp', '-autoexit', '-loglevel', 'error', '-loop', '0', '-volume', '50', 'clip.mp4',
  ]);
});

test('buildAudioArgs for mpv, incl. basename matching', () => {
  assert.deepEqual(buildAudioArgs('clip.mp4', { audioPlayer: '/usr/bin/mpv', loop: true }).args, [
    '--no-video', '--really-quiet', '--loop=inf', 'clip.mp4',
  ]);
  assert.deepEqual(buildAudioArgs('clip.mp4', { audioPlayer: 'mpv', volume: 80 }).args, [
    '--no-video', '--really-quiet', '--volume=80', 'clip.mp4',
  ]);
});

test('buildAudioArgs rejects unknown players and bad input', () => {
  assert.throws(() => buildAudioArgs('clip.mp4', { audioPlayer: 'aplay' }), /unknown audio player/);
  assert.throws(() => buildAudioArgs('', {}), /input path required/);
  assert.throws(() => buildAudioArgs('clip.mp4', { volume: 500 }), /volume/);
});
