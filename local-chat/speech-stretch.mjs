// Waveform-similarity overlap-add keeps speech pitch stable as its duration changes.
export class SpeechStretch {
  #input = new Float32Array(0);
  #dropped = 0;
  #produced = 0;
  #tail;
  #hop;
  #search;
  #stride;

  constructor(sampleRate, speed) {
    this.sampleRate = sampleRate;
    this.speed = speed;
    this.#hop = Math.round(sampleRate * 0.02);
    this.#search = Math.round(sampleRate * 0.008);
    this.#stride = Math.max(1, Math.round(sampleRate / 6000));
  }

  append(samples) {
    const input = new Float32Array(this.#input.length + samples.length);
    input.set(this.#input);
    input.set(samples, this.#input.length);
    this.#input = input;
    return this.#render(false);
  }

  finish() {
    const samples = this.#render(true);
    this.#input = new Float32Array(0);
    this.#dropped = this.#produced = 0;
    this.#tail = undefined;
    return samples;
  }

  #render(final) {
    let input = this.#input;
    const end = input.length;
    const hop = this.#hop;
    const output = new Float32Array(Math.round((end + this.#dropped) / this.speed) - this.#produced);
    if (!output.length) return output;

    // Pad the last frame so a partial hop can still be blended and emitted.
    if (final) {
      const lastFrame = this.#produced + (Math.ceil(output.length / hop) - 1) * hop;
      const required = Math.round(lastFrame * this.speed) - this.#dropped + this.#search + 2 * hop;
      if (required > input.length) {
        input = new Float32Array(required);
        input.set(this.#input);
      }
    }

    let written = 0;
    while (written < output.length && (final || output.length - written >= hop)) {
      // Anchor the search on the input timeline so individual matches cannot skew the duration.
      const expected = Math.round((this.#produced + written) * this.speed) - this.#dropped;
      const last = Math.min(end - 1, expected + (this.#tail ? this.#search : 0));
      const required = expected + (this.#tail ? this.#search : 0) + 2 * hop;
      if (required > input.length) break;

      const length = Math.min(hop, output.length - written);
      const start = this.#tail ? this.#bestMatch(input, expected, last) : expected;
      if (this.#tail) {
        for (let i = 0; i < length; i++) {
          const blend = i / hop;
          output[written + i] = (1 - blend) * this.#tail[i] + blend * input[start + i];
        }
      } else {
        output.set(input.subarray(start, start + length), written);
        this.#tail = new Float32Array(hop);
      }
      this.#tail.set(input.subarray(start + hop, start + 2 * hop));
      written += length;
    }

    this.#produced += written;
    if (!final) {
      const earliest = Math.round(this.#produced * this.speed) - this.#search - this.#dropped;
      const drop = Math.max(0, Math.min(earliest, end));
      this.#input = this.#input.subarray(drop);
      this.#dropped += drop;
    }
    return output.subarray(0, written);
  }

  #bestMatch(input, expected, last) {
    const score = (start) => {
      let dot = 0;
      let energy = 1e-12;
      for (let i = 0; i < this.#hop; i += this.#stride) {
        const sample = input[start + i];
        dot += this.#tail[i] * sample;
        energy += sample * sample;
      }
      return dot / Math.sqrt(energy);
    };

    let best = expected;
    let similarity = score(expected);
    const first = Math.max(0, expected - this.#search);
    for (let start = first; start <= last; start += this.#stride) {
      const candidate = score(start);
      if (candidate > similarity) {
        best = start;
        similarity = candidate;
      }
    }
    return best;
  }
}
