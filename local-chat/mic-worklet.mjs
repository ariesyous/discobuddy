import { FRAME_MS, SpeechTurns } from './speech-turns.mjs';

class MicrophoneProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.frameSize = Math.round(sampleRate * FRAME_MS / 1000);
    const maxFrames = Math.floor(sampleRate * processorOptions.maxSeconds / this.frameSize);
    this.turns = new SpeechTurns(maxFrames);
    this.referenceFrame = new Float32Array(this.frameSize);
    this.listening = false;
    this.port.onmessage = ({ data }) => {
      this.listening = data.listening;
      this.listenId = data.id;
      this.turns.reset();
      this.frame = new Float32Array(this.frameSize);
      this.offset = 0;
    };
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!this.listening || !input) return true;
    const reference = inputs[1]?.[0];

    // AudioWorklet blocks need not align with the speech detector's 20 ms frames.
    let consumed = 0;
    while (consumed < input.length) {
      const count = Math.min(this.frameSize - this.offset, input.length - consumed);
      this.frame.set(input.subarray(consumed, consumed + count), this.offset);
      if (reference) this.referenceFrame.set(reference.subarray(consumed, consumed + count), this.offset);
      else this.referenceFrame.fill(0, this.offset, this.offset + count);
      this.offset += count;
      consumed += count;
      if (this.offset < this.frameSize) continue;

      const event = this.turns.push(this.frame, this.referenceFrame);
      if (event?.type === 'turn') {
        this.listening = false;
        this.port.postMessage({ ...event, id: this.listenId }, [event.samples.buffer]);
        break;
      }
      if (event) this.port.postMessage({ ...event, id: this.listenId });
      this.frame = new Float32Array(this.frameSize);
      this.offset = 0;
    }
    return true;
  }
}

registerProcessor('discobuddy-microphone', MicrophoneProcessor);
