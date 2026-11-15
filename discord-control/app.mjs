import { presets } from '/personas.mjs';

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'settings', 'preset', 'persona', 'voice', 'speed', 'save', 'settings-status',
  'gateway', 'model', 'voice-status', 'voice-error', 'channel', 'join', 'leave',
  'speech', 'prompt', 'preview', 'speak', 'activity', 'preview-audio',
].map((id) => [id, $(id)]));
let state;
let applied;
let channelKey;
let voiceAction;
let voiceRequestError = '';
let settingsError = '';
let saving = false;
let generating = false;
let previewUrl;
let requestNumber = 0;

async function api(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json()).error);
  return response;
}

function draft() {
  return { persona: ui.persona.value.trim(), voice: ui.voice.value, speed: Number(ui.speed.value) };
}

function same(a, b) { return a && b && a.persona === b.persona && a.voice === b.voice && a.speed === b.speed; }

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
  const dirty = !same(applied, draft());
  ui.save.disabled = !state || !dirty || saving;
  const settingsText = settingsError || (!applied ? 'Waiting for the panel.' : dirty ? 'Apply changes before testing a reply.' : 'Applied for the next reply.');
  if (ui['settings-status'].textContent !== settingsText) ui['settings-status'].textContent = settingsText;
  ui.preview.disabled = !state?.modelReady || dirty || generating || state.busy;
  ui.speak.disabled = ui.preview.disabled || !ready || state.playing || Boolean(voiceAction);
}

async function refresh() {
  const number = ++requestNumber;
  try {
    const updated = await (await api('status')).json();
    if (number !== requestNumber) return;
    state = updated;
    if (!applied || (!saving && !same(applied, state.settings))) {
      const first = !applied;
      const follow = first || same(applied, draft());
      applied = state.settings;
      if (follow) {
        ui.persona.value = applied.persona;
        ui.voice.value = applied.voice;
        ui.speed.value = applied.speed;
        selectPreset();
      }
      if (first) ui.activity.textContent = 'Generate a preview to try the current settings.';
    }
  } catch {
    if (number === requestNumber) state = undefined;
  } finally {
    if (number === requestNumber) render();
  }
}

function selectPreset() {
  ui.preset.value = Object.keys(presets).find((key) => presets[key] === ui.persona.value.trim()) ?? 'custom';
}

function settingsEdited() { settingsError = ''; render(); }
ui.preset.addEventListener('change', () => {
  if (Object.hasOwn(presets, ui.preset.value)) ui.persona.value = presets[ui.preset.value];
  else ui.persona.focus();
  settingsEdited();
});
ui.persona.addEventListener('input', () => { selectPreset(); settingsEdited(); });
for (const el of [ui.voice, ui.speed]) el.addEventListener('change', settingsEdited);
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
    const response = await api(action, { prompt: ui.prompt.value });
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
