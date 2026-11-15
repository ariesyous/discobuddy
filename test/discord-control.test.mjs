import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { discordPcm } from '../discord-control/audio.mjs';
import { createControlServer } from '../discord-control/server.mjs';

const audio = { audio: [Buffer.from([0, 0, 0xD0, 7]), Buffer.from([0xBE, 0xFB])], rate: 24_000 };
const channelId = '123456789012345678';

async function serve(t, options) {
  const server = await createControlServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (path) => fetch(origin + path),
    post: (path, body, from = origin) => fetch(origin + path, {
      method: 'POST', headers: { Origin: from, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  };
}

test('previews speech without a bot and rejects changes from another origin', async (t) => {
  const settings = { persona: 'Use a friendly tone.', voice: 'female', speed: 1.25 };
  const { get, post } = await serve(t, {
    synthesize: async (_, prompt, active) => {
      assert.equal(prompt, 'Say hello');
      assert.deepEqual(active, settings);
      return audio;
    },
  });
  assert.equal((await get('/api/status').then((res) => res.json())).gateway, 'token needed');
  assert.equal((await get('/.env.discord')).status, 404);
  assert.equal((await post('/api/settings', settings, 'http://different-site.test')).status, 403);
  assert.equal((await post('/api/settings', { ...settings, speed: 8 })).status, 400);
  assert.equal((await post('/api/settings', settings)).status, 200);
  assert.equal((await post('/api/speak', { prompt: 'Say hello' })).status, 409);
  const preview = await post('/api/preview', { prompt: 'Say hello' });
  assert.equal(preview.headers.get('content-type'), 'audio/wav');
  const wav = Buffer.from(await preview.arrayBuffer());
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.deepEqual(wav.subarray(44), Buffer.concat(audio.audio));
});

test('leaving cancels a pending reply before it can play in a different channel', async (t) => {
  let selected;
  let played = 0;
  const { promise: started, resolve: markStarted } = Promise.withResolvers();
  const { get, post } = await serve(t, {
    token: 'fixture-token',
    makeBot: (_, voiceLost) => ({
      start() {},
      status: () => ({ gateway: 'online', voice: selected ? 'ready' : 'idle', channelId: selected }),
      join(id) { selected = id; },
      leave() { voiceLost(); selected = undefined; },
      play() { played++; },
      close() {},
    }),
    synthesize: async (_, prompt, settings, signal) => {
      if (prompt === 'Cancel me') {
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(audio), { once: true });
          markStarted();
        });
      }
      return audio;
    },
  });
  assert.equal((await post('/api/join', { channelId })).status, 200);
  assert.equal((await post('/api/speak', { prompt: 'First reply' })).status, 200);
  assert.equal(played, 1);
  const pending = post('/api/speak', { prompt: 'Cancel me' });
  await started;
  assert.equal((await post('/api/leave', {})).status, 200);
  assert.equal((await pending).status, 409);
  assert.equal((await post('/api/join', { channelId: '123456789012345679' })).status, 200);
  assert.equal(played, 1);
  const status = await get('/api/status').then((res) => res.text());
  assert.equal(JSON.parse(status).channelId, '123456789012345679');
  assert.equal(status.includes('fixture-token'), false);
});

test('converts mono model samples to continuous 48 kHz stereo PCM', () => {
  const raw = discordPcm(audio);
  const left = [];
  for (let offset = 0; offset < raw.length; offset += 4) {
    left.push(raw.readInt16LE(offset));
    assert.equal(raw.readInt16LE(offset), raw.readInt16LE(offset + 2));
  }
  assert.deepEqual(left, [0, 1000, 2000, 455, -1090, -1090]);
});

