# discobuddy

A local voice-chat Discord bot powered by `LFM3-Audio-2B`. The model needs only ~3–4GB of VRAM, so a single RTX 3070 can run inference locally while a Python bridge pipes audio to and from a Discord voice channel.

## Architecture: the audio bridge

Discord's Voice Gateway sends encrypted **Opus audio over UDP** at **48kHz stereo**. `LFM3-Audio-2B` expects and outputs **24kHz mono PCM**. The bot sits in the middle as a real-time audio router:

1. **Discord ingest:** `discord.py` plus the `discord-ext-voice-recv` extension. Standard `discord.py` only sends audio; `voice-recv` hooks incoming RTP/UDP packets per user.
2. **Resampling and VAD:** Decode Opus to PCM, downsample 48kHz stereo to 24kHz mono, and run a lightweight voice activity detector (`webrtcvad` or Silero VAD) so dead air and keyboard clicks never reach the model.
3. **Local inference:** Stream 80ms audio chunks to the local Liquid AI server, using the system prompt `Respond with interleaved text and audio.`
4. **Discord playback:** As `LFM3-Audio` streams back 24kHz audio tokens (decoded via `LiquidCodecStreamingCache`), upsample 24kHz mono to 48kHz stereo and feed a custom `discord.AudioSource` ring buffer.

## Discord-specific gotchas

1. **Multi-speaker chaos.** Full-duplex speech-to-speech models are trained on 1-on-1 conversations, so a raw mixed stream from several people talking over each other will confuse the model.
   - `discord-ext-voice-recv` provides separate audio streams tagged by `user.id`.
   - Gate input with a wake word (e.g. "Hey Bot..."), a push-to-talk slash/text toggle, or by locking onto whoever spoke first until their turn finishes.
2. **Self-echo.** If the bot hears its own voice, or speaker bleed from someone's mic, it will interrupt itself.
   - Filter out the bot's own SSRC/user ID on ingest.
   - Use a barge-in threshold, e.g. require 250ms+ of sustained human speech before flushing the outbound playback buffer.
3. **Personality via system prompt.** At 2B parameters the model is not for deep trivia, so lean into banter. Use a tight persona prompt (inside jokes, server role) and keep responses short so the bot doesn't monopolize the channel.

## Privacy and etiquette

Discord's developer policy requires bots that receive voice audio to make it obvious they are listening. When the bot joins a channel it should post a message in the text channel (e.g. "Joined #general — listening for wake word") and leave automatically when everyone disconnects.

## Planned stack

- Python, `discord.py`, `discord-ext-voice-recv`
- `liquid-audio` / `LFM3-Audio-2B` (local inference)
- `webrtcvad` or Silero VAD

## Status

Planning. Next step: a starter skeleton with the UDP-to-24kHz resampling loop.
