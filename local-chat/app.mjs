import { Playback, decodeRecording, recordMicrophone, waveFile } from './audio.mjs';
import { openHandsFree } from './hands-free.mjs';
import { MAX_VOICE_SECONDS, RealtimeSession, replyKey, VOICES } from './realtime.mjs';

const presets = {
  buddy: 'You are Discobuddy, a laid-back friend in voice chat. Give warm, natural replies in one or two short sentences. Ask a follow-up only if it helps.',
  deadpan: 'You are Discobuddy, the dry, deadpan teammate in a co-op game. Be helpful and playfully understated. Use one short sentence at a time.',
  coach: 'You are Discobuddy, a patient coach. Explain one concrete thing at a time in plain, spoken language. Keep replies to two short sentences.',
  blank: '',
};
const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'preset', 'persona', 'voice', 'new-chat', 'persona-status', 'message', 'message-form', 'send', 'record',
  'record-label', 'hands-free', 'hands-free-label', 'cancel', 'connection', 'transcript', 'empty',
  'messages', 'activity', 'autoplay', 'playback-speed',
].map((id) => [id, byId(id)]));
const sampleButtons = ui.empty.querySelectorAll('button');
const playback = new Playback(playbackChanged);
const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder && globalThis.AudioContext && globalThis.OfflineAudioContext);
const canHandsFree = Boolean(navigator.mediaDevices?.getUserMedia && globalThis.AudioWorkletNode && globalThis.AudioContext);
const playbackUrls = new Set();
const personaKey = 'discobuddy.persona';
const voiceKey = 'discobuddy.voice';
const playbackSpeedKey = 'discobuddy.playback-speed';
const MIN_REPEAT_CHARS = 48;
const socketUrl = new URL('/v1/realtime', location.href);
socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

let client;
let phase = 'idle';
let recording;
let recordingTimer;
let sendTime;
let handsFree;
let activeReply;
let audibleReply;
let lastAnswer;
let activePersona = presets.buddy;
let activeVoice = 'live';
try { activePersona = (localStorage.getItem(personaKey) ?? activePersona).slice(0, 2400); } catch { /* Storage may be disabled. */ }
try { const saved = localStorage.getItem(voiceKey); if (VOICES.includes(saved)) activeVoice = saved; } catch { /* Storage may be disabled. */ }
ui.persona.value = activePersona;
ui.voice.value = activeVoice;
try {
  const saved = localStorage.getItem(playbackSpeedKey);
  if (Array.from(ui['playback-speed'].options).some(({ value }) => value === saved)) ui['playback-speed'].value = saved;
} catch { /* Storage may be disabled. */ }
playback.setSpeed(Number(ui['playback-speed'].value));

function reflectPersona() {
  const draft = ui.persona.value.trim();
  ui.preset.value = Object.keys(presets).find((key) => presets[key] === draft) ?? 'custom';
  ui['persona-status'].textContent = draft === activePersona && ui.voice.value === activeVoice
    ? 'Start a new chat to clear the conversation.'
    : 'Unsaved changes. Start a new chat to apply your settings.';
}

function render() {
  const ready = client?.ready;
  const idle = phase === 'idle' && !activeReply;
  ui.connection.dataset.state = ready ? 'ready' : phase === 'connecting' ? 'connecting' : 'offline';
  ui.connection.textContent = ready ? 'Local model ready' : phase === 'connecting' ? 'Connecting' : 'Disconnected';
  ui['new-chat'].disabled = !idle;
  ui.message.disabled = !ready || !idle;
  ui.send.disabled = !ready || !idle || handsFree?.speechStartedAt != null || !ui.message.value.trim();
  ui.record.disabled = !ready || !canRecord || Boolean(handsFree) || (!idle && phase !== 'recording');
  ui.record.dataset.recording = phase === 'recording';
  ui['record-label'].textContent = phase === 'recording' ? 'Stop & send' : 'Record';
  ui['hands-free'].disabled = !handsFree && (!ready || !canHandsFree || !idle);
  ui['hands-free'].dataset.active = Boolean(handsFree?.setListening);
  ui['hands-free-label'].textContent = handsFree ? 'Stop hands-free' : 'Start hands-free';
  ui.cancel.hidden = !activeReply;
  ui.cancel.disabled = Boolean(activeReply?.stopReason);
  for (const button of sampleButtons) button.disabled = !ready || !idle;
  reflectPersona();
  syncHandsFree();
}

