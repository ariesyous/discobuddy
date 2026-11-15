# Discobuddy

Discobuddy Voice Lab is a local one-on-one chat for trying **LFM3-Audio-2B** before connecting it to Discord. Type or speak, get a spoken reply with text, and compare how different personas sound on your PC.

## Run on Windows

From the repository in PowerShell, run:

```powershell
.\scripts\setup-local.ps1
.\scripts\chat-local.ps1
```

Setup downloads about 1.4 GB once: a portable [llama.cpp Vulkan build](https://github.com/ggml-org/llama.cpp/releases/tag/b12359) and [Liquid AI's GGUF model and audio projector](https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF). It verifies the downloads and keeps them in the ignored `.local-runtime` folder. No Python, npm install, Discord token, or API key is needed. After setup, chat can run offline.

Open [the Voice Lab](http://127.0.0.1:8765/) in Chrome or Edge. Wait for **Local model ready**, select **Start hands-free**, and allow microphone access. Speak and pause for about 0.8 seconds to send a turn. The microphone stays open during replies, so you can speak over Discobuddy to cut off its reply and start your next turn. **Stop hands-free** releases the microphone and discards any unfinished turn. Each turn can last up to 20 seconds.

You can also type a message or use **Record** and **Stop & send** for a manual voice turn. Each reply shows when text and audio first arrived and when generation finished. Hands-free timings include the pause used to detect the end of speech. The first reply after startup can be slower. You can turn off automatic playback and replay individual replies.

To compare personas, try the same question with **Casual buddy** and **Deadpan teammate**. You can also write your own instructions. Select **Start new chat** after each change to apply the persona and clear the previous context. The browser keeps only the last applied persona across reloads; there is no saved chat or recording. Each open tab holds a model session, so use one Voice Lab tab at a time.

Use `Ctrl+C` in the server terminal to stop it. If port 8765 is busy, launch with `-Port 8766` and open that port. If Vulkan is unavailable or GPU memory is tight, try `.\scripts\chat-local.ps1 -Cpu`; replies may take longer.

## Development

llama.cpp serves the browser client on loopback and handles inference over `/v1/realtime`. The client reads the model's advertised PCM sample rates, resamples microphone input in the browser, and plays audio chunks as they arrive. In the current build LFM3 reports 16 kHz mono input and 24 kHz mono output.

Run the protocol and PCM checks with `node --test` (Node 22 or later). They don't need a model running.

Discord is a separate next step. The voice bridge will need [Discord's DAVE protocol](https://docs.discord.com/developers/topics/voice-connections#end-to-end-encryption-dave-protocol), per-user turn control, and a clear listening notice. It can use the same local model with audio conversion between Discord and these sample rates.
