import assert from 'node:assert/strict';
import { once } from 'node:events';
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

test('a spoken turn uses the current settings and stopping listening prevents late playback', async (t) => {
  const { promise: cancelled, resolve: markCancelled } = Promise.withResolvers();
  const { promise: played, resolve: markPlayed } = Promise.withResolvers();
  const speaker = '123456789012345679';
  const speech = { pcm: Buffer.alloc(16_000), rate: 16_000 };
  const settings = { persona: 'Answer in one sentence.', voice: 'live', speed: 1.25 };
  let submitSpeech;
  let listenerId;
  let playbackCount = 0;
  const { post, get } = await serve(t, {
    token: 'fixture-token',
    makeBot: (_, _lost, { onUtterance, onListeningStopped }) => {
      submitSpeech = onUtterance;
      return {
        start() {},
        status: () => ({ gateway: 'online', voice: 'ready', listenerId, playing: false }),
        setListener(id) {
          listenerId = id;
          if (!id) onListeningStopped();
        },
        play(reply, spoken) { playbackCount++; markPlayed({ reply, spoken }); },
        close() {},
      };
    },
    synthesize: async (_, input, applied, signal) => {
      assert.deepEqual(applied, settings);
      if (input === speech) return audio;
      return new Promise((resolve) => signal.addEventListener('abort', () => {
        resolve(audio);
        markCancelled();
      }, { once: true }));
    },
  });
  assert.equal((await post('/api/settings', settings)).status, 200);
  submitSpeech(speech);
  assert.equal(playbackCount, 0);
  assert.equal((await post('/api/listen', { userId: speaker })).status, 200);
  submitSpeech(speech);
  assert.deepEqual(await played, { reply: audio, spoken: true });
  submitSpeech({ ...speech });
  assert.equal((await get('/api/status').then((res) => res.json())).responding, true);
  assert.equal((await post('/api/listen', { userId: null })).status, 200);
  await cancelled;
  const status = await get('/api/status').then((res) => res.json());
  assert.equal(status.responding, false);
  assert.equal(status.listenerId, null);
  assert.equal(playbackCount, 1);
});