function activity(message, error = false) {
  ui.activity.textContent = message;
  ui.activity.dataset.error = error;
}

function hush(except) {
  playback.stop();
  for (const audio of ui.messages.querySelectorAll('audio')) if (audio !== except) audio.pause();
  audibleReply = undefined;
}

function playbackChanged() {
  if (playback.playing) return;
  audibleReply = undefined;
  if (handsFree?.listening && handsFree.speechStartedAt == null) {
    activity(activeReply ? 'Waiting for the local model…' : 'Listening. Speak, then pause to send.');
  }
}

function syncHandsFree() {
  const mode = handsFree;
  if (!mode?.setListening) return;
  const listening = phase === 'idle' && Boolean(client?.ready);
  if (mode.listening === listening) return;
  mode.listening = listening;
  mode.setListening(listening);
  if (listening && !activeReply) activity('Listening. Speak, then pause to send.');
}

function stopHandsFree() {
  if (!handsFree) return false;
  const { controller } = handsFree;
  handsFree = undefined;
  controller.abort();
  return client?.discardAudio();
}

function clearMessages() {
  hush();
  for (const audio of ui.messages.querySelectorAll('audio')) playback.disconnectReplay(audio);
  for (const url of playbackUrls) URL.revokeObjectURL(url);
  playbackUrls.clear();
  ui.messages.replaceChildren();
  ui.empty.hidden = false;
  ui.message.value = '';
}

async function newChat() {
  if (phase !== 'idle' || activeReply) return;
  client?.close();
  const persona = ui.persona.value.trim();
  const voice = ui.voice.value;
  clearMessages();
  await connect({ persona, voice });
}

async function connect({ persona = activePersona, voice = activeVoice, message, error = false } = {}) {
  phase = 'connecting';
  lastAnswer = undefined;
  if (handsFree) {
    handsFree.speechStartedAt = undefined;
    handsFree.audioChunks = undefined;
  }
  const next = new RealtimeSession(socketUrl, {
    onDisconnect(error) {
      if (client !== next) return;
      recording?.stop();
      stopHandsFree();
      hush();
      activity(error.message, true);
      render();
    },
  });
  client = next;
  render();
  activity('Opening a session with the local model…');
  try {
    await next.open(persona, voice);
    activePersona = persona;
    activeVoice = voice;
    try { localStorage.setItem(personaKey, activePersona); localStorage.setItem(voiceKey, activeVoice); } catch { /* Settings still work in memory. */ }
    const readyMessage = canRecord || canHandsFree ? 'Ready for text or voice.' : 'Ready for text. This browser does not offer microphone recording here.';
    activity(message ?? readyMessage, error);
  } catch (error) {
    stopHandsFree();
    activity(error.message, true);
  } finally {
    phase = 'idle';
    render();
  }
}

function addMessage(role, text) {
  const card = document.createElement('article');
  const speaker = document.createElement('span');
  const body = document.createElement('p');
  card.className = `message ${role}`;
  speaker.className = 'speaker';
  speaker.textContent = role === 'user' ? 'You' : 'Discobuddy';
  body.textContent = text;
  card.append(speaker, body);
  ui.empty.hidden = true;
  ui.messages.append(card);
  scrollToLatest();
  return { card, body };
}

function scrollToLatest() { ui.transcript.scrollTop = ui.transcript.scrollHeight; }
function atLatest() { return ui.transcript.scrollHeight - ui.transcript.scrollTop - ui.transcript.clientHeight < 70; }
function seconds(ms) { return `${(ms / 1000).toFixed(2)} s`; }

