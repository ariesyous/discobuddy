import { presets } from '/personas.mjs';
import { defaultConversation, requiresAddress } from '/conversation.mjs';

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'settings', 'preset', 'persona', 'voice', 'speed', 'save', 'settings-status',
  'reply-mode', 'interruptions', 'guidelines', 'reset-guidelines', 'prompt-count', 'turn-hint',
  'gateway', 'model', 'voice-status', 'voice-error', 'channel', 'join', 'leave',
  'listen', 'listen-status', 'listen-error',
  'speech', 'prompt', 'preview', 'speak', 'activity', 'preview-audio',
].map((id) => [id, $(id)]));
let state;
let applied;
let channelKey;
let voiceAction;
let voiceRequestError = '';
let listenPending = false;
let listenRequestError = '';
let settingsError = '';
let saving = false;
let generating = false;
let previewUrl;
let tokenRequestNumber = 0;
let tokenTimer;
let requestNumber = 0;

async function api(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json()).error);
  return response;
}

function draft() {
  return {
    persona: ui.persona.value.trim(), voice: ui.voice.value, speed: Number(ui.speed.value),
    replyMode: ui['reply-mode'].value, interruptions: ui.interruptions.value, guidelines: ui.guidelines.value.trim(),
  };
}

function same(a, b) { return a && b && Object.keys(a).every((key) => a[key] === b[key]); }

function status(element, text, style) {
  if (element.textContent !== text) element.textContent = text;
  element.dataset.state = style;
}

function render() {
  const online = state?.gateway === 'online';
  const ready = state?.voice === 'ready';
  const channels = state?.channels ?? [];
  const gatewayText = {
    online: `Bot online · ${state?.bot}`, 'token needed': 'Bot token needed',
    'login failed': 'Bot login failed', reconnecting: 'Bot reconnecting', connecting: 'Bot connecting',
  };
  status(ui.gateway, gatewayText[state?.gateway] ?? 'Panel offline', online ? 'ready' : 'offline');
  status(ui.model, state?.modelReady ? 'Local model ready' : 'Local model unavailable', state?.modelReady ? 'ready' : 'offline');
  const key = JSON.stringify(channels);
  if (key !== channelKey) {
    const selected = ui.channel.value;
    ui.channel.replaceChildren(new Option(channels.length ? 'Choose a voice channel' : 'No channels available', ''));
    for (const channel of channels) ui.channel.add(new Option(`${channel.guild} · ${channel.name}`, channel.id));
    ui.channel.value = channels.some(({ id }) => id === selected) ? selected : (state?.channelId ?? '');
    channelKey = key;
  }
  const target = channels.find(({ id }) => id === state?.channelId);
  const label = target ? `${target.guild} · ${target.name}` : 'voice channel';
  const hints = {
    'token needed': 'Set DISCORD_BOT_TOKEN in .env.discord or the environment, then restart this panel.',
    'login failed': 'Check the bot token and internet connection, then restart this panel.',
  };
  const voiceText = ready ? `${state.playing ? 'Speaking in' : 'Joined'} ${label}.`
    : state?.channelId || voiceAction?.name === 'join' ? `Connecting to ${label}…`
    : hints[state?.gateway] ?? (online && !channels.length
      ? 'No eligible channels. Invite the bot to a server and check its voice permissions.'
      : 'No voice channel joined.');
  if (ui['voice-status'].textContent !== voiceText) ui['voice-status'].textContent = voiceText;
  ui.channel.disabled = !online || !channels.length || Boolean(voiceAction);
  ui.join.disabled = ui.channel.disabled || !ui.channel.value || (ready && ui.channel.value === state.channelId);
  ui.leave.disabled = (!state?.channelId && voiceAction?.name !== 'join') || voiceAction?.name === 'leave';
  const voiceError = voiceRequestError || (!voiceAction && state?.voiceError) || '';
  ui['voice-error'].hidden = !voiceError;
  if (ui['voice-error'].textContent !== voiceError) ui['voice-error'].textContent = voiceError;
  renderListening(ready);
  const dirty = !same(applied, draft());
  ui.save.disabled = !state || !dirty || saving;
  const settingsText = settingsError || (!applied ? 'Waiting for the panel.' : dirty ? 'Preview this draft, or apply it for Discord replies.' : 'Applied for the next reply.');
  if (ui['settings-status'].textContent !== settingsText) ui['settings-status'].textContent = settingsText;
  ui.preview.disabled = !state?.modelReady || generating || state.busy || state.capturing;
  ui.speak.disabled = ui.preview.disabled || dirty || !ready || state.playing || Boolean(voiceAction);
}

