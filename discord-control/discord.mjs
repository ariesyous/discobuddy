import { Readable } from 'node:stream';
import { ChannelType, Client, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import {
  AudioPlayerStatus, createAudioPlayer, createAudioResource, entersState,
  joinVoiceChannel, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
} from '@discordjs/voice';
import { discordPcm } from './audio.mjs';
import { captureTurn, discordInputRate } from './receive.mjs';

function referenceFrame(resource, delayMs) {
  const raw = resource?.metadata.raw;
  if (!raw) return;
  const end = Math.min(raw.length / 4, (resource.playbackDuration - delayMs) * 48);
  const start = end - 960;
  if (start < 0) return;
  return Float32Array.from({ length: 320 }, (_, i) => {
    const offset = (start + 3 * i) * 4;
    return (raw.readInt16LE(offset) + raw.readInt16LE(offset + 4) + raw.readInt16LE(offset + 8)) / (3 * 32768);
  });
}

export function createDiscordBot(token, onVoiceLost, {
  onUtterance, onListeningStopped, isBusy, interruptionMode,
  onHumanStart = () => {}, onHumanSpeech = () => {}, onHumanEnd = () => {}, onActivityChanged = () => {},
}) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
  let gateway = 'connecting';
  let active;
  let voiceError = '';

  function clearListening(target) {
    if (!target?.listening) return;
    target.listening = false;
    target.capture?.cancel();
    onListeningStopped();
    if (player.state.resource?.metadata.speaker) player.stop(true);
  }

  function leave() {
    const target = active;
    active = undefined;
    clearListening(target);
    onVoiceLost();
    player.stop(true);
    const connection = target?.connection;
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }

  function lost(message) {
    leave();
    voiceError = message;
  }

  player.on('error', () => { voiceError = 'Discord could not play the reply.'; });
  player.on('stateChange', onActivityChanged);
  client.on(Events.Error, () => {});
  client.on(Events.ShardError, () => {});
  client.on(Events.ShardDisconnect, () => {
    if (active) lost('The Discord Gateway disconnected. Join again when the bot is online.');
  });
  client.on(Events.VoiceStateUpdate, (before, after) => {
    if (!active || after.guild.id !== active.guildId) return;
    if (after.id === client.user?.id) {
      if (before.channelId === active.id && after.channelId !== active.id) {
        lost('The bot was removed or moved from the selected voice channel.');
      } else if (after.serverDeaf && active.listening) {
        setListening(false);
        voiceError = 'The bot was server deafened. Undeafen it before starting listening.';
      }
    } else if (before.channelId === active.id && after.channelId !== active.id) {
      onHumanEnd(after.id);
      if (after.id === active.capture?.userId) active.capture.cancel();
    }
    onActivityChanged();
  });

  function canJoin(channel) {
    return channel?.type === ChannelType.GuildVoice && channel.permissionsFor(client.user)?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak,
    ]);
  }

  function setListening(enabled) {
    const target = active;
    if (!enabled) {
      if (target?.listening) {
        clearListening(target);
        target.connection.rejoin({ selfDeaf: true });
      }
      onActivityChanged();
      return;
    }
    if (target?.connection.state.status !== VoiceConnectionStatus.Ready) throw new Error('Join a voice channel first.');
    if (client.guilds.cache.get(target.guildId)?.members.me?.voice.serverDeaf) {
      throw new Error('The bot is server deafened in this voice channel.');
    }
    if (target.listening) return;
    voiceError = '';
    target.listening = true;
    if (!target.connection.rejoin({ selfDeaf: false })) {
      target.listening = false;
      throw new Error('Discord did not accept the listening update.');
    }
    onActivityChanged();
  }

  function status() {
    const online = client.isReady();
    const channels = online ? client.channels.cache.filter(canJoin).map((channel) => ({
      id: channel.id, name: channel.name, guild: channel.guild.name,
    })).sort((a, b) => a.guild.localeCompare(b.guild) || a.name.localeCompare(b.name)) : [];
    const people = active ? (client.guilds.cache.get(active.guildId)?.voiceStates.cache.filter((state) =>
      state.channelId === active.id && state.id !== client.user?.id && !state.member?.user.bot).size ?? 0) : 0;
    return {
      gateway: online ? 'online' : gateway,
      bot: online ? client.user.username : '',
      channels, voice: active?.connection.state.status ?? 'idle',
      channelId: active?.id ?? null, playing: player.state.status !== AudioPlayerStatus.Idle, voiceError,
      listening: Boolean(active?.listening), capturing: Boolean(active?.capture), people,
      speaker: active?.capture?.speaker ?? player.state.resource?.metadata.speaker ?? null,
    };
  }

  async function join(id, { listening = true } = {}) {
    if (!client.isReady()) throw new Error('The Discord bot is offline.');
    const channel = client.channels.cache.get(id);
    if (!canJoin(channel)) throw new Error('Choose a voice channel the bot can view, connect to, and speak in.');
    if (active?.id === id && active.connection.state.status === VoiceConnectionStatus.Ready) return;
    leave();
    voiceError = '';
    const connection = joinVoiceChannel({
      channelId: id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: !listening, selfMute: false, daveEncryption: true,
    });
    const target = { id, guildId: channel.guild.id, connection, listening };
    active = target;
    connection.on('error', () => {
      if (active === target) lost('The Discord voice transport reported an error.');
    });
    connection.on('stateChange', (previous, next) => {
      if (active !== target) return;
      if ([VoiceConnectionStatus.Disconnected, VoiceConnectionStatus.Destroyed].includes(next.status)) {
        lost('Discord voice disconnected. Select Join to retry.');
      } else if (previous.status === VoiceConnectionStatus.Ready && next.status !== VoiceConnectionStatus.Ready) {
        target.capture?.cancel();
        onVoiceLost();
        player.stop(true);
      }
      onActivityChanged();
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      if (active !== target) throw new Error();
      connection.subscribe(player);
      if (target.listening && channel.guild.members.me?.voice.serverDeaf) {
        setListening(false);
        voiceError = 'The bot is server deafened. Undeafen it before starting listening.';
      }
      connection.receiver.speaking.on('start', (userId) => {
        if (active !== target || !target.listening || connection.state.status !== VoiceConnectionStatus.Ready) return;
        const voiceState = channel.guild.voiceStates.cache.get(userId);
        const member = voiceState?.member;
        if (voiceState?.channelId !== id || !member || member.user.bot) return;
        // Even while another turn is busy, human speech takes priority over a hangout line.
        onHumanStart(userId);
        if (target.capture || isBusy()) return;

        const playing = player.state.resource;
        // Hangout lines always yield to sustained human speech, irrespective of
        // the operator's interruption setting for conversational replies.
        const mode = playing && (playing.metadata.hangout ? 'any' : interruptionMode());
        if (mode === 'finish') return;
        const overlap = playing ? {
          mode,
          stop() { if (player.state.resource === playing) player.stop(true); },
        } : undefined;
        const speaker = { name: member.displayName, username: member.user.username };
        const capture = { userId, speaker };
        target.capture = capture;
        onActivityChanged();
        voiceError = '';
        const decodeError = () => { voiceError = 'Discord audio could not be decoded. Try speaking again.'; };
        try {
          capture.cancel = captureTurn(connection.receiver, userId, {
            playbackFrame(delay) {
              if (playing && player.state.resource === playing) return referenceFrame(playing, delay);
            },
            onSpeech() {
              onHumanSpeech(userId);
              if (overlap?.mode === 'any') overlap.stop();
            },
            onTurn(pcm) {
              if (target.capture !== capture) return;
              target.capture = undefined;
              if (pcm && active === target && target.listening) {
                onUtterance({ pcm, rate: discordInputRate, speaker }, overlap);
              }
              onActivityChanged();
            },
            onError: decodeError,
          });
        } catch {
          target.capture = undefined;
          decodeError();
          onActivityChanged();
        }
      });
      connection.receiver.speaking.on('end', (userId) => {
        if (active === target) onHumanEnd(userId);
      });
      onActivityChanged();
    } catch {
      if (active === target) lost('Could not join voice. Check channel permissions, capacity, and UDP access.');
      throw new Error(voiceError || 'The voice join was cancelled.');
    }
  }

  return {
    start() {
      client.once(Events.ClientReady, () => { gateway = 'reconnecting'; });
      void client.login(token).catch(() => { gateway = 'login failed'; });
    },
    status,
    join,
    setListening,
    leave() { leave(); voiceError = ''; },
    play(reply, speaker = null, { hangout = false } = {}) {
      if (active?.connection.state.status !== VoiceConnectionStatus.Ready) throw new Error('Join a voice channel first.');
      if (client.guilds.cache.get(active.guildId)?.members.me?.voice.serverMute) {
        throw new Error('The bot is server muted in this voice channel.');
      }
      voiceError = '';
      const raw = discordPcm(reply);
      player.play(createAudioResource(Readable.from([raw], { objectMode: false }), {
        inputType: StreamType.Raw, metadata: { speaker, raw, hangout },
      }));
    },
    stopHangout() { if (player.state.resource?.metadata.hangout) player.stop(true); },
    close() { leave(); return client.destroy(); },
  };
}