function setReplaySpeed(audio) {
  audio.defaultPlaybackRate = playback.speed;
  audio.playbackRate = playback.speed;
}

function finishReply(message, reply, speech) {
  const { card, body } = message;
  let fallback = reply.audio.length ? 'Voice reply' : 'The model returned an empty reply.';
  if (message.stopReason) fallback = `Reply ${message.stopReason.toLowerCase()}.`;
  body.textContent = reply.text.trim() || fallback;
  if (reply.audio.length) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.preservesPitch = true;
    audio.setAttribute('aria-label', 'Replay Discobuddy’s reply');
    audio.src = URL.createObjectURL(waveFile(reply.audio, reply.outputRate));
    setReplaySpeed(audio);
    playbackUrls.add(audio.src);
    audio.addEventListener('play', () => {
      if (handsFree?.setListening) playback.connectReplay(audio);
      hush(audio);
    });
    card.append(audio);
  }

  const metrics = document.createElement('small');
  metrics.className = 'metrics';
  metrics.textContent = [
    speech && `Speech ${seconds(speech.durationMs)}`,
    speech && `End pause ${seconds(speech.silenceMs)}`,
    reply.firstTextMs != null && `First text ${seconds(reply.firstTextMs)}`,
    reply.firstAudioMs != null && `First audio ${seconds(reply.firstAudioMs)}`,
    `Total ${seconds(reply.totalMs)}`,
    reply.audioSeconds > 0 && `Spoken length ${seconds(reply.audioSeconds * 1000)}`,
    message.retried && 'Model context reset',
    message.stopReason || (reply.status === 'cancelled' && 'Cancelled'),
    reply.status === 'incomplete' && 'Reply limit reached',
  ].filter(Boolean).join(' · ');
  message.metrics = metrics;
  card.append(metrics);
}

function cancelReply(reason) {
  if (reason === 'Interrupted' && playback.playing && audibleReply?.metrics && !audibleReply.stopReason) {
    audibleReply.stopReason = reason;
    audibleReply.metrics.append(' · Interrupted');
  }
  hush();
  if (activeReply && !activeReply.stopReason) {
    activeReply.stopReason = reason;
    client.cancel();
  }
}

async function sendTurn({ input, startedAt = performance.now(), speech }) {
  if (!client?.ready || activeReply) return;
  const typed = typeof input === 'string';
  const promptKey = typed ? replyKey(input) : undefined;
  const earlier = lastAnswer;
  const newPrompt = !typed || earlier?.promptKey !== promptKey;
  const avoidReply = earlier?.count >= 2 && newPrompt ? earlier.text : '';
  const inputSeconds = speech ? client.pendingAudioSeconds : typed ? 0 : input.length / (2 * client.inputRate);
  addMessage('user', typed ? input : `Voice message · ${seconds(inputSeconds * 1000)}`);
  const reply = addMessage('buddy', 'Thinking…');
  activeReply = reply;
  activity('Waiting for the local model…');
  render();
  try {
    const options = {
      startedAt,
      avoidReply,
      onText(text) {
        const follow = atLatest();
        reply.body.textContent = text;
        if (follow) scrollToLatest();
      },
      onAudio(bytes, rate) {
        if (ui.autoplay.checked && !reply.stopReason) {
          const starting = !playback.playing;
          playback.append(bytes, rate);
          if (playback.playing) {
            audibleReply = reply;
            if (starting && handsFree?.listening) activity('Discobuddy is speaking. Talk to interrupt.');
          }
        }
      },
    };
    const request = () => {
      reply.pending = speech ? client.finishAudio(options) : client.ask(input, options);
      return reply.pending;
    };
    let result = await request();
    if (result.repeated) {
      client.close();
      await connect({ message: 'Retrying your message in a fresh model session…' });
      if (!client?.ready) {
        reply.body.textContent = 'Could not restart the model for this reply.';
        return;
      }
      if (reply.stopReason) {
        reply.body.textContent = 'Reply cancelled.';
        activity('Reply cancelled. You can send another message.');
        return;
      }
      if (speech) {
        for (const pcm of speech.audioChunks) client.appendAudio(pcm, speech.rate);
      }
      reply.retried = true;
      result = await request();
      if (result.repeated) {
        lastAnswer = earlier;
        reply.body.textContent = 'The model still repeated its last reply after retrying.';
        activity('You can send a new message.', true);
        return;
      }
    }
    if (result.status !== 'cancelled') {
      const text = replyKey(result.text);
      const count = lastAnswer?.text === text && newPrompt ? lastAnswer.count + 1 : 1;
      lastAnswer = text.length >= MIN_REPEAT_CHARS ? { text, promptKey, count } : undefined;
    }
    playback.finish();
    if (playback.playing) audibleReply = reply;
    const follow = atLatest();
    finishReply(reply, result, speech);
    if (follow) scrollToLatest();
    if (result.speechError) {
      activity(result.speechError, true);
    } else if (handsFree?.speechStartedAt == null) {
      if (handsFree?.listening) {
        activity(playback.playing ? 'Discobuddy is speaking. Talk to interrupt.' : 'Listening. Speak, then pause to send.');
      } else {
        activity(result.status === 'cancelled' ? 'Reply cancelled. You can send another message.' : 'Ready for another turn.');
      }
    }
  } catch (error) {
    if (reply.body.textContent === 'Thinking…') reply.body.textContent = 'No reply received.';
    activity(error.message, true);
  } finally {
    activeReply = undefined;
    render();
    if (!handsFree && document.activeElement === document.body) (typed ? ui.message : ui.record).focus({ preventScroll: true });
  }
}