function renderListening(ready) {
  const listening = Boolean(state?.listening);
  ui.listen.textContent = listening ? 'Stop listening' : 'Start listening';
  ui.listen.disabled = listenPending || (!listening && (!ready || Boolean(voiceAction)));

  const speaker = state?.speaker;
  const name = speaker && (speaker.name === speaker.username ? speaker.name : `${speaker.name} (@${speaker.username})`);
  const conversation = state?.settings ?? defaultConversation;
  const callNeeded = requiresAddress(conversation.replyMode, state?.people);
  const turnHint = callNeeded ? 'Start the turn with “DiscoBuddy,” ask your question, then pause.' : 'Speak in Discord, then pause for a reply.';
  const interruptionHint = {
    addressed: 'Say “DiscoBuddy, stop” and pause to cut in.',
    any: 'Speak over DiscoBuddy to cut in.',
    finish: 'Wait for its reply to finish before speaking.',
  };
  const hint = `${turnHint} ${interruptionHint[conversation.interruptions]}`;
  if (ui['turn-hint'].textContent !== hint) ui['turn-hint'].textContent = hint;
  let text = 'Listening is off.';
  if (listening) {
    if (state.capturing) text = `Hearing ${name}…`;
    else if (state.checkingSpeech) text = 'Checking the spoken turn…';
    else if (state.responding) text = `Generating a reply to ${name}…`;
    else if (state.playing) text = name ? `Replying to ${name}.` : 'Discobuddy is speaking.';
    else if (!ready) text = 'Waiting for the voice connection…';
    else text = callNeeded ? 'Waiting to be called by name.' : 'Listening to the voice channel.';
  }
  if (ui['listen-status'].textContent !== text) ui['listen-status'].textContent = text;
  const error = listenRequestError || state?.listenError || '';
  ui['listen-error'].hidden = !error;
  if (ui['listen-error'].textContent !== error) ui['listen-error'].textContent = error;
}

async function refresh() {
  const number = ++requestNumber;
  try {
    const updated = await (await api('status')).json();
    if (number !== requestNumber) return;
    const modelChanged = Boolean(state?.modelReady) !== Boolean(updated.modelReady);
    state = updated;
    let countChanged = modelChanged;
    if (!applied || (!saving && !same(applied, state.settings))) {
      const first = !applied;
      const follow = first || same(applied, draft());
      applied = state.settings;
      if (follow) {
        ui.persona.value = applied.persona;
        ui.voice.value = applied.voice;
        ui.speed.value = applied.speed;
        ui['reply-mode'].value = applied.replyMode;
        ui.interruptions.value = applied.interruptions;
        ui.guidelines.value = applied.guidelines;
        selectPreset();
        countChanged = true;
      }
      if (first) ui.activity.textContent = 'Generate a preview to try the current settings.';
    }
    if (countChanged) schedulePromptCount();
  } catch {
    if (number === requestNumber) { state = undefined; schedulePromptCount(); }
  } finally {
    if (number === requestNumber) render();
  }
}

function selectPreset() {
  ui.preset.value = Object.keys(presets).find((key) => presets[key] === ui.persona.value.trim()) ?? 'custom';
}

