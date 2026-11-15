import { Readable } from 'node:stream';
import { ChannelType, Client, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import {
  AudioPlayerStatus, createAudioPlayer, createAudioResource, entersState,
  joinVoiceChannel, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
} from '@discordjs/voice';
import { discordPcm } from './audio.mjs';

export function createDiscordBot(token, onVoiceLost) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
  let gateway = 'connecting';
  let active;
  let voiceError = '';

  function leave() {
    const connection = active?.connection;
    active = undefined;
    onVoiceLost();
    player.stop(true);
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
    if (active && after.id === client.user?.id && after.guild.id === active.guildId &&
        before.channelId === active.id && after.channelId !== active.id) {
      lost('The bot was removed or moved from the selected voice channel.');
    }
  });

  function canJoin(channel) {
    return channel?.type === ChannelType.GuildVoice && channel.permissionsFor(client.user)?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak,
    ]);
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
        onVoiceLost();
        player.stop(true);
      }
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      if (active !== target) throw new Error();
      connection.subscribe(player);
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
    leave() { leave(); voiceError = ''; },
    play(reply) {
      if (active?.connection.state.status !== VoiceConnectionStatus.Ready) throw new Error('Join a voice channel first.');
      if (client.guilds.cache.get(active.guildId)?.members.me?.voice.serverMute) {
        throw new Error('The bot is server muted in this voice channel.');
      }
      voiceError = '';
      const raw = discordPcm(reply);
      player.play(createAudioResource(Readable.from([raw], { objectMode: false }), { inputType: StreamType.Raw }));
    },
    close() { leave(); return client.destroy(); },
  };
}
