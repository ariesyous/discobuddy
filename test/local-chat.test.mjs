import assert from 'node:assert/strict';
import test from 'node:test';
import { pcm16, waveFile } from '../local-chat/audio.mjs';
import { RealtimeSession } from '../local-chat/realtime.mjs';
import { SpeechTurns } from '../local-chat/speech-turns.mjs';

class TestSocket extends EventTarget {
  static current;
  readyState = 1;
  events = [];

  constructor() { super(); TestSocket.current = this; }
  send(data) { this.events.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  emit(type, fields = {}) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type, ...fields }) })); }
}

const sessionInfo = { audio: { input: { format: { rate: 16000 } }, output: { format: { rate: 24000 } } } };

async function start(persona = 'Be a patient coach.', { voice = 'live', request } = {}) {
  const chat = new RealtimeSession('ws://127.0.0.1:8765/v1/realtime', { Socket: TestSocket, fetch: request });
  const opening = chat.open(persona, voice);
  if (voice !== 'live') await new Promise(setImmediate);
  const wire = TestSocket.current;
  wire.emit('session.created', { session: sessionInfo });
  wire.emit('session.updated');
  await opening;
  return { chat, wire };
}

function speechServer({ voices = ['female', 'male'], slots = 2, chunks = [[0, 1, 2], [3]] } = {}) {
  const calls = [];
  const request = async (url, options = {}) => {
    if (url.pathname === '/props') return Response.json({ voices, total_slots: slots });
    calls.push(JSON.parse(options.body));
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'audio/pcm;rate=24000;encoding=signed-int;bits=16' } });
  };
  return { calls, request };
}

async function eventually(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail('The expected asynchronous operation did not happen.');
}

test('sets the persona before either turn and keeps both turns on the same session', async (t) => {
  const { chat, wire } = await start();
  t.after(() => chat.close());
  assert.match(wire.events[0].session.instructions, /Be a patient coach\.$/);
  for (const prompt of ['Call me Sam.', 'What is my name?']) {
    const answer = chat.ask(prompt);
    assert.equal(wire.events.at(-2).item.content[0].text, prompt);
    assert.equal(wire.events.at(-1).type, 'response.create');
    assert.throws(() => chat.ask('Interruption'), /wait/i);
    wire.emit('response.output_text.delta', { delta: 'Sam' });
    wire.emit('response.output_audio.delta', { delta: 'AAA=' });
    wire.emit('response.done', { response: { status: 'completed' } });
    const result = await answer;
    assert.equal(result.text, 'Sam');
    assert.equal(result.outputRate, 24000);
    assert.equal(result.audioSeconds, 1 / 24000);
    assert.ok(result.totalMs >= result.firstAudioMs);
  }
  assert.equal(wire.events.filter((event) => event.type === 'session.update').length, 1);
});

test('delivers a voice turn as sample-aligned chunks and commits it before generation', async (t) => {
  const { chat, wire } = await start();
  t.after(() => chat.close());
  const pcm = Uint8Array.from({ length: 3000 }, (_, i) => i & 255);
  const answer = chat.ask(pcm);
  const chunks = wire.events.filter((event) => event.type === 'input_audio_buffer.append');
  assert.equal(chunks.length, 2);
  assert.deepEqual(Buffer.concat(chunks.map(({ audio }) => Buffer.from(audio, 'base64'))), Buffer.from(pcm));
  assert.deepEqual(wire.events.slice(-2).map(({ type }) => type), ['input_audio_buffer.commit', 'response.create']);
  chat.cancel();
  wire.emit('response.done', { response: { status: 'cancelled' } });
  assert.equal(wire.events.at(-1).type, 'response.cancel');
  assert.equal((await answer).status, 'cancelled');
  assert.equal(chat.ready, true);
});

test('cancelling stops delivery immediately and waits for the server before another turn', async (t) => {
  const { chat, wire } = await start();
  t.after(() => chat.close());
  const delivered = [];
  const first = chat.ask('Start a long reply.', {
    onText: (text) => delivered.push(text),
    onAudio: () => delivered.push('audio'),
  });
  wire.emit('response.output_text.delta', { delta: 'Before interruption' });
  wire.emit('response.output_audio.delta', { delta: 'AAA=' });
  chat.cancel();
  chat.cancel();
  wire.emit('response.output_text.delta', { delta: 'Late text' });
  wire.emit('response.output_audio.delta', { delta: 'AAA=' });
  assert.deepEqual(delivered, ['Before interruption', 'audio']);
  assert.throws(() => chat.ask('New turn'), /wait/i);
  assert.equal(wire.events.filter(({ type }) => type === 'response.cancel').length, 1);

  wire.emit('response.done', { response: { status: 'completed' } });
  assert.equal((await first).status, 'cancelled');
  const second = chat.ask('Continue with the interruption.');
  wire.emit('response.output_text.delta', { delta: 'Next reply' });
  wire.emit('response.done', { response: { status: 'completed' } });
  assert.equal((await second).text, 'Next reply');
});