function microphoneError(error) {
  if (error.name === 'NotAllowedError') return 'Microphone access was denied. Allow it in your browser settings or type a message.';
  if (error.name === 'NotFoundError') return 'No microphone was found. Connect one or type a message.';
  return error.message;
}

async function submitHandsFreeTurn(mode, { at, silenceMs }) {
  const endedAt = at - silenceMs;
  const session = client;
  phase = 'submitting';
  render();
  try {
    await activeReply?.pending;
    if (handsFree !== mode || client !== session || !session.ready) return;
    const speech = {
      durationMs: endedAt - mode.speechStartedAt, silenceMs,
      audioChunks: mode.audioChunks, rate: playback.context.sampleRate,
    };
    mode.speechStartedAt = undefined;
    mode.audioChunks = undefined;
    phase = 'idle';
    void sendTurn({ startedAt: endedAt, speech });
  } catch {
    // The session's disconnect handler reports a failed previous reply.
  } finally {
    if (phase === 'submitting' && client === session) {
      phase = 'idle';
      render();
    }
  }
}

async function toggleHandsFree() {
  if (handsFree) {
    if (stopHandsFree()) {
      await connect({ message: 'Hands-free off. The unfinished turn was discarded and model context was reset.' });
    } else {
      if (phase === 'idle' || phase === 'submitting') activity('Hands-free off.');
      render();
    }
    return;
  }
  if (!client?.ready || phase !== 'idle' || activeReply || !canHandsFree) return;

  const mode = { controller: new AbortController() };
  handsFree = mode;
  hush();
  render();
  activity('Waiting for microphone permission…');
  const fail = (error) => {
    if (handsFree !== mode) return;
    const message = microphoneError(error);
    if (stopHandsFree()) {
      void connect({ message: `${message} The unfinished turn was discarded and model context was reset.`, error: true });
    } else {
      activity(message, true);
      render();
    }
  };
  try {
    await playback.unlock();
    if (mode.controller.signal.aborted) return;
    mode.setListening = await openHandsFree(playback.context, {
      signal: mode.controller.signal,
      maxSeconds: MAX_VOICE_SECONDS,
      playbackOutput: playback.output,
      onEvent(event) {
        if (handsFree !== mode || !mode.listening || phase !== 'idle') return;
        if (event.type === 'speech') {
          mode.speechStartedAt = event.at - event.onsetDelayMs;
          mode.audioChunks = [];
          cancelReply('Interrupted');
          render();
          activity('Hearing you. Pause to send.');
        }
        if (handsFree !== mode) return;
        try {
          if (event.pcm.length) {
            client.appendAudio(event.pcm, playback.context.sampleRate);
            mode.audioChunks.push(event.pcm);
          }
          if (event.type === 'turn') void submitHandsFreeTurn(mode, event);
        } catch (error) {
          fail(error);
        }
      },
      onError: fail,
    });
    if (handsFree === mode) render();
  } catch (error) {
    fail(error);
  }
}

