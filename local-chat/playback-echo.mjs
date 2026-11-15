const BINS = 80;
const HISTORY_FRAMES = 19; // Up to 360 ms of delay in 20 ms frames.
const MIN_REFERENCE_POWER = BINS * 0.004 ** 2;
const MIN_MATCH = 0.68;

function binAverages(samples, bins) {
  let offset = 0;
  for (let i = 0; i < bins.length; i++) {
    const end = Math.floor((i + 1) * samples.length / bins.length);
    let sum = 0;
    for (let j = offset; j < end; j++) sum += samples[j];
    bins[i] = sum / (end - offset);
    offset = end;
  }
}

export class PlaybackEcho {
  #history = new Float32Array(HISTORY_FRAMES * BINS);
  #mic = new Float32Array(BINS);
  #referenceFrames = 0;

  voiceLevel(frame, reference, micLevel) {
    const history = this.#history;
    const latest = history.length - BINS;
    history.copyWithin(0, BINS);
    const tail = history.subarray(latest);
    if (reference) binAverages(reference, tail);
    else tail.fill(0);

    let referenceSum = 0;
    let referencePower = 0;
    for (const sample of tail) {
      referenceSum += sample;
      referencePower += sample * sample;
    }
    if (referencePower >= MIN_REFERENCE_POWER) this.#referenceFrames = HISTORY_FRAMES;
    else this.#referenceFrames = Math.max(0, this.#referenceFrames - 1);
    if (!this.#referenceFrames || micLevel < 0.005) return micLevel;

    binAverages(frame, this.#mic);
    const mean = this.#mic.reduce((sum, sample) => sum + sample, 0) / BINS;
    let micPower = 0;
    for (let i = 0; i < BINS; i++) {
      this.#mic[i] -= mean;
      micPower += this.#mic[i] ** 2;
    }
    if (!micPower) return micLevel;

    // Look for an attenuated, time-shifted copy of the speaker signal in the mic.
    let bestMatch = 0;
    for (let start = latest; start >= 0; start--) {
      const power = referencePower - referenceSum ** 2 / BINS;
      if (power >= MIN_REFERENCE_POWER) {
        let dot = 0;
        for (let i = 0; i < BINS; i++) dot += this.#mic[i] * history[start + i];
        bestMatch = Math.max(bestMatch, dot ** 2 / (micPower * power));
        if (bestMatch >= 0.995) break;
      }
      if (start === 0) break;
      const added = history[start - 1];
      const removed = history[start + BINS - 1];
      referenceSum += added - removed;
      referencePower += added ** 2 - removed ** 2;
    }

    // Only discount a strong match. Independent speech can still exceed the threshold.
    return bestMatch < MIN_MATCH ? micLevel : micLevel * Math.sqrt(Math.max(0, 1 - bestMatch));
  }
}