test('streams complete sentences in the selected voice, aligns PCM chunks, and uses the new voice in a new session', async (t) => {
  const server = speechServer();
  const { chat, wire } = await start('Be a patient coach.', { voice: 'male', request: server.request });
  t.after(() => chat.close());
  assert.deepEqual(wire.events[0].session.output_modalities, ['text', 'audio']);
  const audio = [];
  const answer = chat.ask('Hello', { onAudio: (bytes) => audio.push(...bytes) });
  wire.emit('response.output_audio.delta', { delta: 'AAA=' });
  assert.deepEqual(audio, []);
  wire.emit('response.output_text.delta', { delta: 'Hello. How are' });
  await eventually(() => audio.length === 4);
  assert.equal(server.calls[0].voice, 'male');
  assert.equal(server.calls[0].input, 'Hello.');
  assert.deepEqual(audio, [0, 1, 2, 3]);
  wire.emit('response.output_text.delta', { delta: ' you?' });
  wire.emit('response.done', { response: { status: 'completed' } });
  const result = await answer;
  assert.equal(result.text, 'Hello. How are you?');
  assert.equal(result.audio.length, 4);
  assert.equal(server.calls[1].input, 'How are you?');
  assert.equal(server.calls[1].voice, 'male');
  chat.close();

  const next = await start('A different persona.', { voice: 'female', request: server.request });
  t.after(() => next.chat.close());
  const second = next.chat.ask('Hello');
  next.wire.emit('response.output_text.delta', { delta: 'Hi.' });
  next.wire.emit('response.done', { response: { status: 'completed' } });
  await second;
  assert.equal(server.calls.at(-1).voice, 'female');
  assert.match(next.wire.events[0].session.instructions, /A different persona\.$/);
});

test('rejects unavailable voices and a server with only one slot', async () => {
  for (const [voice, server, expected] of [
    ['robot', speechServer(), /available voices/],
    ['male', speechServer({ voices: ['female'] }), /does not support the male voice/],
    ['male', speechServer({ slots: 1 }), /two model slots/],
  ]) {
    const chat = new RealtimeSession('ws://127.0.0.1:8765/v1/realtime', { Socket: TestSocket, fetch: server.request });
    await assert.rejects(chat.open('Test', voice), expected);
    chat.close();
  }
});

test('cancels in-flight speech after text completes and allows another turn', async (t) => {
  let aborted = false;
  let speechStarted = false;
  const request = async (url, options = {}) => {
    if (url.pathname === '/props') return Response.json({ voices: ['male'], total_slots: 2 });
    speechStarted = true;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true }));
  };
  const { chat, wire } = await start('Test', { voice: 'male', request });
  t.after(() => chat.close());
  const answer = chat.ask('Hello');
  wire.emit('response.output_text.delta', { delta: 'Hello.' });
  wire.emit('response.done', { response: { status: 'completed' } });
  await eventually(() => speechStarted);
  chat.cancel();
  assert.equal(aborted, true);
  assert.equal((await answer).status, 'cancelled');
  assert.equal(wire.events.filter(({ type }) => type === 'response.cancel').length, 0);
  const next = chat.ask('Next');
  chat.cancel();
  wire.emit('response.done', { response: { status: 'cancelled' } });
  assert.equal((await next).status, 'cancelled');
});

test('interrupting a selected voice cancels generation and speech without delivering late audio', async (t) => {
  let speechStarted = false;
  const request = async (url, options = {}) => {
    if (url.pathname === '/props') return Response.json({ voices: ['female'], total_slots: 2 });
    speechStarted = true;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true }));
  };
  const { chat, wire } = await start('Test', { voice: 'female', request });
  t.after(() => chat.close());
  const played = [];
  const answer = chat.ask('Hello', { onAudio: (bytes) => played.push(bytes) });
  wire.emit('response.output_text.delta', { delta: 'Hello. There is more' });
  await eventually(() => speechStarted);
  chat.cancel();
  assert.equal(wire.events.at(-1).type, 'response.cancel');
  wire.emit('response.output_text.delta', { delta: ' late text' });
  wire.emit('response.output_audio.delta', { delta: 'AAA=' });
  wire.emit('response.done', { response: { status: 'completed' } });
  const result = await answer;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.text, 'Hello. There is more');
  assert.deepEqual(played, []);
});

test('rejects speech with a mismatched PCM format', async (t) => {
  const request = async (url) => url.pathname === '/props'
    ? Response.json({ voices: ['male'], total_slots: 2 })
    : new Response(Uint8Array.of(0, 0, 0, 0), { headers: { 'Content-Type': 'audio/pcm;rate=24000;encoding=float;bits=32' } });
  const { chat, wire } = await start('Test', { voice: 'male', request });
  t.after(() => chat.close());
  const answer = chat.ask('Hello');
  wire.emit('response.output_text.delta', { delta: 'Hi.' });
  wire.emit('response.done', { response: { status: 'completed' } });
  const result = await answer;
  assert.match(result.speechError, /unsupported audio format/);
  assert.equal(result.audio.length, 0);
});