function schedulePromptCount() {
  const number = ++tokenRequestNumber;
  clearTimeout(tokenTimer);
  if (!state?.modelReady) {
    ui['prompt-count'].textContent = 'Start the local model to count prompt tokens.';
    ui['prompt-count'].dataset.error = 'false';
    return;
  }
  ui['prompt-count'].textContent = 'Counting prompt tokens…';
  tokenTimer = setTimeout(async () => {
    try {
      const { count, budget } = await (await api('prompt-tokens', {
        persona: ui.persona.value.trim(), guidelines: ui.guidelines.value.trim(),
      })).json();
      if (number !== tokenRequestNumber) return;
      ui['prompt-count'].dataset.error = String(count > budget);
      ui['prompt-count'].textContent = count > budget
        ? `${count.toLocaleString()} prompt tokens: above the ${budget.toLocaleString()}-token target. Shorten the draft to leave room for speech, the reply, and formatting.`
        : `${count.toLocaleString()} / ${budget.toLocaleString()} suggested prompt tokens. The rest of the 4,096-token session is shared by speech, reply, speaker details, and formatting.`;
    } catch {
      if (number === tokenRequestNumber) ui['prompt-count'].textContent = 'Token count unavailable. Check the local model.';
    }
  }, 400);
}

function settingsEdited() { settingsError = ''; schedulePromptCount(); render(); }
ui.preset.addEventListener('change', () => {
  if (Object.hasOwn(presets, ui.preset.value)) ui.persona.value = presets[ui.preset.value];
  else ui.persona.focus();
  settingsEdited();
});
ui.persona.addEventListener('input', () => { selectPreset(); settingsEdited(); });
for (const el of [ui.voice, ui.speed, ui['reply-mode'], ui.interruptions]) el.addEventListener('change', settingsEdited);
ui.guidelines.addEventListener('input', settingsEdited);
ui['reset-guidelines'].addEventListener('click', () => {
  ui.guidelines.value = defaultConversation.guidelines;
  settingsEdited();
});
ui.channel.addEventListener('change', () => { voiceRequestError = ''; render(); });

ui.settings.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (ui.save.disabled) return;
  saving = true;
  settingsError = '';
  ++requestNumber;
  render();
  try { applied = await (await api('settings', draft())).json(); }
  catch (error) { settingsError = error.message; }
  finally {
    ++requestNumber;
    saving = false;
    render();
  }
});

async function changeVoice(name) {
  const operation = { name };
  voiceAction = operation;
  voiceRequestError = '';
  listenRequestError = '';
  render();
  try { await api(name, name === 'join' ? { channelId: ui.channel.value } : {}); }
  catch (error) { if (voiceAction === operation) voiceRequestError = error.message; }
  finally {
    if (voiceAction === operation) {
      voiceAction = undefined;
      await refresh();
    }
  }
}
ui.join.addEventListener('click', () => void changeVoice('join'));
ui.leave.addEventListener('click', () => void changeVoice('leave'));
ui.listen.addEventListener('click', async () => {
  listenPending = true;
  listenRequestError = '';
  render();
  try { await api('listen', { enabled: !state.listening }); }
  catch (error) { listenRequestError = error.message; }
  finally {
    listenPending = false;
    await refresh();
  }
});

ui.speech.addEventListener('submit', async (event) => {
  event.preventDefault();
  const action = event.submitter?.value ?? 'preview';
  if (ui[action].disabled) return;
  generating = true;
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
    ui['preview-audio'].removeAttribute('src');
    ui['preview-audio'].load();
    ui['preview-audio'].hidden = true;
  }
  ui.activity.dataset.error = 'false';
  ui.activity.textContent = 'Generating speech on this PC…';
  render();
  try {
    const response = await api(action, action === 'preview'
      ? { prompt: ui.prompt.value, settings: draft() } : { prompt: ui.prompt.value });
    if (action === 'preview') {
      previewUrl = URL.createObjectURL(await response.blob());
      ui['preview-audio'].src = previewUrl;
      ui['preview-audio'].hidden = false;
      ui.activity.textContent = 'Preview ready. Press play to listen.';
    } else {
      ui.activity.textContent = 'Reply sent to the joined voice channel.';
    }
  } catch (error) {
    ui.activity.dataset.error = 'true';
    ui.activity.textContent = error.message;
  } finally {
    await refresh();
    generating = false;
    render();
  }
});

async function poll() {
  await refresh();
  setTimeout(poll, 2000);
}
void poll();
