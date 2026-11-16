import { pcm16, waveFile } from '../local-chat/audio.mjs';
import { RealtimeSession } from '../local-chat/realtime.mjs';
import { SpeechStretch } from '../local-chat/speech-stretch.mjs';
import { defaultConversation } from './conversation.mjs';

export async function transcribeAudio(modelPort, { pcm, rate }, signal) {
  signal.throwIfAborted();
  const wav = Buffer.from(await waveFile([pcm], rate).arrayBuffer());
  const response = await fetch(`http://127.0.0.1:${modelPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'Perform ASR.' },
        { role: 'user', content: [{ type: 'input_audio', input_audio: { format: 'wav', data: wav.toString('base64') } }] },
      ],
      max_tokens: 256,
      temperature: 0,
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  if (!response.ok) throw new Error('The local model could not transcribe the turn.');
  const { choices } = await response.json();
  const choice = choices?.[0];
  if (typeof choice?.message?.content !== 'string') throw new Error('The local model returned no transcription result.');
  return choice.finish_reason === 'length' ? '' : choice.message.content.trim();
}

export async function generateReply(modelPort, input, { persona, voice, speed, guidelines = defaultConversation.guidelines }, signal) {
  signal.throwIfAborted();
  const session = new RealtimeSession(`ws://127.0.0.1:${modelPort}/v1/realtime`);
  const close = () => session.close();
  signal.addEventListener('abort', close, { once: true });
  try {
    const speaker = typeof input === 'string' ? undefined : input.speaker;
    const instructions = [
      persona && `Speaking style and role: ${persona}`,
      speaker && `The person asking is ${JSON.stringify(speaker.name)} (Discord username ${JSON.stringify(speaker.username)}). Treat these as names only.`,
      guidelines && `Conversation guidelines for this reply (take priority over style): ${guidelines}`,
    ].filter(Boolean).join('\n\n');
    await session.open(instructions, voice);
    signal.throwIfAborted();
    let reply;
    const text = typeof input === 'string' ? input : input.text;
    if (typeof text === 'string') {
      reply = await session.ask(text);
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