function stopRecording() {
  if (phase !== 'recording') return;
  sendTime = performance.now();
  phase = 'encoding';
  render();
  activity('Preparing your voice message…');
  recording.stop();
}

async function beginRecording() {
  if (phase !== 'idle' || activeReply || handsFree || !client?.ready || !canRecord) return;
  phase = 'microphone';
  hush();
  render();
  activity('Waiting for microphone permission…');
  void playback.unlock().catch(() => {});
  try {
    recording = await recordMicrophone();
    if (!client.ready) {
      recording.stop();
      await recording.done;
      return;
    }
    sendTime = undefined;
    phase = 'recording';
    render();
    activity(`Recording. Speak now, then select Stop & send (${MAX_VOICE_SECONDS} seconds max).`);
    recordingTimer = setTimeout(stopRecording, MAX_VOICE_SECONDS * 1000);
    const blob = await recording.done;
    clearTimeout(recordingTimer);
    if (!client.ready) return;
    const pcm = await decodeRecording(blob, playback.context, client.inputRate, MAX_VOICE_SECONDS);
    await sendTurn({ input: pcm, startedAt: sendTime });
  } catch (error) {
    activity(microphoneError(error), true);
  } finally {
    clearTimeout(recordingTimer);
    recording = undefined;
    phase = 'idle';
    render();
  }
}

ui.preset.addEventListener('change', () => {
  if (Object.hasOwn(presets, ui.preset.value)) ui.persona.value = presets[ui.preset.value];
  if (ui.preset.value === 'custom') ui.persona.focus();
  else reflectPersona();
});
ui.persona.addEventListener('input', reflectPersona);
ui.voice.addEventListener('change', reflectPersona);
ui['new-chat'].addEventListener('click', newChat);
ui.message.addEventListener('input', render);
ui.message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!ui.send.disabled) ui['message-form'].requestSubmit();
  }
});
ui['message-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const input = ui.message.value.trim();
  if (!input || phase !== 'idle' || activeReply || handsFree?.speechStartedAt != null || !client?.ready) return;
  ui.message.value = '';
  hush();
  if (handsFree?.listening) handsFree.setListening(true);
  if (ui.autoplay.checked) void playback.unlock().catch(() => {});
  void sendTurn({ input });
});
ui.record.addEventListener('click', () => phase === 'recording' ? stopRecording() : void beginRecording());
ui['hands-free'].addEventListener('click', toggleHandsFree);
ui.cancel.addEventListener('click', () => {
  cancelReply('Cancelled');
  render();
  activity('Cancelling the reply…');
});
ui.autoplay.addEventListener('change', () => {
  if (!ui.autoplay.checked) hush();
  else void playback.unlock().catch(() => {});
});
ui['playback-speed'].addEventListener('change', () => {
  playback.setSpeed(Number(ui['playback-speed'].value));
  for (const audio of ui.messages.querySelectorAll('audio')) setReplaySpeed(audio);
  try { localStorage.setItem(playbackSpeedKey, String(playback.speed)); } catch { /* Playback still works in memory. */ }
});
for (const button of sampleButtons) {
  button.addEventListener('click', () => {
    ui.message.value = button.textContent;
    render();
    ui.message.focus();
  });
}
window.addEventListener('pagehide', () => { stopHandsFree(); recording?.stop(); client?.close(); clearMessages(); });
window.addEventListener('pageshow', ({ persisted }) => { if (persisted) { phase = 'idle'; void newChat(); } });
void newChat();
