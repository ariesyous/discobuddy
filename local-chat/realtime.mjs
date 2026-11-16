export const MAX_VOICE_SECONDS = 20;
export const VOICES = ['live', 'female', 'male'];

export function replyKey(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

export class RealtimeSession {
  #socket;
  #opening;
  #turn;
  #inputAudio;
  #wireInputRate;
  #closed = false;
  #ready = false;
  #voice = 'live';
  #released = false;

  constructor(url, { Socket = WebSocket, fetch: request, onDisconnect = () => {}, releaseBeforeSpeech = false } = {}) {
    this.url = url;
    this.Socket = Socket;
    this.request = request ?? globalThis.fetch.bind(globalThis);
    this.onDisconnect = onDisconnect;
    this.releaseBeforeSpeech = releaseBeforeSpeech;
  }

  get ready() { return this.#ready; }

  get pendingAudioSeconds() {
    const audio = this.#inputAudio;
    return audio ? audio.bytes / (2 * audio.rate) : 0;
  }

  async open(persona, voice = 'live') {
    if (this.#socket || this.#closed) throw new Error('Use a fresh session for a new chat.');
    if (!VOICES.includes(voice)) throw new Error('Choose one of the available voices.');
    this.#voice = voice;
    if (voice !== 'live') {
      let props;
      try {
        const response = await this.request(this.#httpUrl('/props'), { signal: AbortSignal.timeout(12_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        props = await response.json();
      } catch {
        throw new Error('Could not check the local speech voices. Restart DiscoBuddy and try again.');
      }
      if (!Array.isArray(props.voices) || !props.voices.includes(voice)) {
        throw new Error(`The local model does not support the ${voice} voice. Select another voice and start a new chat.`);
      }
      if (!Number.isInteger(props.total_slots) || props.total_slots < 2) {
        throw new Error('Selected voices need two model slots. Stop the server and restart it with scripts/chat-local.ps1.');
      }
      if (this.#closed) throw new Error('Chat closed.');
    }
    this.#socket = new this.Socket(this.url);
    this.#socket.addEventListener('message', ({ data }) => {
      if (this.#closed) return;
      try { this.#receive(JSON.parse(data), persona); }
      catch (error) { this.#disconnect(error); }
    });
    const lost = () => {
      if (!this.#released) this.#disconnect(new Error('Could not reach the local model. Check the Discobuddy terminal, then start a new chat.'));
    };
    this.#socket.addEventListener('error', lost);
    this.#socket.addEventListener('close', lost);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(lost, 12_000);
      this.#opening = { resolve, reject, timer };
    });
  }

  ask(input, options) {
    if (!this.#ready || this.#turn || this.#inputAudio) throw new Error('Wait for the current turn to finish.');
    if (typeof input !== 'string') {
      this.appendAudio(input);
      return this.finishAudio(options);
    }
    const text = input.trim();
    if (!text) throw new Error('Enter a message.');
    return this.#respond(() => this.#send({
      type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    }), options);
  }

  appendAudio(pcm, rate = this.inputRate) {
    if (!this.#ready || (this.#turn && !this.#turn.cancelRequested)) throw new Error('Wait for the current turn to finish.');
    const audio = this.#inputAudio ?? { rate, bytes: 0, chunks: [], sent: false };
    if (!Number.isInteger(rate) || rate < 8000 || rate > 192000 || audio.rate !== rate ||
        !(pcm instanceof Uint8Array) || !pcm.length || pcm.length % 2 || audio.bytes + pcm.length > rate * 2 * MAX_VOICE_SECONDS) {
      throw new Error('Record up to 20 seconds of valid PCM audio.');
    }

    this.#inputAudio = audio;
    audio.bytes += pcm.length;
    audio.chunks.push(pcm);
    // Keep the start of the next utterance while the cancelled reply drains.
    if (this.#turn) return;
    try { this.#flushAudio(); }
    catch (error) {
      this.#disconnect(error);
      throw error;
    }
  }

  finishAudio(options) {
    if (!this.#ready || this.#turn || !this.#inputAudio?.sent) throw new Error('Wait for the current turn to finish.');
    this.#inputAudio = undefined;
    return this.#respond(() => this.#send({ type: 'input_audio_buffer.commit' }), options);
  }

  discardAudio() {
    const audio = this.#inputAudio;
    this.#inputAudio = undefined;
    if (!audio?.sent) return false;
    // llama.cpp has already processed these samples. Only closing the session drops them.
    this.close();
    return true;
  }

  #flushAudio() {
    const audio = this.#inputAudio;
    if (!audio?.chunks.length) return;
    if (audio.rate !== this.#wireInputRate) {
      this.#send({ type: 'session.update', session: { audio: { input: { format: { rate: audio.rate } } } } });
      this.#wireInputRate = audio.rate;
    }

    const chunkSize = Math.floor(audio.rate * 0.08) * 2;
    for (const pcm of audio.chunks) {
      for (let offset = 0; offset < pcm.length; offset += chunkSize) {
        const bytes = pcm.subarray(offset, offset + chunkSize);
        this.#send({ type: 'input_audio_buffer.append', audio: btoa(String.fromCharCode(...bytes)) });
      }
    }
    audio.chunks.length = 0;
    audio.sent = true;
  }

  #respond(prepare, { onText, onAudio, startedAt = performance.now(), avoidReply = '' } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#disconnect(new Error('The local model took too long. Start a new chat to try again.')), 120_000);
      this.#turn = {
        resolve, reject, timer, onText, onAudio, startedAt, text: '', audio: [], bytes: 0,
        speechText: '', speechQueue: Promise.resolve(), speechAbort: new AbortController(), textDone: false,
        checkingReply: replyKey(avoidReply), repeated: false,
      };
      try {
        prepare();
        this.#send({ type: 'response.create' });
      } catch (error) {
        this.#disconnect(error);
      }
    });
  }

  cancel() {
    const turn = this.#turn;
    if (!turn || turn.cancelRequested) return;
    turn.cancelRequested = true;
    turn.speechAbort.abort();
    if (turn.textDone || !this.#ready) return;
    try { this.#send({ type: 'response.cancel' }); }
    catch (error) { this.#disconnect(error); }
  }

  close() {
    this.#disconnect(new Error('Chat closed.'), false);
  }

  #send(event) {
    if (this.#socket.readyState !== 1) throw new Error('The local model disconnected.');
    this.#socket.send(JSON.stringify(event));
  }

  #httpUrl(path) {
    const url = new URL(this.url);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = path;
    url.search = '';
    return url;
  }

  #deliverText(turn, delta) {
    if (!delta) return;
    turn.firstTextMs ??= performance.now() - turn.startedAt;
    turn.onText?.(turn.text);
    if (this.#voice === 'live') return;

    turn.speechText += delta;
    if (this.releaseBeforeSpeech) return;
    this.#queueSentences(turn);
  }

  #queueSentences(turn) {
    let boundary;
    while ((boundary = /[.!?]["'”’\)\]]*\s+|\n+/u.exec(turn.speechText))) {
      const end = boundary.index + boundary[0].length;
      this.#queueSpeech(turn, turn.speechText.slice(0, end));
      turn.speechText = turn.speechText.slice(end);
    }
  }

  #deliverAudio(turn, bytes) {
    turn.firstAudioMs ??= performance.now() - turn.startedAt;
    turn.onAudio?.(bytes, this.outputRate);
  }

  #releaseReply(turn) {
    turn.checkingReply = '';
    this.#deliverText(turn, turn.text);
    for (const bytes of turn.audio) {
      if (turn.cancelRequested) break;
      this.#deliverAudio(turn, bytes);
    }
  }

  #queueSpeech(turn, text) {
    const input = text.trim();
    if (!input) return;
    turn.speechQueue = turn.speechQueue.then(async () => {
      if (turn.cancelRequested || turn.speechError || this.#turn !== turn) return;
      await this.#speak(turn, input);
    }).catch((error) => {
      if (!turn.cancelRequested && this.#turn === turn) {
        turn.speechError = error.message || 'Could not generate speech.';
        turn.speechAbort.abort();
      }
    });
  }

  async #speak(turn, input) {
    const response = await this.request(this.#httpUrl('/v1/audio/speech'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, voice: this.#voice, response_format: 'pcm', stream_format: 'audio' }),
      signal: turn.speechAbort.signal,
    });
    if (!response.ok) throw new Error(`Could not generate speech (HTTP ${response.status}).`);
    const contentType = response.headers.get('content-type') || '';
    const rate = Number(/(?:^|;)\s*rate\s*=\s*(\d+)/i.exec(contentType)?.[1]);
    if (!/^audio\/pcm(?:;|$)/i.test(contentType) || rate !== this.outputRate ||
        !/(?:^|;)\s*encoding\s*=\s*signed-int(?:;|$)/i.test(contentType) ||
        !/(?:^|;)\s*bits\s*=\s*16(?:;|$)/i.test(contentType) || !response.body) {
      throw new Error('The speech server returned an unsupported audio format.');
    }
    const reader = response.body.getReader();
    let trailing;
    let received = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || turn.cancelRequested || this.#turn !== turn) break;
        if (!value?.length) continue;
        let bytes = value;
        if (trailing !== undefined) {
          bytes = new Uint8Array(value.length + 1);
          bytes[0] = trailing;
          bytes.set(value, 1);
          trailing = undefined;
        }
        if (bytes.length % 2) {
          trailing = bytes[bytes.length - 1];
          bytes = bytes.subarray(0, bytes.length - 1);
        }
        if (!bytes.length) continue;
        turn.bytes += bytes.length;
        if (turn.bytes > this.outputRate * 2 * 45) throw new Error('The model returned an oversized audio reply.');
        received = true;
        turn.audio.push(bytes);
        this.#deliverAudio(turn, bytes);
      }
      if (!turn.cancelRequested && (trailing !== undefined || !received)) {
        throw new Error('The speech server returned incomplete audio.');
      }
    } finally {
      reader.releaseLock();
    }
  }

  #finish(turn, status) {
    turn.speechQueue.then(() => {
      if (this.#turn !== turn) return;
      this.#turn = undefined;
      clearTimeout(turn.timer);
      const held = Boolean(turn.checkingReply);
      turn.resolve({
        text: held ? '' : turn.text, audio: held ? [] : turn.audio, outputRate: this.outputRate,
        audioSeconds: held ? 0 : turn.bytes / (2 * this.outputRate),
        firstTextMs: turn.firstTextMs, firstAudioMs: turn.firstAudioMs,
        totalMs: performance.now() - turn.startedAt,
        status: turn.cancelRequested ? 'cancelled' : status,
        speechError: turn.speechError,
        repeated: turn.repeated,
      });
      // Resume a queued microphone turn after both generation and TTS have settled.
      try { this.#flushAudio(); }
      catch (error) { this.#disconnect(error); }
    });
  }

  #disconnect(error, notify = true) {
    if (this.#closed) return;
    const wasReady = this.#ready;
    this.#closed = true;
    this.#ready = false;
    for (const pending of [this.#opening, this.#turn]) {
      if (pending) {
        clearTimeout(pending.timer);
        pending.speechAbort?.abort();
        pending.reject(error);
      }
    }
    this.#opening = this.#turn = this.#inputAudio = undefined;
    this.#socket?.close();
    if (wasReady && notify) this.onDisconnect(error);
  }

  #receive(event, persona) {
    if (event.type === 'error') throw new Error(event.error?.message || 'The local model returned an error.');
    if (event.type === 'session.created' && this.#opening) {
      const rate = (side) => event.session?.audio?.[side]?.format?.rate;
      this.inputRate = rate('input');
      this.outputRate = rate('output');
      if (![this.inputRate, this.outputRate].every((value) => Number.isInteger(value) && value >= 8000 && value <= 192000)) {
        throw new Error('This server did not report speech input and output rates. Check that llama.cpp loaded LFM3-Audio and its projector.');
      }
      this.#wireInputRate = this.inputRate;
      this.#send({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: `Respond with interleaved text and audio.\n\n${persona.trim()}`,
          output_modalities: ['text', 'audio'],
          max_output_tokens: 384,
        },
      });
      return;
    }
    if (event.type === 'session.updated' && this.#opening) {
      const opening = this.#opening;
      this.#opening = undefined;
      clearTimeout(opening.timer);
      this.#ready = true;
      opening.resolve();
      return;
    }

    const turn = this.#turn;
    if (!turn) return;
    if (event.type === 'response.done') {
      turn.textDone = true;
      if (turn.checkingReply && !turn.cancelRequested) {
        turn.repeated = replyKey(turn.text) === turn.checkingReply;
        if (!turn.repeated) this.#releaseReply(turn);
      }
      if (this.#voice !== 'live' && !turn.cancelRequested && !turn.repeated) {
        if (this.releaseBeforeSpeech) {
          // Discord buffers the whole reply, so free its model slot before using TTS.
          this.#released = true;
          this.#ready = false;
          this.#socket.close();
          this.#queueSentences(turn);
        }
        this.#queueSpeech(turn, turn.speechText);
      }
      turn.speechText = '';
      this.#finish(turn, event.response?.status);
    } else if (turn.cancelRequested) {
      // Drain the cancelled response before admitting another turn on the same socket.
      return;
    } else if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      turn.text += event.delta;
      if (!turn.checkingReply) {
        this.#deliverText(turn, event.delta);
      } else if (!turn.checkingReply.startsWith(replyKey(turn.text))) {
        this.#releaseReply(turn);
      }
    } else if (this.#voice === 'live' && event.type === 'response.output_audio.delta' && event.delta) {
      const bytes = Uint8Array.from(atob(event.delta), (char) => char.charCodeAt(0));
      turn.bytes += bytes.length;
      if (bytes.length % 2 || turn.bytes > this.outputRate * 2 * 45) throw new Error('The model returned an invalid or oversized audio reply.');
      turn.audio.push(bytes);
      if (!turn.checkingReply) this.#deliverAudio(turn, bytes);
    }
  }
}
