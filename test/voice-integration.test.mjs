import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleInstructions, countPromptTokens, generateLine, generateReply, shouldJoinConversation } from '../discord-control/audio.mjs';
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
  const spokenPcm = new Uint8Array(await spoken.arrayBuffer());
  const input = resample24to16(spokenPcm);
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
        const chunkBytes = 24000 * 2 * 0.08;
        let interrupted = false;
        const cancelled = await chat.ask('Tell me a short story about a spaceship.', {
          onAudio() {
            if (!interrupted) {
              interrupted = true;
              chat.cancel();
              chat.appendAudio(spokenPcm.subarray(0, chunkBytes), 24000);
            }
          },
        });
        assert.equal(interrupted, true, 'The reply should start streaming audio.');
        assert.equal(cancelled.status, 'cancelled');
        for (let offset = chunkBytes; offset < spokenPcm.length; offset += chunkBytes) {
          chat.appendAudio(spokenPcm.subarray(offset, offset + chunkBytes), 24000);
        }
        const next = await chat.finishAudio();
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

test('real local model handles a spoken turn with a 1,500-token prompt', {
  skip: !server && 'Set DISCOBUDDY_TEST_URL to a running local Voice Lab server.',
  timeout: 120_000,
}, async () => {
  const base = new URL(server);
  const port = Number(base.port || (base.protocol === 'https:' ? 443 : 80));
  const request = (url, options) => fetch(new URL(new URL(url).pathname, base), options);
  const draft = (repetitions) => ({
    persona: 'You are a helpful teammate. Our team color is teal.',
    guidelines: `Answer briefly. ${'Be clear and friendly when answering. '.repeat(repetitions)}Our team mascot is a koala.`,
  });
  let low = 0;
  let high = 1000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (await countPromptTokens(port, draft(middle), request) <= 1500) low = middle;
    else high = middle - 1;
  }
  const settings = draft(low);
  assert.ok(await countPromptTokens(port, settings, request) >= 1450);
  const spoken = await request(`http://127.0.0.1:${port}/v1/audio/speech`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: 'What are our team color and mascot?', voice: 'female', response_format: 'pcm' }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(spoken.ok, true);
  const spokenPcm = new Uint8Array(await spoken.arrayBuffer());
  assert.ok(spokenPcm.length > 24_000, 'The question should contain audible speech.');
  const socket = new URL('/v1/realtime', base);
  socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
  const chat = new RealtimeSession(socket);
  try {
    await chat.open(assembleInstructions(settings, { name: 'Alex', username: 'alex' }), 'live');
    chat.appendAudio(spokenPcm, 24_000);
    const result = await chat.finishAudio();
    assert.equal(result.status, 'completed');
    assert.ok(result.audioSeconds > 0.1, 'The spoken turn should receive audio.');
    assert.match(result.text, /\bteal\b/i);
    assert.match(result.text, /\bkoala\b/i);
  } finally {
    chat.close();
  }
});

test('Discord generates the male voice while another model session is open', {
  skip: !server && 'Set DISCOBUDDY_TEST_URL to a running local Voice Lab server.',
  timeout: 120_000,
}, async (t) => {
  const base = new URL(server);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname)) {
    return t.skip('The Discord model connection uses a local HTTP server.');
  }
  const socket = new URL('/v1/realtime', base);
  socket.protocol = 'ws:';
  const otherSession = new RealtimeSession(socket);
  try {
    await otherSession.open('Keep replies short.');
    const result = await generateReply(Number(base.port || 80), 'What is two plus two?', {
      persona: 'Keep replies short.', voice: 'male', speed: 1,
    }, AbortSignal.timeout(100_000));
    assert.equal(result.rate, 24_000);
    assert.ok(result.audio.reduce((total, bytes) => total + bytes.length, 0) > 4800);
  } finally {
    otherSession.close();
  }
});

test('real local model synthesizes a saved line directly', {
  skip: !server && 'Set DISCOBUDDY_TEST_URL to a running local Voice Lab server.',
  timeout: 120_000,
}, async () => {
  const base = new URL(server);
  const port = Number(base.port || (base.protocol === 'https:' ? 443 : 80));
  const request = (url, options) => fetch(new URL(new URL(url).pathname, base), options);
  const result = await generateLine(port, 'What game could you play forever?', { voice: 'live', speed: 1 }, new AbortController().signal, request);
  assert.equal(result.rate, 24_000);
  assert.ok(Buffer.concat(result.audio).length > result.rate, 'The saved line should contain audible speech.');
});

test('real local model distinguishes group questions from side conversation', {
  skip: !server && 'Set DISCOBUDDY_TEST_URL to a running local Voice Lab server.',
  timeout: 120_000,
}, async () => {
  const base = new URL(server);
  const port = Number(base.port || (base.protocol === 'https:' ? 443 : 80));
  const request = (url, options) => fetch(new URL(new URL(url).pathname, base), options);
  for (const [text, expected] of [
    ['What cooperative game should we play?', true],
    ['Sam, did you finish your dinner?', false],
    ['Yeah, sounds good.', false],
    ['We are stuck on this puzzle. Any ideas?', true],
  ]) {
    const result = await shouldJoinConversation(port, { recent: [], latest: { speaker: 'Alex', text } }, AbortSignal.timeout(20_000), request);
    assert.equal(result, expected, text);
  }
});
