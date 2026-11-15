import { PlaybackEcho } from './playback-echo.mjs';

export const FRAME_MS = 20;
const START_FRAMES = 5;
const PRE_ROLL_FRAMES = 11;
const END_PAUSE_FRAMES = 38;
const TAIL_FRAMES = 6;
const CHUNK_FRAMES = 4;

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
  #chunk = [];
  #heldSilence = [];
  #turnFrames = 0;
  #onset = 0;
  #onsetAge = 0;
  #quiet = 0;
  #noise = 0.002;
  #echo = new PlaybackEcho();

  constructor(maxFrames) {
    this.maxFrames = maxFrames;
  }

  reset() {
    this.#lead = [];
    this.#chunk = [];
    this.#heldSilence = [];
    this.#turnFrames = 0;
    this.#onset = 0;
    this.#onsetAge = 0;
    this.#quiet = 0;
  }

  push(frame, reference) {
    const micLevel = rms(frame);
    const level = this.#echo.voiceLevel(frame, reference, micLevel);
    if (level < 0.005 && level < micLevel) frame = new Float32Array(frame.length);
    if (!this.#turnFrames) {
      this.#lead.push(frame);
      if (this.#lead.length > PRE_ROLL_FRAMES) this.#lead.shift();
      if (level >= Math.max(0.008, this.#noise * 2.8)) {
        this.#onset++;
      } else {
        this.#onset = Math.max(0, this.#onset - 1);
        this.#noise += 0.05 * (level - this.#noise);
      }
      this.#onsetAge = this.#onset ? this.#onsetAge + 1 : 0;
      if (this.#onset < START_FRAMES) return;
      const frames = this.#lead;
      this.#turnFrames = frames.length;
      this.#lead = [];
      return { type: 'speech', frames, onsetDelayMs: this.#onsetAge * FRAME_MS };
    }

    this.#turnFrames++;
    if (level < Math.max(0.005, this.#noise * 1.8)) {
      this.#quiet++;
      // Keep longer pauses only if speech resumes. The turn retains 120 ms of trailing quiet.
      if (this.#quiet > TAIL_FRAMES) this.#heldSilence.push(frame);
      else this.#chunk.push(frame);
    } else {
      this.#quiet = 0;
      this.#chunk.push(...this.#heldSilence, frame);
      this.#heldSilence = [];
    }

    if (this.#quiet >= END_PAUSE_FRAMES || this.#turnFrames >= this.maxFrames) {
      const event = { type: 'turn', frames: this.#chunk, silenceMs: this.#quiet * FRAME_MS };
      this.reset();
      return event;
    }
    if (this.#chunk.length >= CHUNK_FRAMES) {
      const frames = this.#chunk;
      this.#chunk = [];
      return { type: 'audio', frames };
    }
  }
}
