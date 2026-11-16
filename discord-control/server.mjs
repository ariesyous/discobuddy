import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { presets } from '../local-chat/personas.mjs';
import { VOICES } from '../local-chat/realtime.mjs';
import { countPromptTokens, generateReply, previewWave, transcribeAudio } from './audio.mjs';
import { loadPrompt, savePrompt } from './prompt-settings.mjs';
import {
  addressedRequest, defaultConversation, interruptionModes, isStopRequest, MAX_PROMPT_FIELD, PROMPT_TOKEN_BUDGET, replyModes, requiresAddress,
} from './conversation.mjs';

const host = '127.0.0.1';
const speeds = [0.75, 1, 1.15, 1.25, 1.5, 1.75, 2];
const assets = new Map([
  ['/', ['./index.html', 'text/html']],
  ['/panel.css', ['./panel.css', 'text/css']],
  ['/app.mjs', ['./app.mjs', 'text/javascript']],
  ['/conversation.mjs', ['./conversation.mjs', 'text/javascript']],
  ['/style.css', ['../local-chat/style.css', 'text/css']],
  ['/personas.mjs', ['../local-chat/personas.mjs', 'text/javascript']],
]);
const offline = { gateway: 'token needed', bot: '', channels: [], voice: 'idle', channelId: null, playing: false, voiceError: '' };
const modelError = 'Could not generate speech. Check the local model and try again. If Voice Lab is using the model, let its reply finish or close the tab.';

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(req) {
  if (req.headers['content-type'] !== 'application/json') throw new RequestError(415, 'Expected JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 200_000) {
      req.resume();
      throw new RequestError(413, 'Request is too large.');
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { /* Return a clean validation error. */ }
  throw new RequestError(400, 'Expected a JSON object.');
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
}

function validPrompt({ persona, guidelines }) {
  return typeof persona === 'string' && persona.length <= MAX_PROMPT_FIELD &&
    typeof guidelines === 'string' && guidelines.length <= MAX_PROMPT_FIELD;
}

function validateSettings(body, current) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, 'Choose valid conversation settings.');
  }
  const {
    persona, voice, speed, replyMode = current.replyMode,
    interruptions = current.interruptions, guidelines = current.guidelines,
  } = body;
  if (!validPrompt({ persona, guidelines })) {
    throw new RequestError(400, 'Limit persona and guidelines to 12,000 characters each.');
  }
  if (!VOICES.includes(voice) || !speeds.includes(speed) ||
      !replyModes.includes(replyMode) || !interruptionModes.includes(interruptions)) {
    throw new RequestError(400, 'Choose supported voice and conversation settings.');
  }
  return { persona: persona.trim(), voice, speed, replyMode, interruptions, guidelines: guidelines.trim() };
}

