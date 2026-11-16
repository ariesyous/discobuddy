# Discobuddy

Discobuddy Voice Lab is a local one-on-one chat for trying **LFM3-Audio-2B** before connecting it to Discord. Type or speak, get a spoken reply with text, and compare how different personas sound on your PC.

## Run on Windows

From the repository in PowerShell, run:

```powershell
.\scripts\setup-local.ps1
.\scripts\chat-local.ps1
```

Setup downloads about 1.4 GB once: a portable [llama.cpp Vulkan build](https://github.com/ggml-org/llama.cpp/releases/tag/b12359) and [Liquid AI's GGUF model and audio projector](https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF). It verifies the downloads and keeps them in the ignored `.local-runtime` folder. No Python, npm install, Discord token, or API key is needed. After setup, chat can run offline.

Open [the Voice Lab](http://127.0.0.1:8765/) in Chrome or Edge. Wait for **Local model ready**, select **Start hands-free**, and allow microphone access. Voice Lab streams audio to the local model while you speak and submits the turn after about 0.8 seconds of silence. The microphone stays open during replies, so you can speak over Discobuddy to cut off its reply and start your next turn. **Stop hands-free** releases the microphone and discards any unfinished turn. If audio from that turn has reached the model, Voice Lab starts a fresh model session and keeps the visible transcript. Each turn can last up to 20 seconds.

You can also type a message or use **Record** and **Stop & send** for a manual voice turn. Hands-free replies show detected speech duration and the end pause. First text, first audio, and total time are measured from the detected end of speech, so they include that pause. The first reply after startup can be slower. You can turn off automatic playback and replay individual replies.

Use **Playback speed** above the conversation to play any voice from **0.75×** to **2×**, with pitch preserved. The setting applies to newly queued speech and updates replays immediately. The browser remembers your speed.

If the model returns the same long reply across different turns, Voice Lab suppresses the third copy and retries that message once with fresh model context. It keeps your visible transcript, voice, and persona. Hands-free audio stays in memory until that turn finishes so the retry can use the same input.

Choose **Original live voice**, **Female**, or **Male** under **Voice**, then select **Start new chat** to apply the change and clear the previous context. The original voice is the model's direct conversational speech. Female and male use the model's supported text-to-speech voices to read its reply, and may take longer to start; speech is streamed as sentences become available. Voice and persona are independent. The model does not offer voice cloning through this setup.

To compare personas, try the same question with **Casual buddy** and **Deadpan teammate**. You can also write your own instructions. Select **Start new chat** after each change to apply the persona and clear the previous context. The browser remembers the last applied persona and voice across reloads; there is no saved chat or recording. Each open tab holds a model session, so use one Voice Lab tab at a time.

Use `Ctrl+C` in the server terminal to stop it. If port 8765 is busy, launch with `-Port 8766` and open that port. If Vulkan is unavailable or GPU memory is tight, try `.\scripts\chat-local.ps1 -Cpu`; replies may take longer.

## Development

llama.cpp serves the browser client on loopback and handles inference over `/v1/realtime`. Hands-free mode sends PCM at the browser's capture rate and lets llama.cpp resample as chunks arrive. Manual recordings are resampled in the browser to the model's advertised input rate. LFM3 defaults to 16 kHz mono input and streams 24 kHz mono replies.

For the female and male voices, the client keeps the model's interleaved conversation and streams its reply text through `/v1/audio/speech`. Text-only conversation can transcribe spoken input, which would leave the question unanswered. The launcher uses two slots and an 8,192-token total context to preserve a 4,096-token context per slot. The second slot and additional speech generation can use more memory and processing. Restart an older running server after updating before selecting a TTS voice.

Run the protocol and PCM checks with `node --test` (Node 22 or later). They don't need a model running. To also exercise both voices against a running local model with a synthesized spoken question and typed turns, set `$env:DISCOBUDDY_TEST_URL = 'http://127.0.0.1:8765'` before running the tests. Use a server with no Voice Lab tab open so both model slots are available. This integration check does not test microphone hardware.

## Discord Voice Control on Windows

Keep Voice Lab running on port 8765. In a separate PowerShell terminal, from this checkout, use Node.js 22.12 or newer:

```powershell
npm ci
npm run discord
```

Open [Discord Voice Control](http://127.0.0.1:8767/). You can edit conversation guidelines, persona, voice, and playback speed and **Generate preview** before creating a bot. A preview uses the current draft; select **Apply settings** to use it for Discord replies. The panel saves the applied persona and guidelines locally in `.local-runtime/discord-prompt.json` and restores them on restart. Other conversation settings return to their defaults, and previews and recordings are not saved.

This panel uses the same model server as Voice Lab. For the female and male voices, Discord finishes generating the reply before requesting its speech, so one Voice Lab session can stay open. If both services are busy, wait for Voice Lab to finish its reply before generating another. Discord playback starts after the complete reply has been generated.

The prompt counter uses the local model's tokenizer on the assembled system instructions. Its suggested 1,500-token target leaves room in the 4,096-token session for spoken input and the reply. The count excludes the Discord speaker's name and the model's message formatting; longer audio also consumes context, so the target is a guide rather than a guarantee. A warning appears when the draft exceeds the target.

To run the Discord bot:

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). On **Bot**, use **Reset Token** to obtain the bot token. Leave the privileged intents off.
2. Under **Installation**, enable **Guild Install** and choose **Discord Provided Link**. In the default settings for Guild Install, add the `bot` scope and the **View Channels**, **Connect**, and **Speak** permissions. Open the link and install it to a test server you manage. Check channel permissions if a regular voice channel is missing from the panel. Stage channels are out of scope.
3. Stop the control panel with Ctrl+C. Copy the example config and edit the ignored file locally:

   ```powershell
   Copy-Item .env.discord.example .env.discord
   notepad .env.discord
   npm run discord
   ```

   Set `DISCORD_BOT_TOKEN` in that file or in your environment. Never paste it into chat. The panel does not expose a token field or return the token from its API.
4. When the panel shows **Bot online**, let people in the channel know that the bot will listen, then select the channel and click **Join channel**. Listening starts automatically. In a group, say something like “DiscoBuddy, what’s the capital of Canada?” in one turn, then pause for about 0.8 seconds. If people talk over each other, the bot takes the first speaker’s turn. Discord identifies the speaker by account, and the panel shows who is speaking or receiving a reply.
5. **Stop listening** discards an unfinished spoken turn and deafens the bot while it stays joined. Use **Start listening** to resume. **Leave channel** stops all Discord playback and cancels unfinished replies. You can still type a prompt and select **Speak in Discord**.

Under **Conversation**, choose **When to reply** and **Interrupt replies** separately. The default waits for its name in groups and responds normally one on one. Use **Only when called** to require its name for all spoken replies, or **After every spoken turn** for open conversation. By default, interrupt by saying “DiscoBuddy, stop” and pausing, or by starting a new request with its name. Choose **On any sustained speech** for immediate interruption or **Finish each reply** to turn interruption off.

Open **Edit conversation guidelines** to change how replies are phrased. The defaults lead with the answer, skip routine greetings, and keep replies short. Select **Apply settings** to use the changes for the next turn. When the panel checks who was addressed, the local model transcribes the turn in memory. Audio and transcripts are not saved. Each reply starts fresh.

The panel binds to loopback, and there is no public endpoint or tunnel to configure. The bot uses the standard Guilds and Guild Voice States Gateway intents. [Discord voice](https://docs.discord.com/developers/topics/voice-connections) uses a separate voice WebSocket and UDP and requires DAVE end-to-end encryption for regular voice channels. The pinned `@discordjs/voice` release handles DAVE negotiation. If the bot connects to Discord but cannot join voice, verify that the network allows Discord's voice UDP traffic. The test server is needed to verify the real handshake and playback.

### Hands-free latency

The benchmark compared the buffered client at `fc76f84` with streaming on Windows using a Ryzen 5 5600X, an RTX 3070, llama.cpp `b12359` with Vulkan, and LFM3-Audio-2B Q4_K_M. Both clients used the original live voice with a single model slot. Headless Chrome ran 24 matched pairs with identical synthesized mic clips, eight pairs each at about 1, 3, and 6.5 seconds of speech. The runs alternated client order and used a fresh session for each trial on a warmed model.

| Time from detected end of speech | Buffered median / p95 | Streamed median / p95 |
| --- | ---: | ---: |
| First text | 942 / 1,074 ms | 805 / 820 ms |
| First audio | 963 / 1,113 ms | 843 / 855 ms |
| Reply complete | 1,664 / 1,901 ms | 1,456 / 1,635 ms |

These times include the 760 ms end pause and measure when replies reach the browser. Both versions returned text and audio on every trial. Both identified the requested color and number and answered apple instead of pear on the longest prompt. Both identified the requested color in a separate long prompt.
