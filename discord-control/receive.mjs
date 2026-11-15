import { EndBehaviorType } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { MAX_VOICE_SECONDS } from '../local-chat/realtime.mjs';

export const discordInputRate = 16_000;
const maxBytes = MAX_VOICE_SECONDS * discordInputRate * 2;
const minSpeechSamples = discordInputRate * 0.2;

// Decode only the selected speaker. The decoded turn lives in memory until it is sent or discarded.
export function captureTurn(receiver, userId, { onTurn, onError }) {
  const stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 800 } });
  let decoder;
  try { decoder = new OpusScript(discordInputRate, 1, OpusScript.Application.VOIP); }
  catch (error) { stream.destroy(); throw error; }
  const chunks = [];
  let size = 0;
  let speechSamples = 0;
  let done = false;
  const timer = setTimeout(() => finish(true), MAX_VOICE_SECONDS * 1000);

  function finish(send) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    stream.destroy();
    decoder.delete();
    onTurn(send && speechSamples >= minSpeechSamples ? Buffer.concat(chunks, size) : undefined);
  }

  stream.on('data', (packet) => {
    if (done) return;
    try {
      const pcm = decoder.decode(packet).subarray(0, maxBytes - size);
      let power = 0;
      const samples = pcm.length / 2;
      for (let offset = 0; offset < pcm.length; offset += 2) {
        power += (pcm.readInt16LE(offset) / 32768) ** 2;
      }
      if (power > samples * 0.006 ** 2) speechSamples += samples;
      chunks.push(pcm);
      size += pcm.length;
      if (size >= maxBytes) finish(true);
    } catch {
      onError();
      finish(false);
    }
  });
  stream.once('end', () => finish(true));
  stream.on('error', () => {
    if (done) return;
    onError();
    finish(false);
  });
  stream.once('close', () => finish(false));
  return () => finish(false);
}
