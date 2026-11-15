export function pcm16(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const level = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(level * (level < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export function waveFile(chunks, sampleRate) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = new DataView(new ArrayBuffer(44));
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']]) {
    for (let i = 0; i < text.length; i++) header.setUint8(offset + i, text.charCodeAt(i));
  }
  header.setUint32(4, 36 + size, true);
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  header.setUint32(40, size, true);
  return new Blob([header.buffer, ...chunks], { type: 'audio/wav' });
}

export function openMicrophone() {
  return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
}

export async function recordMicrophone() {
  const stream = await openMicrophone();
  const release = () => stream.getTracks().forEach((track) => track.stop());
  try {
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.addEventListener('dataavailable', ({ data }) => { if (data.size) chunks.push(data); });
    const done = new Promise((resolve, reject) => {
      recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: recorder.mimeType })), { once: true });
      recorder.addEventListener('error', (event) => reject(event.error), { once: true });
    }).finally(release);
    recorder.start();
    return {
      done,
      stop() { if (recorder.state !== 'inactive') recorder.stop(); },
    };
  } catch (error) {
    release();
    throw error;
  }
}

export async function decodeRecording(blob, audioContext, rate, maxSeconds) {
  if (!blob.size) throw new Error('No microphone audio was captured.');
  const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
  return audioBufferToPcm(decoded, rate, maxSeconds);
}

export async function audioBufferToPcm(decoded, rate, maxSeconds) {
  const frames = Math.min(Math.ceil(decoded.duration * rate), maxSeconds * rate);
  if (frames < rate / 5) throw new Error('That recording was too short. Try pressing Record and speaking a full sentence.');
  const mono = new OfflineAudioContext(1, frames, rate);
  const source = mono.createBufferSource();
  source.buffer = decoded;
  source.connect(mono.destination);
  source.start();
  const buffer = await mono.startRendering();
  return pcm16(buffer.getChannelData(0));
}

export class Playback {
  #sources = new Set();
  #replays = new WeakMap();
  #next = 0;

  constructor(onChange = () => {}) {
    this.onChange = onChange;
  }

  get playing() { return this.#sources.size > 0; }

  async unlock() {
    if (!this.context) {
      this.context = new AudioContext();
      this.output = this.context.createGain();
      this.output.connect(this.context.destination);
    }
    if (this.context.state !== 'running') await this.context.resume();
  }

  connectReplay(audio) {
    if (this.#replays.has(audio)) return;
    const source = this.context.createMediaElementSource(audio);
    source.connect(this.output);
    this.#replays.set(audio, source);
  }

  disconnectReplay(audio) {
    this.#replays.get(audio)?.disconnect();
    this.#replays.delete(audio);
  }

  append(bytes, rate) {
    const context = this.context;
    if (context?.state !== 'running' || !bytes.length) return;
    const buffer = context.createBuffer(1, bytes.length / 2, rate);
    const samples = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    source.onended = () => {
      if (this.#sources.delete(source) && !this.playing) this.onChange();
    };
    const startAt = this.#next < context.currentTime ? context.currentTime + 0.18 : this.#next;
    source.start(startAt);
    this.#next = startAt + buffer.duration;
    const wasPlaying = this.playing;
    this.#sources.add(source);
    if (!wasPlaying) this.onChange();
  }

  stop() {
    const wasPlaying = this.playing;
    for (const source of this.#sources) source.stop();
    this.#sources.clear();
    this.#next = 0;
    if (wasPlaying) this.onChange();
  }
}