test('preserves the text and reports an unavailable speech response', async (t) => {
  const request = async (url) => url.pathname === '/props'
    ? Response.json({ voices: ['male'], total_slots: 2 })
    : new Response('unavailable', { status: 503 });
  const { chat, wire } = await start('Test', { voice: 'male', request });
  t.after(() => chat.close());
  const answer = chat.ask('Hello');
  wire.emit('response.output_text.delta', { delta: 'Hi.' });
  wire.emit('response.done', { response: { status: 'completed' } });
  const result = await answer;
  assert.equal(result.text, 'Hi.');
  assert.match(result.speechError, /HTTP 503/);
  assert.equal(result.audio.length, 0);
  assert.equal(chat.ready, true);
});

test('rejects a text-only backend before it can receive a recording', async () => {
  const chat = new RealtimeSession('ws://127.0.0.1:8765/v1/realtime', { Socket: TestSocket });
  const opening = chat.open('Test');
  const wire = TestSocket.current;
  wire.emit('session.created', { session: { audio: { input: { format: { rate: 16000 } } } } });
  await assert.rejects(opening, /speech input and output rates/);
  assert.equal(wire.events.length, 0);
  assert.equal(wire.readyState, 3);
});

test('encodes little-endian mono PCM at the model rate for replay', async () => {
  const pcm = pcm16(Float32Array.of(-1, 0, 1));
  const wav = Buffer.from(await waveFile([pcm], 24000).arrayBuffer());
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(40), 6);
  assert.deepEqual([44, 46, 48].map((offset) => wav.readInt16LE(offset)), [-32768, 0, 32767]);
});

test('ignores a click and keeps a brief pause inside one voice turn', () => {
  const detector = new SpeechTurns(1000);
  const quiet = new Float32Array(320);
  const voice = Float32Array.from(quiet, (_, i) => 0.08 * Math.sin(i / 8));
  const feed = (frame, count) => Array.from({ length: count }, () => detector.push(frame)).filter(Boolean);

  assert.deepEqual(feed(quiet, 12), []);
  assert.deepEqual(feed(voice, 1), []);
  assert.deepEqual(feed(quiet, 50), []);
  assert.deepEqual(feed(voice, 15), [{ type: 'speech' }]);
  assert.deepEqual(feed(quiet, 20), []);
  assert.deepEqual(feed(voice, 15), []);
  const [turn] = feed(quiet, 50);
  assert.equal(turn.type, 'turn');
  assert.ok(turn.silenceMs >= 700 && turn.silenceMs < 900);
  assert.ok(turn.samples.length > (15 + 20 + 15) * quiet.length);
  assert.ok(turn.samples.length < (15 + 20 + 15 + 38) * quiet.length);
  assert.deepEqual(feed(quiet, 50), []);
});

test('discarding speech on pause clears the unfinished turn and the turn cap stays bounded', () => {
  const detector = new SpeechTurns(32);
  const quiet = new Float32Array(320);
  const voice = Float32Array.from(quiet, (_, i) => 0.08 * Math.sin(i / 8));
  const feed = (frame, count) => Array.from({ length: count }, () => detector.push(frame)).filter(Boolean);

  assert.deepEqual(feed(voice, 8), [{ type: 'speech' }]);
  detector.reset();
  assert.deepEqual(feed(quiet, 50), []);
  const [began, turn] = feed(voice, 32);
  assert.equal(began.type, 'speech');
  assert.equal(turn.type, 'turn');
  assert.equal(turn.silenceMs, 0);
  assert.equal(turn.samples.length, 32 * voice.length);
});

test('speaker echo does not start a turn but voice over echo keeps its beginning', () => {
  const detector = new SpeechTurns(1000);
  const rate = 16000;
  const frameSize = 320;
  const delay = 1003;
  const playback = Float32Array.from({ length: 130 * frameSize }, (_, i) => {
    const t = i / rate;
    return 0.14 * (0.7 + 0.2 * Math.sin(t * 21)) * (Math.sin(t * 1470 + 0.8 * Math.sin(t * 138)) + 0.3 * Math.sin(t * 5060));
  });
  const speechStarts = 40 * frameSize;
  const speechEnds = 65 * frameSize;
  const voice = (i) => 0.08 * Math.sin(i * 0.282) + 0.025 * Math.sin(i * 0.43);
  const events = [];
  for (let offset = 0; offset < playback.length; offset += frameSize) {
    const mic = Float32Array.from({ length: frameSize }, (_, i) => {
      const index = offset + i;
      const echo = 0.44 * (playback[index - delay] ?? 0);
      return echo + (index >= speechStarts && index < speechEnds ? voice(index) : 0);
    });
    const event = detector.push(mic, playback.subarray(offset, offset + frameSize));
    if (event) events.push({ offset, ...event });
  }
  assert.deepEqual(events.map(({ type }) => type), ['speech', 'turn']);
  assert.ok(events[0].offset >= speechStarts && events[0].offset < speechStarts + 7 * frameSize);
  const startOfRecording = events[0].offset - 10 * frameSize;
  const firstWord = events[1].samples[speechStarts - startOfRecording + 20];
  assert.ok(Math.abs(firstWord - voice(speechStarts + 20)) < 0.06);
  assert.ok(Math.abs(firstWord) > 0.025);
});
