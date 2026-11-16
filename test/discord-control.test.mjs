import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { discordPcm } from '../discord-control/audio.mjs';
import { addressedRequest, defaultConversation } from '../discord-control/conversation.mjs';
import { createControlServer } from '../discord-control/server.mjs';

const audio = { audio: [Buffer.from([0, 0, 0xD0, 7]), Buffer.from([0xBE, 0xFB])], rate: 24_000 };
const channelId = '123456789012345678';

async function serve(t, options) {
  const server = await createControlServer({ linesPath: null, settingsPath: null, ...options });
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
      assert.deepEqual(active, { ...settings, ...defaultConversation });
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
        status: () => ({ gateway: 'online', voice: 'ready', listening, playing: false, people: 1 }),
        setListening(enabled) {
          listening = enabled;
          if (!enabled) onListeningStopped();
        },
        play(reply, speaker) { replies.push({ reply, speaker }); played(); },
        close() {},
      };
    },
    synthesize: async (_, input, applied, signal) => {
      assert.deepEqual(applied, { ...settings, ...defaultConversation });
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

test('recognizes a call for DiscoBuddy without treating a mention as a request', () => {
  assert.equal(addressedRequest('Hey, Disco Buddy, what is seven plus five?'), 'what is seven plus five?');
  assert.equal(addressedRequest('Discobuddy can you help?'), 'can you help?');
  assert.equal(addressedRequest('What do you think, DiscoBuddy?'), 'What do you think');
  assert.equal(addressedRequest('DiscoBuddy?'), '');
  assert.equal(addressedRequest("DiscoBuddy's microphone is on."), null);
  assert.equal(addressedRequest('Disco Buddy is listening.'), null);
  assert.equal(addressedRequest('Sam, ask DiscoBuddy about the game.'), null);
  assert.equal(addressedRequest('Is DiscoBuddy listening?'), null);
});

test('group turns stay quiet unless called and side talk cannot stop a reply in addressed mode', async (t) => {
  const conversations = [];
  let people = 2;
  let playing = false;
  let stops = 0;
  let submitSpeech;
  let activeInterruptionMode;
  const speaker = { name: 'Alex', username: 'alex.one' };
  const settings = { persona: 'Casual.', voice: 'live', speed: 1, guidelines: 'Keep it to one line.' };
  const { post, get } = await serve(t, {
    token: 'fixture-token',
    makeBot: (_, _lost, { onUtterance, interruptionMode }) => {
      submitSpeech = onUtterance;
      activeInterruptionMode = interruptionMode;
      return {
        start() {},
        status: () => ({ voice: 'ready', listening: true, people, playing }),
        play() {},
        close() {},
      };
    },
    transcribe: async (_, input) => input.fixtureTranscript,
    synthesize: async (_, input, applied) => {
      conversations.push({ input, guidelines: applied.guidelines });
      return audio;
    },
  });
  async function speak(fixtureTranscript, overlap) {
    const input = { pcm: Buffer.alloc(2), rate: 16_000, speaker, fixtureTranscript };
    submitSpeech(input, overlap);
    await new Promise(setImmediate);
    return input;
  }
  assert.equal((await post('/api/settings', { ...settings, interruptions: 'invalid' })).status, 400);
  assert.equal((await post('/api/settings', settings)).status, 200);
  assert.equal(activeInterruptionMode(), 'addressed');
  await speak('Alex, do you see the game?');
  assert.equal(conversations.length, 0);
  await speak('Disco Buddy, what is seven plus five?');
  assert.deepEqual(conversations, [{ input: { text: 'what is seven plus five?', speaker }, guidelines: settings.guidelines }]);
  assert.equal((await get('/api/status').then((res) => res.text())).includes('seven plus five'), false);

  playing = true;
  const overlap = { mode: 'addressed', stop() { stops++; playing = false; } };
  await speak('Alex, wait.', overlap);
  assert.equal(stops, 0);
  assert.equal(conversations.length, 1);
  await speak('DiscoBuddy, stop.', overlap);
  assert.equal(stops, 1);
  assert.equal(conversations.length, 1);

  people = 1;
  const solo = await speak('What is the score?');
  assert.equal(conversations.at(-1).input, solo);
  assert.equal((await post('/api/settings', { ...settings, replyMode: 'open', interruptions: 'any' })).status, 200);
  assert.equal(activeInterruptionMode(), 'any');
  people = 3;
  const open = await speak('What happened in the last round?');
  assert.equal(conversations.at(-1).input, open);
  assert.equal(conversations.length, 3);
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

test('saved lines survive a panel restart and previews use the selected saved wording', async (t) => {
  const linesPath = join(tmpdir(), `discobuddy-lines-${randomUUID()}.json`);
  t.after(() => rm(linesPath, { force: true }));
  const spoken = [];
  const first = await serve(t, {
    linesPath,
    synthesizeLine: async (_, line, settings) => { spoken.push({ line, voice: settings.voice }); return audio; },
  });
  assert.equal((await first.post('/api/lines', { text: ' First punchline! \n\nA question?\nFirst punchline!' })).status, 200);
  assert.equal((await first.post('/api/line-preview', { index: 1, line: 'stale' })).status, 409);
  const preview = await first.post('/api/line-preview', { index: 1, line: 'A question?' });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(spoken, [{ line: 'A question?', voice: 'live' }]);

  const restarted = await serve(t, { linesPath });
  assert.deepEqual((await restarted.get('/api/status').then((res) => res.json())).lines, ['First punchline!', 'A question?']);
  assert.equal((await restarted.get('/api/status').then((res) => res.json())).hangout, false);
  assert.equal((await restarted.post('/api/lines', { text: 'x'.repeat(301) })).status, 400);
  assert.equal((await first.post('/api/lines', { text: 'Replacement' })).status, 200);
  const afterReplacement = await serve(t, { linesPath });
  assert.deepEqual((await afterReplacement.get('/api/status').then((res) => res.json())).lines, ['Replacement']);
});

test('prompt drafts can be counted and previewed without changing saved Discord settings', async (t) => {
  const settingsPath = join(tmpdir(), `discobuddy-prompt-${randomUUID()}.json`);
  t.after(() => rm(settingsPath, { force: true }));
  const original = { persona: 'A'.repeat(3000), guidelines: 'B'.repeat(2000), voice: 'live', speed: 1 };
  const draft = { ...original, persona: 'Draft persona', guidelines: 'Draft guidance', voice: 'female' };
  const generated = [];
  const counts = [];
  const { get, post } = await serve(t, {
    settingsPath,
    token: 'fixture-token',
    makeBot: () => ({
      start() {}, status: () => ({ voice: 'ready', channelId, playing: false }), play() {}, close() {},
    }),
    countTokens: async (_, prompt) => { counts.push(prompt); return 1600; },
    synthesize: async (_, prompt, settings) => { generated.push({ prompt, settings }); return audio; },
  });
  assert.equal((await post('/api/settings', original)).status, 200);
  const count = await post('/api/prompt-tokens', { persona: ' Draft persona ', guidelines: ' Draft guidance ' });
  assert.deepEqual(await count.json(), { count: 1600, budget: 1500 });
  assert.deepEqual(counts, [{ persona: 'Draft persona', guidelines: 'Draft guidance' }]);
  assert.equal((await post('/api/preview', { prompt: 'Hello', settings: draft })).status, 200);
  assert.equal(generated[0].settings.persona, draft.persona);
  assert.equal(generated[0].settings.guidelines, draft.guidelines);
  assert.equal(generated[0].settings.voice, 'female');
  assert.equal((await get('/api/status').then((res) => res.json())).settings.persona, original.persona);
  assert.equal((await post('/api/speak', { prompt: 'Hello' })).status, 200);
  assert.equal(generated[1].settings.persona, original.persona);
  assert.equal(generated[1].settings.guidelines, original.guidelines);
  assert.equal((await post('/api/preview', { prompt: 'Hello', settings: null })).status, 400);
  assert.equal((await post('/api/prompt-tokens', { persona: 'x'.repeat(12_001), guidelines: '' })).status, 400);

  const restarted = await serve(t, { settingsPath });
  const restored = (await restarted.get('/api/status').then((res) => res.json())).settings;
  assert.equal(restored.persona, original.persona);
  assert.equal(restored.guidelines, original.guidelines);
  assert.equal(restored.voice, 'live');
});

test('a spoken turn takes priority over pending and playing hangout lines', async (t) => {
  let time = 0;
  let timer;
  let hooks;
  let pendingSignal;
  let playingHangout = false;
  const deferred = Promise.withResolvers();
  const played = [];
  const status = { voice: 'ready', channelId, listening: true, people: 1, playing: false, capturing: false };
  const { post, get } = await serve(t, {
    token: 'fixture-token',
    hangoutOptions: {
      now: () => time,
      schedule(fn, delay) { timer = { fn, at: time + delay }; return timer; },
      unschedule(id) { if (timer === id) timer = undefined; },
    },
    makeBot: (_, _lost, callbacks) => {
      hooks = callbacks;
      return {
        start() {}, status: () => ({ ...status }),
        play(reply, speaker, options) {
          played.push({ speaker, hangout: Boolean(options?.hangout) });
          status.playing = true;
          playingHangout = Boolean(options?.hangout);
          callbacks.onActivityChanged();
        },
        stopHangout() {
          if (playingHangout) { playingHangout = false; status.playing = false; callbacks.onActivityChanged(); }
        },
        close() {},
      };
    },
    synthesizeLine: async (_, _line, _settings, signal) => {
      if (!pendingSignal) { pendingSignal = signal; return deferred.promise; }
      return audio;
    },
    synthesize: async () => audio,
  });
  assert.equal((await post('/api/lines', { text: 'A saved question?' })).status, 200);
  assert.equal((await post('/api/hangout', { enabled: true })).status, 200);
  time += 90_000;
  timer.fn(); timer = undefined;
  assert.ok(pendingSignal);
  assert.equal((await get('/api/status').then((res) => res.json())).busy, true);
  hooks.onHumanStart('alex');
  assert.equal(pendingSignal.aborted, true);
  hooks.onHumanSpeech('alex');
  const speaker = { name: 'Alex', username: 'alex' };
  hooks.onUtterance({ pcm: Buffer.alloc(2), rate: 16_000, speaker });
  hooks.onHumanEnd('alex');
  await new Promise(setImmediate);
  assert.deepEqual(played, [{ speaker, hangout: false }]);
  deferred.resolve(audio);
  await new Promise(setImmediate);
  assert.equal(played.length, 1);

  status.playing = false;
  hooks.onActivityChanged();
  time += 90_000;
  assert.ok(timer && timer.at <= time);
  timer.fn(); timer = undefined;
  await new Promise(setImmediate);
  assert.equal(played.at(-1).hangout, true);
  assert.equal(status.playing, true);
  hooks.onHumanStart('alex');
  assert.equal(status.playing, true); // Echo alone must not stop playback.
  hooks.onHumanSpeech('alex');
  assert.equal(status.playing, false);
  hooks.onHumanEnd('alex');
});
