export const MAX_VOICE_SECONDS = 20;

export class RealtimeSession {
  #socket;
  #opening;
  #turn;
  #closed = false;
  #ready = false;

  constructor(url, { Socket = WebSocket, onDisconnect = () => {} } = {}) {
    this.url = url;
    this.Socket = Socket;
    this.onDisconnect = onDisconnect;
  }

  get ready() { return this.#ready; }

  open(persona) {
    if (this.#socket || this.#closed) throw new Error('Use a fresh session for a new chat.');
    this.#socket = new this.Socket(this.url);
    this.#socket.addEventListener('message', ({ data }) => {
      if (this.#closed) return;
      try { this.#receive(JSON.parse(data), persona); }
      catch (error) { this.#disconnect(error); }
    });
    const lost = () => this.#disconnect(new Error('Could not reach the local model. Check the Discobuddy terminal, then start a new chat.'));
    this.#socket.addEventListener('error', lost);
    this.#socket.addEventListener('close', lost);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(lost, 12_000);
      this.#opening = { resolve, reject, timer };
    });
  }

  ask(input, { onText, onAudio, startedAt = performance.now() } = {}) {
    if (!this.#ready || this.#turn) throw new Error('Wait for the local model to be ready.');
    const typed = typeof input === 'string';
    if (typed ? !input.trim() : !(input instanceof Uint8Array) || !input.length || input.length % 2 || input.length > this.inputRate * 2 * MAX_VOICE_SECONDS) {
      throw new Error('Enter a message or record up to 20 seconds of audio.');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#disconnect(new Error('The local model took too long. Start a new chat to try again.')), 120_000);
      this.#turn = { resolve, reject, timer, onText, onAudio, startedAt, text: '', audio: [], bytes: 0 };
      try {
        if (typed) {
          this.#send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: input.trim() }] } });
        } else {
          const chunkSize = Math.floor(this.inputRate * 0.08) * 2;
          for (let offset = 0; offset < input.length; offset += chunkSize) {
            const bytes = input.subarray(offset, offset + chunkSize);
            this.#send({ type: 'input_audio_buffer.append', audio: btoa(String.fromCharCode(...bytes)) });
          }
          this.#send({ type: 'input_audio_buffer.commit' });
        }
        this.#send({ type: 'response.create' });
      } catch (error) {
        this.#disconnect(error);
      }
    });
  }

  cancel() {
    const turn = this.#turn;
    if (!turn || !this.#ready || turn.cancelRequested) return;
    turn.cancelRequested = true;
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

  #disconnect(error, notify = true) {
    if (this.#closed) return;
    const wasReady = this.#ready;
    this.#closed = true;
    this.#ready = false;
    for (const pending of [this.#opening, this.#turn]) {
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    }
    this.#opening = this.#turn = undefined;
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
    const elapsed = performance.now() - turn.startedAt;
    if (event.type === 'response.done') {
      this.#turn = undefined;
      clearTimeout(turn.timer);
      turn.resolve({
        text: turn.text, audio: turn.audio, outputRate: this.outputRate,
        audioSeconds: turn.bytes / (2 * this.outputRate),
        firstTextMs: turn.firstTextMs, firstAudioMs: turn.firstAudioMs, totalMs: elapsed,
        status: turn.cancelRequested ? 'cancelled' : event.response?.status,
      });
    } else if (turn.cancelRequested) {
      // Drain the cancelled response before admitting another turn on the same socket.
      return;
    } else if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      turn.firstTextMs ??= elapsed;
      turn.text += event.delta;
      turn.onText?.(turn.text);
    } else if (event.type === 'response.output_audio.delta' && event.delta) {
      const bytes = Uint8Array.from(atob(event.delta), (char) => char.charCodeAt(0));
      turn.bytes += bytes.length;
      if (bytes.length % 2 || turn.bytes > this.outputRate * 2 * 45) throw new Error('The model returned an invalid or oversized audio reply.');
      turn.firstAudioMs ??= elapsed;
      turn.audio.push(bytes);
      turn.onAudio?.(bytes, this.outputRate);
    }
  }
}
