import { PlaybackEcho } from './playback-echo.mjs';

export const FRAME_MS = 20;
const START_FRAMES = 5;
const PRE_ROLL_FRAMES = 11;
const END_PAUSE_FRAMES = 38;
const TAIL_FRAMES = 6;

function rms(frame) {
  let sum = 0;
  let squares = 0;
  for (const sample of frame) {
    sum += sample;
    squares += sample * sample;
  }
  return Math.sqrt(Math.max(0, squares / frame.length - (sum / frame.length) ** 2));
}

export class SpeechTurns {
  #lead = [];
  #utterance;
  #onset = 0;
  #quiet = 0;
  #noise = 0.002;
  #echo = new PlaybackEcho();

  constructor(maxFrames) {
    this.maxFrames = maxFrames;
  }

  reset() {
    this.#lead = [];
    this.#utterance = undefined;
    this.#onset = 0;
    this.#quiet = 0;
  }

  push(frame, reference) {
    const micLevel = rms(frame);
    const level = this.#echo.voiceLevel(frame, reference, micLevel);
    if (level < 0.005 && level < micLevel) frame = new Float32Array(frame.length);
    if (!this.#utterance) {
      this.#lead.push(frame);
      if (this.#lead.length > PRE_ROLL_FRAMES) this.#lead.shift();
      if (level >= Math.max(0.008, this.#noise * 2.8)) {
        this.#onset++;
      } else {
        this.#onset = Math.max(0, this.#onset - 1);
        this.#noise += 0.05 * (level - this.#noise);
      }
      if (this.#onset < START_FRAMES) return;
      this.#utterance = this.#lead;
      this.#lead = [];
      return { type: 'speech' };
    }

    this.#utterance.push(frame);
    this.#quiet = level < Math.max(0.005, this.#noise * 1.8) ? this.#quiet + 1 : 0;
    if (this.#quiet < END_PAUSE_FRAMES && this.#utterance.length < this.maxFrames) return;

    const frames = this.#utterance.length - Math.max(0, this.#quiet - TAIL_FRAMES);
    const samples = new Float32Array(frames * frame.length);
    for (let i = 0; i < frames; i++) samples.set(this.#utterance[i], i * frame.length);
    const silenceMs = this.#quiet * FRAME_MS;
    this.reset();
    return { type: 'turn', samples, silenceMs };
  }
}
