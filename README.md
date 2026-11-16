# Discobuddy

Discobuddy is a local-first voice companion for one-on-one chats and Discord voice channels. It runs [Liquid AI's LFM3-Audio-2B](https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF) on your PC using [llama.cpp](https://github.com/ggml-org/llama.cpp): speak or type, then receive a reply in text and audio.

Try voices and personas in **Voice Lab**, or connect a bot to a Discord voice channel with **Discord Voice Control**. Model inference runs locally; no cloud AI service or API key is required. Discord voice still uses Discord's network.

## Features

- **Hands-free conversation:** Speak naturally, pause to send a turn, and interrupt a spoken reply by talking. Manual recording and typed messages are also available.
- **Voices and personas:** Choose the model's original live voice or female and male text-to-speech voices, adjust playback speed, and use a preset or custom persona.
- **Discord voice:** Join a regular voice channel, preview replies locally, and choose when the bot should respond or be interrupted.
- **Conversation controls:** Set alternative bot names and reply guidelines. An optional **Join when relevant** mode lets the local model decide whether to contribute to a group conversation.
- **Hangout mode:** Opt in to occasional prewritten jokes or questions after a quiet period in an occupied channel.

## Requirements

- Windows x64 and PowerShell. The included setup scripts have been prepared for Windows.
- Chrome or Edge, plus a microphone and speakers or headphones for voice chat.
- An internet connection for the initial download and roughly 1.4 GB of downloads, plus space for the extracted runtime. A Vulkan-capable GPU is recommended; a CPU option is available.
- For Discord Voice Control and development tests: Node.js 22.12 or newer and npm. Connecting the bot also requires a Discord account, a server you can add a bot to, and internet access.

For Discord or development, check your Node.js and npm versions with `node --version` and `npm --version` in PowerShell. If either command is missing, install [Node.js](https://nodejs.org/en/download), reopen PowerShell, and check again.

## Quick start: Voice Lab

If you have Git installed, clone the repository from PowerShell:

```powershell
git clone https://github.com/ariesyous/discobuddy.git
cd discobuddy
```

Alternatively, choose **Code → Download ZIP** on GitHub and extract the archive. To open PowerShell in the extracted folder, open the folder in File Explorer, type `powershell` in its address bar, and press Enter. Run setup and start the model server:

```powershell
.\scripts\setup-local.ps1
.\scripts\chat-local.ps1
```

Setup downloads a pinned [llama.cpp Vulkan build](https://github.com/ggml-org/llama.cpp/releases/tag/b12359), the model, and its audio projector. It verifies their SHA-256 hashes and stores them in the Git-ignored `.local-runtime` directory. Setup can take a while; wait for the “Discobuddy is ready” message before starting the server. After setup, Voice Lab can run offline. You do not need Node.js, Python, a Discord token, or an API key for Voice Lab.

Leave the PowerShell window running while you use Discobuddy. For later sessions, you can skip `setup-local.ps1` and start the server with `chat-local.ps1` from the project folder.

### Have your first conversation

1. Open [Voice Lab](http://127.0.0.1:8765/) in Chrome or Edge and wait for **Local model ready**.
2. Choose **Start hands-free** and allow microphone access when your browser asks. Say something like “What should we play tonight?” and pause for about a second. Discobuddy will reply with text and speech.
3. To interrupt a reply, speak over it. Choose **Stop hands-free** when you want to release the microphone; this discards an unfinished turn.

You can also type in the message box and select **Send**, or choose **Record**, speak, and select **Stop & send** for a manual voice turn. Use **Cancel reply** to stop a reply in progress. Spoken turns can last up to 20 seconds.

### Change the voice or personality

1. Under **Persona**, choose a preset such as **Casual buddy** or **Deadpan teammate**, or edit **Persona instructions** to write your own.
2. Under **Voice**, choose **Original live voice**, **Female**, or **Male**. The female and male options use text-to-speech and may take longer to start.
3. Select **Start new chat** to apply the changes. This clears the visible conversation and starts fresh model context.

Use **Playback speed** to adjust speech from 0.75× to 2×. Uncheck **Play replies aloud** if you prefer to play individual replies yourself. Voice Lab remembers the applied voice, persona, and playback speed in the browser; it does not save conversations or recordings. Use one Voice Lab tab at a time because each tab holds a model session. Press `Ctrl+C` in the server terminal to stop it.

## Set up Discord Voice Control

Complete the Voice Lab setup above first and keep its model server running. The following steps are needed once for a new bot.

### 1. Install the Discord dependencies

Open a **second** PowerShell window in the project folder. Confirm that Node.js 22.12 or newer is installed, then run:

```powershell
npm ci
```

### 2. Create and install a Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application. Give it a name you will recognize in your server.
2. Open the application's **Bot** page and select **Reset Token** to obtain a bot token. Keep it private; you will paste it into a local file in the next step. Leave the privileged intents off.
3. Open **Installation**, enable **Guild Install**, and select **Discord Provided Link**. In the default settings for Guild Install, add the `bot` scope and the **View Channels**, **Connect**, and **Speak** permissions.
4. Open the installation link and add the bot to a test server you manage. Check the channel's permissions if the bot cannot see or join it. Discobuddy supports regular voice channels, not Stage channels.

### 3. Configure the token

In the second PowerShell window, copy the example configuration and open the copy. If `.env.discord` already exists, open it directly instead of overwriting it:

```powershell
Copy-Item .env.discord.example .env.discord
notepad .env.discord
```

Replace the blank value after `DISCORD_BOT_TOKEN=` with your bot token and save the file. It should have the following shape, with your actual token in place of the placeholder:

```dotenv
DISCORD_BOT_TOKEN=your-bot-token-goes-here
```

**Keep this token private:** `.env.discord` is ignored by Git, but do not paste the token into chat or commit it. If you expose a token, reset it in the Developer Portal and update the local file. Restart the control panel after changing the token.

### 4. Start the panel and join a channel

1. With the model server still running in the first PowerShell window, start the Discord panel from the second window:

   ```powershell
   npm run discord
   ```

2. Open [Discord Voice Control](http://127.0.0.1:8767/) in your browser. Check that the top of the panel shows **Local model ready** and **Bot online**. You can also start the panel without a token to try local previews before connecting a bot.
3. In Discord, join the regular voice channel you want to use. Let everyone in the channel know that the bot will listen.
4. In the control panel, choose the server and voice channel under **Voice connection**, then select **Join channel**. Listening starts automatically.
5. Speak in Discord and pause. In a group, try “DiscoBuddy, what's the capital of Canada?” With the default settings, the bot answers without needing its name in a one-on-one channel and waits for its name in a group. If people speak at the same time, Discobuddy takes the first speaker's turn.

**Stop listening** discards an unfinished turn and deafens the bot while it stays connected; **Start listening** resumes it. **Leave channel** stops playback and cancels unfinished replies. You can also type a prompt and choose **Speak in Discord**. Stage channels are not supported.

### Configuration

The `npm run discord` command loads `.env.discord` if it exists. You can also set these variables in your environment; an existing environment variable takes precedence over the value in the file:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Empty | Bot token; required to connect to Discord, but not for local previews. |
| `DISCOBUDDY_DISCORD_PORT` | `8767` | Port for the local Discord Voice Control panel. |
| `DISCOBUDDY_MODEL_PORT` | `8765` | Port of the local model server. |

Both services bind to `127.0.0.1`. The ports must be different and between 1024 and 65535. If you launch the model with a different port, set `DISCOBUDDY_MODEL_PORT` to match and restart the Discord panel. The example file contains commented port settings you can uncomment.

## Using Discobuddy in Discord

### Choose when it replies

In the control panel, choose a **When to reply** option under **Conversation**:

| Option | Behavior |
| --- | --- |
| **When called in groups** | Default. Replies normally one on one; in a group, start your request with “DiscoBuddy.” |
| **Only when called** | Requires the bot's name for spoken replies, even one on one. |
| **After every spoken turn** | Attempts to reply after each spoken turn. |
| **Join when relevant** | Lets the local model decide when to contribute without being called. Its decision is approximate and adds a model request. |

For **Join when relevant**, choose a **Pause between unprompted replies** from 15 seconds to two minutes. A direct call by name can still get a reply during that pause. To use a different name alongside “DiscoBuddy,” enter it under **Alternative names**, one name per line. Select **Apply settings** after making changes.

### Control interruptions

Choose **Interrupt replies** independently of the reply mode, then select **Apply settings**:

- **Only when called:** Say “DiscoBuddy, stop” and pause, or start a new request with the bot's name.
- **On any sustained speech:** Speak over a reply to interrupt it.
- **Finish each reply:** Wait for a directly requested reply to finish before speaking; speech during that reply is ignored.

Human speech still takes priority over unprompted and Hangout replies.

### Preview and apply a voice or persona

1. Under **Persona and voice**, choose a preset, edit the persona instructions if you like, and select a voice and playback speed. Open **Edit conversation guidelines** to change how replies are phrased.
2. Under **Test a voice reply**, enter a prompt and choose **Generate preview**. Press play on the resulting audio. The preview uses your current draft without changing the settings used in Discord.
3. Choose **Apply settings** to use the changes for the next Discord reply. To send a typed prompt to a joined channel, enter it under **Test a voice reply** and choose **Speak in Discord**; apply any pending settings first.

The prompt counter uses the model's tokenizer; its suggested 1,500-token target leaves room in the 4,096-token session for audio, replies, and message formatting. Longer prompts may work but leave less room for conversation. Voice Lab and Discord Voice Control have separate settings.

### Set up Hangout mode

1. Under **Jokes and questions**, enter one short joke or question per line and choose **Save lines**.
2. Select a saved line, choose **Generate line preview**, and press play to hear its exact wording. Lines use the applied text-to-speech voice; apply any voice change first. **Original live voice** uses the female text-to-speech voice for lines.
3. Connect to a voice channel, make sure listening is on and someone is present, then enable **Hangout mode** under **Conversation**.

Hangout mode is off by default each time the panel launches. When enabled, it picks an unused line after about 90 seconds of quiet and waits for someone to speak before starting another timer. Human speech cancels a pending or playing Hangout line.

## Start and stop a later session

Once setup is complete, open two PowerShell windows in the project folder:

1. In the first window, run `.\scripts\chat-local.ps1` and leave it running. Open [Voice Lab](http://127.0.0.1:8765/) if you want a one-on-one chat.
2. For Discord, run `npm run discord` in the second window, open [Discord Voice Control](http://127.0.0.1:8767/), and join a channel. You do not need to run setup or `npm ci` again for normal use.
3. When finished, select **Stop listening** or **Leave channel** in the panel. Press `Ctrl+C` in each PowerShell window to stop the panel and the model server. Closing the browser tab alone does not stop the services.

## Privacy and local data

- Voice Lab and Discord Voice Control listen only on the local machine. Voice Lab inference can run offline after setup; Discord requires a network connection to Discord.
- Voice Lab does not save chat transcripts or recordings. In Discord Voice Control, spoken audio and transcripts are processed in memory rather than saved. **Join when relevant** can retain up to four recent spoken turns in memory for 90 seconds, clearing them sooner when listening stops, the channel empties, or the bot changes channels.
- Applied Discord persona, guidelines, alternative names, reply mode, and the unprompted-reply interval are stored in `.local-runtime/discord-prompt.json`. The saved joke and question bank is stored in `.local-runtime/discord-lines.json`. These files and `.env.discord` stay local unless you explicitly add them to Git.
- A Discord bot receives the audio of people in the channel. Tell participants before joining or listening, and follow the rules of your server.

## Troubleshooting

- **Local model unavailable:** Make sure the first PowerShell window is still running `chat-local.ps1` and that the model server port matches `DISCOBUDDY_MODEL_PORT` in the Discord panel's configuration.
- **Microphone not working in Voice Lab:** Allow microphone access for the local page in Chrome or Edge and check the selected input device in Windows. You can still send a typed message while investigating.
- **Vulkan or GPU memory problems:** Start the server with `.\scripts\chat-local.ps1 -Cpu`. CPU inference may be slower.
- **Port 8765 is in use:** Start with `.\scripts\chat-local.ps1 -Port 8766`, open that port in the browser, and set `DISCOBUDDY_MODEL_PORT=8766` for the Discord panel.
- **Bot token needed or login failed:** Check `DISCORD_BOT_TOKEN` in `.env.discord`, then restart the panel. The panel does not expose the token through its API.
- **A channel is missing:** Check the bot's server and channel permissions. Only regular voice channels are supported.
- **The bot is online but cannot join voice:** Check that your network allows Discord voice UDP traffic. Discord voice uses a separate voice connection and DAVE end-to-end encryption; the pinned `@discordjs/voice` release handles DAVE negotiation.
- **Speak in Discord is unavailable:** Check that the model is ready, the bot has joined a voice channel, and any edited settings have been applied. Wait for current speech or another request to finish.
- **A preview or reply is waiting:** Both panels share the model server's two slots. Wait for a running reply to finish, and close extra Voice Lab tabs.
- **Speech is slow or repetitive:** The first reply after startup can take longer. Voice Lab retries once with fresh model context after detecting three copies of the same long reply; the model may still make mistakes.

## Development and tests

After `npm ci`, run the automated tests:

```powershell
npm test
```

Most tests use fixtures and do not need the model or Discord. To include the optional local-model integration tests, start the model server, close Voice Lab tabs so both slots are available, and run:

```powershell
$env:DISCOBUDDY_TEST_URL = 'http://127.0.0.1:8765'
npm test
```

These tests use synthesized speech; they do not test physical microphone hardware or the live Discord voice handshake. Issues and pull requests are welcome.

The launcher runs llama.cpp with two slots and an 8,192-token total context, preserving a 4,096-token context per slot. Voice Lab uses `/v1/realtime` for conversation and streams speech from `/v1/audio/speech` for the female and male voices. Discord buffers its reply before generating those voices.

### Hands-free latency

On a Windows PC with a Ryzen 5 5600X and RTX 3070, 24 matched synthesized-speech trials compared the buffered client at `fc76f84` with streaming. Both used llama.cpp `b12359`, Vulkan, the Q4_K_M model, the original live voice, and one model slot. Times are from detected speech end and include the 760 ms end pause:

| Measurement | Buffered median / p95 | Streamed median / p95 |
| --- | ---: | ---: |
| First text | 942 / 1,074 ms | 805 / 820 ms |
| First audio | 963 / 1,113 ms | 843 / 855 ms |
| Reply complete | 1,664 / 1,901 ms | 1,456 / 1,635 ms |

Both versions returned text and audio on every trial, but both missed the same answer in the longest prompt. Actual latency and answer quality depend on the machine, model, and conversation.

## License

Discobuddy's code is licensed under the [GNU General Public License v3.0 only](LICENSE). The separately downloaded [llama.cpp runtime](https://github.com/ggml-org/llama.cpp/blob/b12359/LICENSE) and [Liquid AI model](https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF) have their own licenses; the model card identifies its license as LFM1.0. Other dependencies retain their respective licenses.
