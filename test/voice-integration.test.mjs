import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeSession } from '../local-chat/realtime.mjs';

const server = process.env.DISCOBUDDY_TEST_URL;

function resample24to16(pcm) {
  const samples = Math.floor(pcm.length / 2);
  const output = new Uint8Array(Math.floor(samples * 2 / 3) * 2);
  const source = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const result = new DataView(output.buffer);
  for (let i = 0; i < output.length / 2; i++) {
    const position = i * 1.5;
    const index = Math.floor(position);
    const weight = position - index;
    const a = source.getInt16(index * 2, true);
    const b = source.getInt16(Math.min(index + 1, samples - 1) * 2, true);
    result.setInt16(i * 2, Math.round(a * (1 - weight) + b * weight), true);
  }
  return output;
}

test('real local model answers spoken and typed turns with both selected voices', {
  skip: !server && 'Set DISCOBUDDY_TEST_URL to a running local Voice Lab server.',
  timeout: 120_000,
}, async () => {
  const base = new URL(server);
  const spoken = await fetch(new URL('/v1/audio/speech', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: 'Hello, what is two plus two?', voice: 'female', response_format: 'pcm' }),
  });
  assert.equal(spoken.ok, true, `Could not generate test speech: HTTP ${spoken.status}`);
  const input = resample24to16(new Uint8Array(await spoken.arrayBuffer()));
  assert.ok(input.length > 32000, 'The test question should contain at least one second of speech.');

  const socket = new URL('/v1/realtime', base);
  socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const voice of ['female', 'male']) {
    const chat = new RealtimeSession(socket);
    try {
      await chat.open('You are Discobuddy, a helpful friend. Keep replies short.', voice);
      for (const [label, question] of [['spoken', input], ['typed', 'What is two plus two?']]) {
        let delivered = 0;
        const result = await chat.ask(question, { onAudio: (bytes) => { delivered += bytes.length; } });
        assert.equal(result.status, 'completed', `${voice} ${label} turn`);
        assert.equal(result.speechError, undefined, `${voice} ${label} speech`);
        assert.match(result.text, /\b(?:4|four)\b/i, `${voice} ${label} answer`);
        assert.ok(delivered > 4800, `${voice} ${label} should stream nonempty audio`);
        assert.equal(delivered % 2, 0);
      }
      if (voice === 'male') {
        let interrupted = false;
        const cancelled = await chat.ask('Tell me a short story about a spaceship.', {
          onAudio() {
            if (!interrupted) {
              interrupted = true;
              chat.cancel();
            }
          },
        });
        assert.equal(interrupted, true, 'The reply should start streaming audio.');
        assert.equal(cancelled.status, 'cancelled');
        const next = await chat.ask(input);
        assert.equal(next.status, 'completed');
        assert.equal(next.speechError, undefined);
        assert.match(next.text, /\b(?:4|four)\b/i);
        assert.ok(next.audioSeconds > 0.1, 'The next spoken turn should receive audio.');
      }
    } finally {
      chat.close();
    }
  }
});