test('replies carry the correct speaker through successive turns and stop listening cancels pending playback', async (t) => {
  const { promise: cancelled, resolve: markCancelled } = Promise.withResolvers();
  const pcm = Buffer.alloc(16_000);
  const first = { pcm, rate: 16_000, speaker: { name: 'Alex', username: 'alex.one' } };
  const second = { pcm, rate: 16_000, speaker: { name: 'Alex', username: 'alex.two' } };
  const replies = [];
  const settings = { persona: 'Answer in one sentence.', voice: 'live', speed: 1.25 };
  let submitSpeech;
  let listening = false;
  let played;
  const { post, get } = await serve(t, {
    token: 'fixture-token',
    makeBot: (_, _lost, { onUtterance, onListeningStopped }) => {
      submitSpeech = onUtterance;
      return {
        start() {},
        join() { listening = true; },
        status: () => ({ gateway: 'online', voice: 'ready', listening, playing: false }),
        setListening(enabled) {
          listening = enabled;
          if (!enabled) onListeningStopped();
        },
        play(reply, speaker) { replies.push({ reply, speaker }); played(); },
        close() {},
      };
    },
    synthesize: async (_, input, applied, signal) => {
      assert.deepEqual(applied, settings);
      if (input === first || input === second) return audio;
      return new Promise((resolve) => signal.addEventListener('abort', () => {
        resolve(audio);
        markCancelled();
      }, { once: true }));
    },
  });
  assert.equal((await post('/api/settings', settings)).status, 200);
  submitSpeech(first);
  assert.equal(replies.length, 0);
  assert.equal((await post('/api/join', { channelId })).status, 200);
  assert.equal((await get('/api/status').then((res) => res.json())).listening, true);
  for (const turn of [first, second]) {
    await new Promise((resolve) => { played = resolve; submitSpeech(turn); });
  }
  assert.deepEqual(replies, [first, second].map(({ speaker }) => ({ reply: audio, speaker })));
  submitSpeech({ ...second });
  const pending = await get('/api/status').then((res) => res.json());
  assert.equal(pending.responding, true);
  assert.deepEqual(pending.speaker, second.speaker);
  assert.equal((await post('/api/listen', { enabled: false })).status, 200);
  await cancelled;
  const status = await get('/api/status').then((res) => res.json());
  assert.equal(status.responding, false);
  assert.equal(status.listening, false);
  assert.equal(status.speaker, null);
  assert.equal(replies.length, 2);
});

test('sustained incoming Opus interrupts before the turn ends and preserves its first samples', async (t) => {
  try { import.meta.resolve('opusscript'); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return t.skip('Run npm ci for the Discord Opus dependency.');
    throw error;
  }
  const [{ default: OpusScript }, { captureTurn }] = await Promise.all([
    import('opusscript'), import('../discord-control/receive.mjs'),
  ]);
  const encoder = new OpusScript(16_000, 1, OpusScript.Application.VOIP);
  t.after(() => encoder.delete());
  const tone = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) tone.writeInt16LE(Math.round(4500 * Math.sin(i * Math.PI / 20)), 2 * i);

  async function exercise(frameCount) {
    const stream = new PassThrough({ objectMode: true });
    const events = [];
    const result = new Promise((resolve, reject) => captureTurn({ subscribe: () => stream }, 'speaker', {
      onSpeech: () => events.push('interrupted'),
      onTurn: (pcm) => { events.push('turn ended'); resolve(pcm); },
      onError: () => reject(new Error('Discord Opus frame could not be decoded.')),
      playbackFrame: () => new Float32Array(320),
    }));
    for (let i = 0; i < frameCount; i++) stream.write(encoder.encode(tone, 320));
    const beforeEnd = events.slice();
    stream.end();
    return { pcm: await result, beforeEnd, events };
  }

  assert.deepEqual(await exercise(2), { pcm: undefined, beforeEnd: [], events: ['turn ended'] });
  const sustained = await exercise(16);
  assert.deepEqual(sustained.beforeEnd, ['interrupted']);
  assert.deepEqual(sustained.events, ['interrupted', 'turn ended']);
  assert.equal(sustained.pcm.length, 16 * 640);
});
