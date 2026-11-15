import { EndBehaviorType } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { MAX_VOICE_SECONDS } from '../local-chat/realtime.mjs';
import { PlaybackEcho } from '../local-chat/playback-echo.mjs';

export const discordInputRate = 16_000;
const maxBytes = MAX_VOICE_SECONDS * discordInputRate * 2;
const minSpeechSamples = discordInputRate * 0.2;

// Decode one Discord user per turn. Keep the audio in memory until the turn is sent or discarded.
export function captureTurn(receiver, userId, { onTurn, onError, onSpeech, playbackFrame }) {
  const stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 800 } });
  let decoder;
  try { decoder = new OpusScript(discordInputRate, 1, OpusScript.Application.VOIP); }
  catch (error) { stream.destroy(); throw error; }
  const chunks = [];
  let size = 0;
  let speechSamples = 0;
  let echo;
  let speechConfirmed = false;
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
      const samples = pcm.length / 2;
      let power = 0;
      for (let offset = 0; offset < pcm.length; offset += 2) {
        power += (pcm.readInt16LE(offset) / 32768) ** 2;
      }
      let level = Math.sqrt(power / samples);
      const reference = playbackFrame?.(0);
      if (reference) {
        if (!echo) {
          echo = new PlaybackEcho();
          for (let delay = 360; delay > 0; delay -= 20) echo.voiceLevel([], playbackFrame(delay), 0);
        }
        const frame = Float32Array.from({ length: samples }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
        level = echo.voiceLevel(frame, reference, level);
      }
      if (level > (reference ? 0.012 : 0.006)) speechSamples += samples;
      chunks.push(pcm);
      size += pcm.length;
      if (!speechConfirmed && speechSamples >= minSpeechSamples) {
        speechConfirmed = true;
        onSpeech?.();
      }
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
