import { Readable } from 'node:stream';
import { ChannelType, Client, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import {
  AudioPlayerStatus, createAudioPlayer, createAudioResource, entersState,
  joinVoiceChannel, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
} from '@discordjs/voice';
import { discordPcm } from './audio.mjs';
import { captureTurn, discordInputRate } from './receive.mjs';

export function createDiscordBot(token, onVoiceLost, { onUtterance, onListeningStopped, isBusy }) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
  let gateway = 'connecting';
  let active;
  let voiceError = '';

  function clearListener(target) {
    if (!target?.listenerId) return;
    target.listenerId = undefined;
    target.cancelCapture?.();
    onListeningStopped();
    if (player.state.resource?.metadata === 'spoken') player.stop(true);
  }

  function leave() {
    const target = active;
    active = undefined;
    clearListener(target);
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
      } else if (after.serverDeaf && active.listenerId) {
        setListener(null);
        voiceError = 'The bot was server deafened. Undeafen it before starting listening.';
      }
    } else if (after.id === active.listenerId && after.channelId !== active.id) {
      setListener(null);
    }
  });

  function canJoin(channel) {
    return channel?.type === ChannelType.GuildVoice && channel.permissionsFor(client.user)?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak,
    ]);
  }

  function participants() {
    const channel = client.channels.cache.get(active?.id);
    return channel ? channel.members.filter((member) => !member.user.bot)
      .map((member) => ({ id: member.id, name: member.displayName }))
      .sort((a, b) => a.name.localeCompare(b.name)) : [];
  }

  function setListener(userId) {
    const target = active;
    if (!userId) {
      const wasListening = Boolean(target?.listenerId);
      clearListener(target);
      if (wasListening) target.connection.rejoin({ selfDeaf: true });
      return;
    }
    if (target?.connection.state.status !== VoiceConnectionStatus.Ready) throw new Error('Join a voice channel first.');
    if (!participants().some(({ id }) => id === userId)) throw new Error('Choose someone in the joined voice channel.');
    if (client.guilds.cache.get(target.guildId)?.members.me?.voice.serverDeaf) {
      throw new Error('The bot is server deafened in this voice channel.');
    }
    if (target.listenerId === userId) return;
    clearListener(target);
    voiceError = '';
    target.listenerId = userId;
    if (!target.connection.rejoin({ selfDeaf: false })) throw new Error('Discord did not accept the listening update.');
  }

  function status() {
    const online = client.isReady();
    const channels = online ? client.channels.cache.filter(canJoin).map((channel) => ({
      id: channel.id, name: channel.name, guild: channel.guild.name,
    })).sort((a, b) => a.guild.localeCompare(b.guild) || a.name.localeCompare(b.name)) : [];
    return {
      gateway: online ? 'online' : gateway,
      bot: online ? client.user.username : '',
      channels, voice: active?.connection.state.status ?? 'idle',
      channelId: active?.id ?? null, playing: player.state.status !== AudioPlayerStatus.Idle, voiceError,
      participants: participants(), listenerId: active?.listenerId ?? null, capturing: Boolean(active?.cancelCapture),
    };
  }

  async function join(id) {
    if (!client.isReady()) throw new Error('The Discord bot is offline.');
    const channel = client.channels.cache.get(id);
    if (!canJoin(channel)) throw new Error('Choose a voice channel the bot can view, connect to, and speak in.');
    if (active?.id === id && active.connection.state.status === VoiceConnectionStatus.Ready) return;
    leave();
    voiceError = '';
    const connection = joinVoiceChannel({
      channelId: id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true, selfMute: false, daveEncryption: true,
    });
    const target = { id, guildId: channel.guild.id, connection };
    active = target;
    connection.on('error', () => {
      if (active === target) lost('The Discord voice transport reported an error.');
    });
    connection.on('stateChange', (previous, next) => {
      if (active !== target) return;
      if ([VoiceConnectionStatus.Disconnected, VoiceConnectionStatus.Destroyed].includes(next.status)) {
        lost('Discord voice disconnected. Select Join to retry.');
      } else if (previous.status === VoiceConnectionStatus.Ready && next.status !== VoiceConnectionStatus.Ready) {
        target.cancelCapture?.();
        onVoiceLost();
        player.stop(true);
      }
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      if (active !== target) throw new Error();
      connection.subscribe(player);
      connection.receiver.speaking.on('start', (userId) => {
        if (active !== target || target.listenerId !== userId || target.cancelCapture ||
            connection.state.status !== VoiceConnectionStatus.Ready || isBusy() ||
            player.state.status !== AudioPlayerStatus.Idle) return;
        voiceError = '';
        const decodeError = () => { voiceError = 'Discord audio could not be decoded. Try speaking again.'; };
        try {
          target.cancelCapture = captureTurn(connection.receiver, userId, {
            onTurn(pcm) {
              target.cancelCapture = undefined;
              if (pcm && active === target && target.listenerId === userId) {
                onUtterance({ pcm, rate: discordInputRate });
              }
            },
            onError: decodeError,
          });
        } catch { decodeError(); }
      });
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
    setListener,
    leave() { leave(); voiceError = ''; },
    play(reply, spoken = false) {
      if (active?.connection.state.status !== VoiceConnectionStatus.Ready) throw new Error('Join a voice channel first.');
      if (client.guilds.cache.get(active.guildId)?.members.me?.voice.serverMute) {
        throw new Error('The bot is server muted in this voice channel.');
      }
      voiceError = '';
      const raw = discordPcm(reply);
      player.play(createAudioResource(Readable.from([raw], { objectMode: false }), {
        inputType: StreamType.Raw, metadata: spoken ? 'spoken' : 'typed',
      }));
    },
    close() { leave(); return client.destroy(); },
  };
}
