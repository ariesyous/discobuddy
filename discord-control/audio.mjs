import { pcm16, waveFile } from '../local-chat/audio.mjs';
import { RealtimeSession } from '../local-chat/realtime.mjs';
import { SpeechStretch } from '../local-chat/speech-stretch.mjs';

export async function generateReply(modelPort, input, { persona, voice, speed }, signal) {
  signal.throwIfAborted();
  const session = new RealtimeSession(`ws://127.0.0.1:${modelPort}/v1/realtime`);
  const close = () => session.close();
  signal.addEventListener('abort', close, { once: true });
  try {
    await session.open(persona, voice);
    signal.throwIfAborted();
    let reply;
    if (typeof input === 'string') {
      reply = await session.ask(input);
    } else {
      session.appendAudio(input.pcm, input.rate);
      reply = await session.finishAudio();
    }
    if (reply.speechError || !reply.audioSeconds || reply.status === 'failed') {
      throw new Error('The reply did not contain playable speech.');
    }
    const { audio, outputRate: rate } = reply;
    if (speed === 1) return { audio, rate };
    const stretch = new SpeechStretch(rate, speed);
    const chunks = audio.map((bytes) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const samples = Float32Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true) / 32768);
      return pcm16(stretch.append(samples));
    });
    chunks.push(pcm16(stretch.finish()));
    return { audio: chunks, rate };
  } finally {
    signal.removeEventListener('abort', close);
    close();
  }
}

export function previewWave({ audio, rate }) {
  return waveFile(audio, rate).arrayBuffer();
}

// Discord's Opus encoder takes signed 16-bit little-endian stereo at 48 kHz.
export function discordPcm({ audio, rate }) {
  const mono = Buffer.concat(audio);
  const frames = mono.length / 2;
  const result = Buffer.alloc(Math.round(frames * 48_000 / rate) * 4);
  for (let frame = 0, offset = 0; offset < result.length; frame++, offset += 4) {
    const position = frame * rate / 48_000;
    const i = Math.min(Math.floor(position), frames - 1);
    const a = mono.readInt16LE(i * 2);
    const b = mono.readInt16LE(Math.min(i + 1, frames - 1) * 2);
    const sample = Math.round(a + (b - a) * (position - i));
    result.writeInt16LE(sample, offset);
    result.writeInt16LE(sample, offset + 2);
  }
  return result;
}