export async function createControlServer({
  modelPort = 8765, token = '', synthesize = generateReply, transcribe = transcribeAudio, makeBot,
  countTokens = countPromptTokens,
  settingsPath = fileURLToPath(new URL('../.local-runtime/discord-prompt.json', import.meta.url)),
} = {}) {
  let settings = { persona: presets.buddy, voice: 'live', speed: 1, ...defaultConversation, ...await loadPrompt(settingsPath) };
  let settingsWrites = Promise.resolve();
  let job;
  let joining = false;
  let bot;
  let listenError = '';
  const cancelBroadcast = () => { if (job?.broadcast) job.controller.abort(); };
  const cancelSpoken = () => {
    if (job?.speaker) job.controller.abort();
    listenError = '';
  };

  async function runReply(input, { broadcast, speaker = null, controller, nameRequired = false, overlap, draftSettings }) {
    const applied = draftSettings ?? settings;
    const { signal } = controller;
    job = { broadcast, speaker, controller, checkingSpeech: nameRequired || Boolean(overlap) };
    try {
      if (job.checkingSpeech) {
        let transcript;
        try { transcript = await transcribe(modelPort, input, signal); }
        catch {
          if (signal.aborted) signal.throwIfAborted();
          throw new RequestError(503, 'Could not check who was being addressed. Try again when the local model is available.');
        }
        signal.throwIfAborted();
        const called = addressedRequest(transcript);
        if (nameRequired && called === null) return;
        if (overlap?.mode === 'addressed') overlap.stop();
        const text = called ?? transcript.trim();
        if (!text || isStopRequest(text)) return;
        input = { text, speaker };
        job.checkingSpeech = false;
      }
      const reply = await synthesize(modelPort, input, applied, signal);
      if (signal.aborted) throw new RequestError(409, 'The reply was cancelled.');
      if (broadcast) {
        try { bot.play(reply, speaker); }
        catch (error) { throw new RequestError(409, error.message); }
      }
      return reply;
    } finally {
      job = undefined;
    }
  }

  function onUtterance(input, overlap) {
    if (job) return;
    const status = bot.status();
    if (status.voice !== 'ready' || (status.playing && !overlap) || !status.listening) return;
    const nameRequired = requiresAddress(settings.replyMode, status.people) || overlap?.mode === 'addressed';
    const controller = new AbortController();
    listenError = '';
    void runReply(input, { broadcast: true, speaker: input.speaker, controller, nameRequired, overlap }).catch((error) => {
      if (!controller.signal.aborted) listenError = error instanceof RequestError ? error.message : modelError;
    });
  }

  if (token) {
    const factory = makeBot ?? (await import('./discord.mjs')).createDiscordBot;
    bot = factory(token, cancelBroadcast, {
      onUtterance, onListeningStopped: cancelSpoken, isBusy: () => Boolean(job),
      interruptionMode: () => settings.interruptions,
    });
  }
  const voiceStatus = () => bot?.status() ?? offline;
  const modelReady = () => fetch(`http://${host}:${modelPort}/health`, { signal: AbortSignal.timeout(1500) })
    .then(async (response) => response.ok && (await response.json()).status === 'ok').catch(() => false);

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; media-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const authority = `${host}:${server.address()?.port}`;
    const path = req.url;
    try {
      if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== `http://${authority}`)) {
        throw new RequestError(403, 'Open this panel on 127.0.0.1.');
      }
      if (req.method === 'GET') {
        if (path === '/api/status') {
          const ready = await modelReady();
          const status = voiceStatus();
          return json(res, 200, {
            ...status, modelReady: ready, busy: Boolean(job), checkingSpeech: Boolean(job?.checkingSpeech),
            responding: Boolean(job?.speaker && !job.checkingSpeech),
            speaker: status.speaker ?? job?.speaker ?? null, listenError, settings,
          });
        }
        const asset = assets.get(path);
        if (asset) {
          const [file, type] = asset;
          const content = await readFile(new URL(file, import.meta.url));
          return res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }).end(content);
        }
      } else if (req.method === 'POST') {
        if (req.headers.origin !== `http://${authority}`) throw new RequestError(403, 'Use the local panel to change settings or voice.');
        const body = await readJson(req);
        if (path === '/api/settings') {
          const next = validateSettings(body, settings);
          settingsWrites = settingsWrites.catch(() => {}).then(async () => {
            await savePrompt(settingsPath, next);
            settings = next;
          });
          await settingsWrites;
          return json(res, 200, settings);
        }
        if (path === '/api/prompt-tokens') {
          if (!validPrompt(body)) throw new RequestError(400, 'Limit persona and guidelines to 12,000 characters each.');
          try {
            const count = await countTokens(modelPort, { persona: body.persona.trim(), guidelines: body.guidelines.trim() });
            if (!Number.isInteger(count) || count < 0) throw new Error('Invalid token count.');
            return json(res, 200, { count, budget: PROMPT_TOKEN_BUDGET });
          } catch {
            throw new RequestError(503, 'Could not count prompt tokens. Start the local model and try again.');
          }
        }
        if (path === '/api/leave') {
          bot?.leave();
          return json(res, 200, { ok: true });
        }
        if (path === '/api/listen') {
          if (!bot) throw new RequestError(409, 'Set a bot token and restart the panel first.');
          if (typeof body.enabled !== 'boolean') throw new RequestError(400, 'Choose whether to enable listening.');
          try { bot.setListening(body.enabled); }
          catch (error) { throw new RequestError(409, error.message); }
          return json(res, 200, { ok: true });
        }
        if (path === '/api/join') {
          if (!bot) throw new RequestError(409, 'Set a bot token and restart the panel first.');
          if (joining) throw new RequestError(409, 'A voice join is already in progress.');
          if (typeof body.channelId !== 'string' || !/^\d{17,20}$/.test(body.channelId)) {
            throw new RequestError(400, 'Choose a voice channel.');
          }
          if (body.listening !== undefined && typeof body.listening !== 'boolean') {
            throw new RequestError(400, 'Choose whether to listen on join.');
          }
          joining = true;
          try { await bot.join(body.channelId, { listening: body.listening }); }
          catch (error) { throw new RequestError(409, error.message); }
          finally { joining = false; }
          return json(res, 200, { ok: true });
        }
        if (path === '/api/preview' || path === '/api/speak') {
          const broadcast = path === '/api/speak';
          const draftSettings = !broadcast && body.settings !== undefined
            ? validateSettings(body.settings, settings) : undefined;
          const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
          if (!prompt || prompt.length > 600) throw new RequestError(400, 'Enter a prompt of up to 600 characters.');
          const status = voiceStatus();
          if (job || status.capturing) throw new RequestError(409, 'Wait for the current turn to finish.');
          if (broadcast && (status.voice !== 'ready' || status.playing)) {
            throw new RequestError(409, 'Join a voice channel and wait for any playback to finish.');
          }
          const controller = new AbortController();
          const cancel = () => controller.abort();
          res.once('close', cancel);
          try {
            const reply = await runReply(prompt, { broadcast, controller, draftSettings });
            if (broadcast) return json(res, 200, { ok: true });
            const wav = Buffer.from(await previewWave(reply));
            return res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length }).end(wav);
          } catch (error) {
            if (error instanceof RequestError) throw error;
            if (controller.signal.aborted) throw new RequestError(409, 'The reply was cancelled.');
            throw new RequestError(503, modelError);
          } finally {
            res.off('close', cancel);
          }
        }
      }
      throw new RequestError(404, 'Page not found.');
    } catch (error) {
      if (!res.destroyed) json(res, error.status ?? 500, { error: error.status ? error.message : 'The control panel could not complete the request.' });
    }
  });
  server.once('listening', () => bot?.start());
  server.once('close', () => {
    job?.controller.abort();
    void bot?.close();
  });
  return server;
}

function port(key, fallback) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${key} must be a port from 1024 to 65535.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const panelPort = port('DISCOBUDDY_DISCORD_PORT', 8767);
  const modelPort = port('DISCOBUDDY_MODEL_PORT', 8765);
  if (panelPort === modelPort) throw new Error('Choose different ports for the panel and the model.');
  const server = await createControlServer({ modelPort, token: process.env.DISCORD_BOT_TOKEN?.trim() });
  server.once('error', (error) => {
    console.error(`Could not start the local Discord panel: ${error.code ?? 'server error'}.`);
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
  server.listen(panelPort, host, () => console.log(`Discord Voice Control: http://${host}:${panelPort}/`));
}
