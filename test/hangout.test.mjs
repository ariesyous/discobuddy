import assert from 'node:assert/strict';
import test from 'node:test';
import { generateLine } from '../discord-control/audio.mjs';
import { createHangout } from '../discord-control/hangout.mjs';
import { parseLines } from '../discord-control/lines.mjs';

function fakeClock() {
  let time = 0;
  let next = 0;
  const timers = new Map();
  return {
    now: () => time,
    schedule(fn, delay) { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; },
    unschedule(id) { timers.delete(id); },
    async advance(ms) {
      const end = time + ms;
      while (true) {
        const due = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!due || due[1].at > end) break;
        time = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      time = end;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

test('scripted lines go directly to TTS with exact wording and a supported voice', async () => {
  const input = 'Why did the robot say “I’m byte-sized”?';
  const sent = [];
  const request = async (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) });
    return new Response(Uint8Array.from([0, 0, 1, 0]), {
      headers: { 'content-type': 'audio/pcm; rate=24000; encoding=signed-int; bits=16' },
    });
  };
  const signal = new AbortController().signal;
  const result = await generateLine(8765, input, { voice: 'live', speed: 1 }, signal, request);
  assert.deepEqual(sent[0], {
    url: 'http://127.0.0.1:8765/v1/audio/speech',
    body: { input, voice: 'female', response_format: 'pcm', stream_format: 'audio' },
  });
  assert.equal(result.rate, 24_000);
  assert.deepEqual([...result.audio[0]], [0, 0, 1, 0]);
  await generateLine(8765, input, { voice: 'male', speed: 1 }, signal, request);
  assert.equal(sent[1].body.voice, 'male');
  await assert.rejects(generateLine(8765, input, { voice: 'female', speed: 1 }, signal,
    async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/wav' } })), /unsupported audio format/);
});

test('the bank trims blank lines, avoids duplicates, and rejects oversized lines', () => {
  assert.deepEqual(parseLines(' first \r\n\r\nsecond\nfirst '), ['first', 'second']);
  assert.throws(() => parseLines('x'.repeat(301)), /300 characters/);
  assert.throws(() => parseLines(Array.from({ length: 101 }, (_, i) => `${i}`).join('\n')), /100 lines/);
});

test('hangout waits for quiet and confirmed speech, uses each line once, and resets for a new channel', async () => {
  const clock = fakeClock();
  const status = { channelId: 'one', voice: 'ready', listening: true, people: 2, playing: false };
  const played = [];
  let stops = 0;
  const hangout = createHangout({
    ...clock, random: () => 0.99, getStatus: () => status, getLines: () => ['first', 'second'],
    playLine: async (line) => { played.push(line); return true; }, stopLine: () => { stops++; }, onError: assert.fail,
  });
  await clock.advance(180_000);
  assert.deepEqual(played, []);
  hangout.setEnabled(true);
  await clock.advance(89_999);
  assert.deepEqual(played, []);
  await clock.advance(1);
  assert.deepEqual(played, ['second']);
  await clock.advance(180_000);
  assert.deepEqual(played, ['second']);

  // A packet without confirmed speech (for example playback echo) does not rearm the mode.
  hangout.speechStarted('echo');
  hangout.speechEnded('echo');
  await clock.advance(180_000);
  assert.deepEqual(played, ['second']);

  hangout.speechStarted('alex');
  hangout.speechConfirmed('alex');
  assert.ok(stops > 0);
  hangout.speechStarted('sam');
  hangout.speechEnded('alex');
  await clock.advance(180_000);
  assert.deepEqual(played, ['second']);
  hangout.speechEnded('sam');
  await clock.advance(90_000);
  assert.deepEqual(played, ['second', 'first']);
  hangout.speechStarted('alex');
  hangout.speechConfirmed('alex');
  hangout.speechEnded('alex');
  await clock.advance(180_000);
  assert.deepEqual(played, ['second', 'first']);

  status.channelId = 'two';
  hangout.changed();
  await clock.advance(89_999);
  assert.equal(played.length, 2);
  await clock.advance(1);
  assert.deepEqual(played, ['second', 'first', 'second']);
  hangout.close();
});

for (const condition of ['disabled', 'listening stopped', 'last person left', 'channel changed', 'speech started']) {
  test(`pending hangout synthesis is cancelled when ${condition}`, async () => {
    const clock = fakeClock();
    const status = { channelId: 'one', voice: 'ready', listening: true, people: 1, playing: false };
    const deferred = Promise.withResolvers();
    let signal;
    let calls = 0;
    let completions = 0;
    const hangout = createHangout({
      ...clock, getStatus: () => status, getLines: () => ['line'], stopLine() {}, onError: assert.fail,
      playLine: async (_, controller) => {
        calls++;
        if (calls === 1) { signal = controller.signal; return deferred.promise; }
        completions++;
        return true;
      },
    });
    hangout.setEnabled(true);
    await clock.advance(90_000);
    assert.ok(signal);
    if (condition === 'disabled') hangout.setEnabled(false);
    if (condition === 'listening stopped') { status.listening = false; hangout.changed(); }
    if (condition === 'last person left') { status.people = 0; hangout.changed(); }
    if (condition === 'channel changed') { status.channelId = 'two'; hangout.changed(); }
    if (condition === 'speech started') hangout.speechStarted('alex');
    assert.equal(signal.aborted, true);
    deferred.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    // A late completion cannot consume the line in the current or next hangout.
    status.channelId = 'new'; status.people = 1; status.listening = true;
    hangout.setEnabled(true);
    hangout.changed();
    await clock.advance(90_000);
    assert.equal(completions, 1);
    hangout.close();
  });
}
