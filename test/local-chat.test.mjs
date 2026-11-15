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

async function start(persona = 'Be a patient coach.') {
  const chat = new RealtimeSession('ws://127.0.0.1:8765/v1/realtime', { Socket: TestSocket });
  const opening = chat.open(persona);
  const wire = TestSocket.current;
  wire.emit('session.created', { session: sessionInfo });
  wire.emit('session.updated');
  await opening;
  return { chat, wire };
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

test('streams chunks before commit and switches between microphone and recorded audio rates', async (t) => {
  const { chat, wire } = await start();
  t.after(() => chat.close());
  const types = () => wire.events.map(({ type }) => type);
  const firstChunk = Uint8Array.of(1, 2, 3, 4);
  const secondChunk = Uint8Array.of(5, 6);
  chat.appendAudio(firstChunk, 48000);
  assert.deepEqual(types().slice(1), ['session.update', 'input_audio_buffer.append']);
  assert.equal(wire.events[1].session.audio.input.format.rate, 48000);
  assert.throws(() => chat.ask('A competing typed turn'), /wait/i);
  chat.appendAudio(secondChunk, 48000);
  assert.deepEqual(types().slice(2), ['input_audio_buffer.append', 'input_audio_buffer.append']);
  assert.deepEqual(wire.events.slice(2).map(({ audio }) => Array.from(atob(audio), (byte) => byte.charCodeAt(0))),
    [[1, 2, 3, 4], [5, 6]]);
  assert.equal(chat.pendingAudioSeconds, 3 / 48000);

  const voiceReply = chat.finishAudio();
  assert.deepEqual(types().slice(-2), ['input_audio_buffer.commit', 'response.create']);
  wire.emit('response.done', { response: { status: 'completed' } });
  await voiceReply;
  const recordedReply = chat.ask(firstChunk);
  assert.deepEqual(types().slice(-4), ['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create']);
  assert.equal(wire.events.at(-4).session.audio.input.format.rate, 16000);
  wire.emit('response.done', { response: { status: 'completed' } });
  await recordedReply;
});

test('cancelling stops delivery immediately and holds the next utterance until the server drains', async (t) => {
  const { chat, wire } = await start();
  t.after(() => chat.close());
  const delivered = [];
  const first = chat.ask('Start a long reply.', {
    onText: (text) => delivered.push(text),
    onAudio: () => delivered.push('audio'),
  });
  wire.emit('response.output_text.delta', { delta: 'Before interruption' });
  wire.emit('response.output_audio.delta', { delta: 'AAA=' });
  assert.throws(() => chat.appendAudio(Uint8Array.of(1, 2)), /wait/i);
  chat.cancel();
  chat.cancel();
  chat.appendAudio(Uint8Array.of(1, 2));
  chat.appendAudio(Uint8Array.of(3, 4));
  wire.emit('response.output_text.delta', { delta: 'Late text' });
  wire.emit('response.output_audio.delta', { delta: 'AAA=' });
  assert.deepEqual(delivered, ['Before interruption', 'audio']);
  assert.throws(() => chat.ask('New turn'), /wait/i);
  assert.throws(() => chat.finishAudio(), /wait/i);
  assert.equal(wire.events.at(-1).type, 'response.cancel');
  assert.equal(wire.events.filter(({ type }) => type === 'response.cancel').length, 1);

  wire.emit('response.done', { response: { status: 'completed' } });
  assert.equal((await first).status, 'cancelled');
  assert.deepEqual(wire.events.slice(-2).map(({ type, audio }) => [type, audio]),
    [['input_audio_buffer.append', 'AQI='], ['input_audio_buffer.append', 'AwQ=']]);
  const second = chat.finishAudio();
  wire.emit('response.output_text.delta', { delta: 'Next reply' });
  wire.emit('response.done', { response: { status: 'completed' } });
  assert.equal((await second).text, 'Next reply');
});

test('discarding queued speech keeps the session and discarding transmitted speech closes it', async () => {
  const { chat, wire } = await start();
  const pcm = Uint8Array.of(1, 2);
  const reply = chat.ask('Start a reply.');
  chat.cancel();
  chat.appendAudio(pcm);
  assert.equal(chat.discardAudio(), false);
  wire.emit('response.done', { response: { status: 'cancelled' } });
  await reply;
  assert.equal(wire.events.at(-1).type, 'response.cancel');

  chat.appendAudio(pcm);
  assert.equal(chat.discardAudio(), true);
  assert.equal(chat.ready, false);
  assert.equal(wire.readyState, 3);
  assert.equal(wire.events.at(-1).type, 'input_audio_buffer.append');
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
  const speech = feed(voice, 15);
  assert.equal(speech[0].type, 'speech');
  assert.equal(speech[0].onsetDelayMs, 100);
  assert.ok(speech.some(({ type }) => type === 'audio'));
  const pause = feed(quiet, 20);
  const resumed = feed(voice, 15);
  const ending = feed(quiet, 50);
  const turn = ending.at(-1);
  assert.equal(turn.type, 'turn');
  assert.equal(turn.silenceMs, 760);
  assert.deepEqual([...speech, ...pause, ...resumed, ...ending].flatMap(({ frames }) => frames), [
    ...Array(6).fill(quiet), ...Array(15).fill(voice), ...Array(20).fill(quiet),
    ...Array(15).fill(voice), ...Array(6).fill(quiet),
  ]);
  assert.deepEqual(feed(quiet, 50), []);
});

test('discarding speech on pause clears the unfinished turn and the turn cap stays bounded', () => {
  const detector = new SpeechTurns(32);
  const quiet = new Float32Array(320);
  const voice = Float32Array.from(quiet, (_, i) => 0.08 * Math.sin(i / 8));
  const feed = (frame, count) => Array.from({ length: count }, () => detector.push(frame)).filter(Boolean);

  assert.deepEqual(feed(voice, 8).map(({ type }) => type), ['speech']);
  detector.reset();
  assert.deepEqual(feed(quiet, 50), []);
  const events = feed(voice, 26);
  const turn = events.at(-1);
  assert.equal(events[0].type, 'speech');
  assert.equal(turn.type, 'turn');
  assert.equal(turn.silenceMs, 0);
  assert.deepEqual(events.flatMap(({ frames }) => frames), [...Array(6).fill(quiet), ...Array(26).fill(voice)]);
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
  assert.deepEqual(events.flatMap(({ type }) => type === 'audio' ? [] : [type]), ['speech', 'turn']);
  assert.ok(events[0].offset >= speechStarts && events[0].offset < speechStarts + 7 * frameSize);
  const startOfRecording = events[0].offset - 10 * frameSize;
  const firstSample = speechStarts - startOfRecording + 20;
  const firstWord = events[0].frames[Math.floor(firstSample / frameSize)][firstSample % frameSize];
  assert.ok(Math.abs(firstWord - voice(speechStarts + 20)) < 0.06);
  assert.ok(Math.abs(firstWord) > 0.025);
});
