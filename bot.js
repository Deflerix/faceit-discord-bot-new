require('dotenv').config();
const { ChannelType, Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const express = require('express');
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  generateDependencyReport,
  joinVoiceChannel
} = require('@discordjs/voice');
const play = require('play-dl');
const ytdl = require('@distube/ytdl-core');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');

// ================= KEEP ALIVE =================
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(port, () => console.log(`Server running on port ${port}`));
// =============================================

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

const {
  DISCORD_TOKEN,
  FACEIT_API_KEY,
  CHANNEL_ID,
  CHECK_INTERVAL,
  FACEIT_NICKS,
  GUILD_ID,
  VOICE_CHANNEL_ID,
  SONG_WIN_URL,
  SONG_LOSE_URL
} = process.env;
const nicknames = (FACEIT_NICKS || '').split(',').map(n => n.trim()).filter(Boolean);
const DEBUG = ['1', 'true', 'yes', 'on'].includes(String(process.env.DEBUG || '').toLowerCase());
const DEFAULT_WIN_SOUND = 'https://samplelib.com/lib/preview/mp3/sample-3s.mp3';
const DEFAULT_LOSE_SOUND = 'https://samplelib.com/lib/preview/mp3/sample-6s.mp3';

let checkedMatches = new Set();
let playerCache = {}; // cache profilu FACEIT
let eloCache = {}; // cache ELO do porównań tick->tick
let lastImage = null;
let leaderboard = {};

function debugLog(message) {
  if (DEBUG) console.log(`[DEBUG] ${message}`);
}

if (ffmpegPath && !process.env.FFMPEG_PATH) {
  process.env.FFMPEG_PATH = ffmpegPath;
  debugLog(`Ustawiono FFMPEG_PATH=${ffmpegPath}`);
}

function getSongUrl(isWin) {
  const configured = isWin ? SONG_WIN_URL : SONG_LOSE_URL;
  const fallback = isWin ? DEFAULT_WIN_SOUND : DEFAULT_LOSE_SOUND;
  if (!configured) return fallback;
  return configured;
}

function isDirectAudioUrl(url) {
  return /\.(mp3|ogg|wav|m4a)(\?.*)?$/i.test(url || '');
}

function isYoutubeUrl(url) {
  return /(?:youtube\.com|youtu\.be)/i.test(url || '');
}

async function playFallbackTone(connection) {
  console.log('[AUDIO WARN] Uruchamiam awaryjny test tone (ffmpeg sine).');
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play
    }
  });
  const ffmpeg = spawn(process.env.FFMPEG_PATH || ffmpegPath, [
    '-f', 'lavfi',
    '-i', 'sine=frequency=880:duration=3',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpeg.stderr.on('data', () => {});
  ffmpeg.on('error', err => console.error(`[AUDIO ERROR] ffmpeg fallback: ${err.message}`));

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw,
    inlineVolume: true
  });
  if (resource.volume) resource.volume.setVolume(0.8);
  connection.subscribe(player);
  player.play(resource);
  await entersState(player, AudioPlayerStatus.Playing, 10_000);
  await new Promise(resolve => {
    player.once(AudioPlayerStatus.Idle, resolve);
    player.once('error', () => resolve());
  });
}

// ================= AXIOS =================
const api = axios.create({
  timeout: 5000,
  headers: { Authorization: `Bearer ${FACEIT_API_KEY}` }
});

// ================= FILE STORAGE =================
const saveMatches = () => fs.writeFileSync('matches.json', JSON.stringify([...checkedMatches].slice(-100)));
const loadMatches = () => {
  if (fs.existsSync('matches.json')) checkedMatches = new Set(JSON.parse(fs.readFileSync('matches.json')));
};
const saveLeaderboard = () => fs.writeFileSync('leaderboard.json', JSON.stringify(leaderboard));
const loadLeaderboard = () => {
  if (fs.existsSync('leaderboard.json')) leaderboard = JSON.parse(fs.readFileSync('leaderboard.json'));
};

// ================= FACEIT =================
async function getPlayer(nick, forceRefresh = false) {
  debugLog(`getPlayer(${nick}) forceRefresh=${forceRefresh}`);
  if (!forceRefresh && playerCache[nick]) return playerCache[nick];
  const res = await api.get(`https://open.faceit.com/data/v4/players?nickname=${encodeURIComponent(nick)}`);
  playerCache[nick] = res.data;
  return res.data;
}

async function getLastMatch(playerId) {
  debugLog(`getLastMatch(${playerId})`);
  const res = await api.get(`https://open.faceit.com/data/v4/players/${playerId}/history?game=cs2&limit=1`);
  return res.data.items?.[0];
}

async function getMatchStats(matchId) {
  debugLog(`getMatchStats(${matchId})`);
  const res = await api.get(`https://open.faceit.com/data/v4/matches/${matchId}/stats`);
  return res.data;
}

// ================= HELPERS =================
function getMention(nick) {
  const id = process.env[`MENTION_${nick}`];
  return id ? `<@${id}>` : nick;
}

function formatPlayerStats(players = []) {
  return players.map(p => {
    const s = p.player_stats || {};
    const kd = Number(s['K/D Ratio'] ?? 0);
    const kills = s.Kills ?? '-';
    const deaths = s.Deaths ?? '-';
    const hs = s['Headshots %'] ?? '-';
    const nick = (p.nickname || '?').slice(0, 12);

    return `${nick.padEnd(12)} | ${kills}/${deaths} | KD:${kd.toFixed(2)} | HS:${hs}`;
  }).join('\n');
}

function getTeamScore(round, ourTeam) {
  const [s1, s2] = (round.round_stats?.Score || '0/0').split('/').map(v => Number(v) || 0);
  const [team1] = round.teams || [];
  return ourTeam === team1 ? { our: s1, enemy: s2 } : { our: s2, enemy: s1 };
}

function getTopFragger(players = []) {
  return players.reduce((best, p) => {
    const kills = Number(p.player_stats?.Kills ?? 0);
    return kills > best.kills ? { nick: p.nickname || '?', kills } : best;
  }, { nick: '?', kills: -1 });
}

function getElProfesore(players = []) {
  const target = ['deflerix', 'w4kky', 'pawik'];
  let filtered = players.filter(p => target.includes((p.nickname || '').toLowerCase()));
  if (!filtered.length) filtered = players;

  return filtered.reduce((worst, p) => {
    const kills = Number(p.player_stats?.Kills ?? 0);
    return kills < worst.kills ? { nick: p.nickname || '?', kills } : worst;
  }, { nick: '?', kills: Infinity });
}

function getRandomImage(isWin) {
  const images = isWin
    ? [process.env.IMAGE_WIN_1, process.env.IMAGE_WIN_2, process.env.IMAGE_WIN_3]
    : [process.env.IMAGE_LOSE_1, process.env.IMAGE_LOSE_2, process.env.IMAGE_LOSE_3];

  const allValid = images.filter(Boolean);
  const valid = allValid.filter(img => img !== lastImage);
  const pool = valid.length ? valid : allValid;
  if (!pool.length) return null;

  const selected = pool[Math.floor(Math.random() * pool.length)];
  lastImage = selected;
  return selected;
}

async function playMatchSong(isWin, overrideUrl = null, overrideVoiceChannelId = null) {
  const songUrl = overrideUrl || getSongUrl(isWin);
  const targetVoiceChannelId = overrideVoiceChannelId || VOICE_CHANNEL_ID;
  if (!targetVoiceChannelId || !songUrl) {
    return { ok: false, reason: 'Brak VOICE_CHANNEL_ID lub URL utworu.' };
  }
  debugLog(`playMatchSong(isWin=${isWin}) url=${songUrl} voiceChannel=${targetVoiceChannelId}`);

  let connection = null;
  let lastError = null;
  try {
    const voiceChannel = await client.channels.fetch(targetVoiceChannelId);
    if (!voiceChannel || !voiceChannel.isVoiceBased()) {
      console.log(`[WARN] Kanał głosowy nieprawidłowy: ${targetVoiceChannelId}`);
      return { ok: false, reason: `Kanał ${targetVoiceChannelId} nie jest kanałem głosowym.` };
    }
    const me = voiceChannel.guild.members.me;
    const perms = voiceChannel.permissionsFor(me);
    const canConnect = perms?.has('Connect');
    const canSpeak = perms?.has('Speak');
    debugLog(`voice perms connect=${canConnect} speak=${canSpeak}`);

    if (!canConnect || !canSpeak) {
      return {
        ok: false,
        reason: `Brak uprawnień na kanale (${targetVoiceChannelId}) -> Connect: ${Boolean(canConnect)}, Speak: ${Boolean(canSpeak)}`
      };
    }

    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    if (voiceChannel.type === ChannelType.GuildStageVoice && me?.voice) {
      // Stage channel: bot może być domyślnie "suppressed", więc nic nie słychać.
      await me.voice.setRequestToSpeak(true).catch(() => {});
      await me.voice.setSuppressed(false).catch(() => {});
      debugLog('stage voice: requested to speak / unsuppressed');
    }

    let playedSuccessfully = false;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      debugLog(`audio attempt=${attempt}`);
      let resource;

      try {
        if (isDirectAudioUrl(songUrl)) {
          debugLog('audio source mode=direct-http');
          const response = await axios.get(songUrl, {
            responseType: 'stream',
            timeout: 20_000,
            maxRedirects: 5
          });
          resource = createAudioResource(response.data, { inlineVolume: true });
        } else if (isYoutubeUrl(songUrl)) {
          debugLog('audio source mode=ytdl-core');
          const ytStream = ytdl(songUrl, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25
          });
          resource = createAudioResource(ytStream, { inlineVolume: true });
        } else {
          debugLog('audio source mode=play-dl');
          const stream = await play.stream(songUrl);
          resource = createAudioResource(stream.stream, {
            inputType: stream.type,
            inlineVolume: true
          });
        }
      } catch (sourceErr) {
        console.error(`[AUDIO ERROR] Nie udało się pobrać źródła audio: ${sourceErr.message}`);
        lastError = sourceErr.message;
        continue;
      }

      let playedMs = 0;
      try {
        if (resource.volume) resource.volume.setVolume(0.8);
        const player = createAudioPlayer({
          behaviors: {
            noSubscriber: NoSubscriberBehavior.Play
          }
        });
        const startedAt = Date.now();

        connection.subscribe(player);
        player.play(resource);
        await entersState(player, AudioPlayerStatus.Playing, 20_000);

        playedMs = await new Promise(resolve => {
          const hardTimeout = setTimeout(() => resolve(Date.now() - startedAt), 180_000);

          player.on(AudioPlayerStatus.Idle, () => {
            clearTimeout(hardTimeout);
            resolve(Date.now() - startedAt);
          });

          player.on('error', err => {
            console.error(`[AUDIO ERROR] ${err.message}`);
            clearTimeout(hardTimeout);
            resolve(Date.now() - startedAt);
          });
        });
      } catch (playbackErr) {
        console.error(`[AUDIO ERROR] Problem podczas odtwarzania: ${playbackErr.message}`);
        lastError = playbackErr.message;
        continue;
      }

      // Jeśli utwór zakończył się podejrzanie szybko (np. 3-5s), spróbuj raz jeszcze.
      if (playedMs >= 8_000 || attempt === 2) {
        playedSuccessfully = playedMs > 0;
        break;
      }
      console.log('[AUDIO WARN] Odtwarzanie zakończyło się za szybko, ponawiam próbę...');
    }

    if (!playedSuccessfully) {
      try {
        await playFallbackTone(connection);
      } catch (fallbackErr) {
        lastError = fallbackErr.message;
        return { ok: false, reason: `Fallback tone nie zagrał: ${fallbackErr.message}` };
      }
    }
    return { ok: true, reason: '' };
  } catch (err) {
    console.error(`[AUDIO ERROR] playMatchSong failed: ${err.message}`);
    return { ok: false, reason: err.message || lastError || 'Nieznany błąd audio.' };
  } finally {
    debugLog('audio disconnect');
    if (connection) connection.destroy();
  }
}

function warnAudioConfig() {
  if (!VOICE_CHANNEL_ID) console.log('[INFO] Brak VOICE_CHANNEL_ID - audio po meczu wyłączone.');
  if (!SONG_WIN_URL || !SONG_LOSE_URL) {
    console.log('[INFO] Brak SONG_WIN_URL lub SONG_LOSE_URL - użyte będą domyślne krótkie MP3.');
  }
  if (DEBUG) {
    console.log('[DEBUG] @discordjs/voice dependency report:');
    console.log(generateDependencyReport());
  }
}

// ================= MATCH =================
async function processMatch(forceSend = false) {
  try {
    debugLog(`processMatch(forceSend=${forceSend})`);
    if (!nicknames.length) return;

    // Pobranie ostatnich meczów wszystkich nicków.
    const lastMatches = await Promise.all(
      nicknames.map(async nick => {
        const player = await getPlayer(nick, forceSend); // przy forceSend odświeżamy profil
        return getLastMatch(player.player_id);
      })
    );

    const uniqueMatchIds = [...new Set(lastMatches.map(m => m?.match_id).filter(Boolean))];
    debugLog(`uniqueMatchIds=${JSON.stringify(uniqueMatchIds)}`);
    if (!uniqueMatchIds.length) return;

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    for (const matchId of uniqueMatchIds) {
      debugLog(`processing matchId=${matchId}`);
      if (checkedMatches.has(matchId) && !forceSend) continue;

      const stats = await getMatchStats(matchId);
      const round = stats?.rounds?.[0];
      if (!round) continue;

      const lowerNicks = nicknames.map(n => n.toLowerCase());
      const ourTeam = (round.teams || []).find(t =>
        (t.players || []).some(p => lowerNicks.includes((p.nickname || '').toLowerCase()))
      );
      if (!ourTeam) continue;

      const enemyTeam = (round.teams || []).find(t => t !== ourTeam) || { players: [] };
      const { our, enemy } = getTeamScore(round, ourTeam);
      const isWin = our > enemy;
      const resultText = `${isWin ? '🟢 WIN' : '🔴 LOSE'} | ${our}:${enemy}`;

      const top = getTopFragger(ourTeam.players || []);
      const profesore = getElProfesore(ourTeam.players || []);

      let eloLines = '';
      for (const n of nicknames) {
        try {
          const p = await getPlayer(n, true); // świeże ELO na ten tick
          const elo = Number(p.games?.cs2?.faceit_elo ?? 0);
          const prev = eloCache[n] ?? 'X';
          eloLines += `- ${n} ${prev} → ${elo}\n`;
          eloCache[n] = elo;
        } catch {
          eloLines += `- ${n} brak danych\n`;
        }
      }

      const mentions = nicknames.map(getMention).join(' ');
      const image = getRandomImage(isWin);
      const rawTs = lastMatches.find(m => m?.match_id === matchId)?.finished_at
        || lastMatches.find(m => m?.match_id === matchId)?.started_at
        || Math.floor(Date.now() / 1000);

      const dateText = new Date(rawTs * 1000).toLocaleString('pl-PL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const mapName = round.round_stats?.Map || '-';
      const message = `📊 Raport ${mentions}\n📅 Data: ${dateText}\n${resultText}\n🌍 Mapa: ${mapName}\n🐐 GOAT: ${top.nick} (${top.kills})\n🚑 PROFESORE: ${profesore.nick} (${profesore.kills})\n\n📈 ELO:\n${eloLines}`;

      const statsEmbed = new EmbedBuilder()
        .setColor(isWin ? 0x2ecc71 : 0xe74c3c)
        .setTitle('📋 Statystyki meczu')
        .addFields(
          { name: 'OUR', value: `\`\`\`\n${formatPlayerStats(ourTeam.players)}\n\`\`\`` },
          { name: 'ENEMY', value: `\`\`\`\n${formatPlayerStats(enemyTeam.players)}\n\`\`\`` }
        );

      await channel.send({
        content: message,
        embeds: [statsEmbed]
      });
      debugLog(`match report sent for ${matchId}`);

      if (image) {
        await channel.send({ files: [image] });
        debugLog(`image sent for ${matchId}`);
      }

      // Oznacz mecz jako wysłany ZANIM odpalimy audio, żeby błąd muzyki nie powodował
      // ponownego wysyłania tego samego raportu w kolejnych tickach.
      checkedMatches.add(matchId);
      saveMatches();
      debugLog(`match persisted ${matchId}`);

      try {
        await playMatchSong(isWin);
      } catch (audioErr) {
        console.error(`[AUDIO WARN] Nie udało się odtworzyć muzyki: ${audioErr.message}`);
      }
    }
  } catch (err) {
    console.error(err.message);
  }
}

// ================= READY =================
client.once('clientReady', async () => {
  console.log(`Zalogowano jako ${client.user.tag}`);
  warnAudioConfig();
  loadMatches();
  loadLeaderboard();

  const commands = [
    new SlashCommandBuilder().setName('zmecz_zweiha').setDescription('Zlicza zmeczenie Zweiha'),
    new SlashCommandBuilder().setName('leaderboard').setDescription('Pokazuje ranking zmeczeń'),
    new SlashCommandBuilder()
      .setName('testaudio')
      .setDescription('Testuje audio na kanale VOICE_CHANNEL_ID')
      .addStringOption(option =>
        option
          .setName('typ')
          .setDescription('Jaki dźwięk puścić')
          .setRequired(true)
          .addChoices(
            { name: 'win', value: 'win' },
            { name: 'lose', value: 'lose' }
          )
      )
      .addStringOption(option =>
        option
          .setName('url')
          .setDescription('Opcjonalny bezpośredni URL audio (mp3/ogg)')
          .setRequired(false)
      )
  ];

  try {
    const commandPayload = commands.map(c => c.toJSON());
    if (GUILD_ID) {
      await client.application.commands.set(commandPayload, GUILD_ID);
      console.log(`[INFO] Slash commands zarejestrowane dla guild ${GUILD_ID}`);
    } else {
      await client.application.commands.set(commandPayload);
      console.log('[INFO] Slash commands zarejestrowane globalnie (propagacja może potrwać).');
    }
  } catch (commandErr) {
    console.error(`[ERROR] Rejestracja slash commands nie powiodła się: ${commandErr.message}`);
  }

  setInterval(() => processMatch(), Number(CHECK_INTERVAL) || 180000);
});

// ================= INTERACTION =================
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;

  if (interaction.commandName === 'zmecz_zweiha') {
    leaderboard[userId] = (leaderboard[userId] || 0) + 1;
    saveLeaderboard();
    await interaction.reply({ content: `<@${userId}> zmeczył Zweiha 🍆 🤬` });
  }

  if (interaction.commandName === 'leaderboard') {
    const sorted = Object.entries(leaderboard)
      .filter(([_, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);

    if (!sorted.length) return interaction.reply('Brak zmeczeń w tabeli.');

    let message = 'Leaderboard:\n';
    const emojis = ['🥇', '🥈', '🥉'];

    sorted.forEach(([id, count], i) => {
      const prefix = i < 3 ? emojis[i] : `${i + 1}️⃣`;
      message += `${prefix} <@${id}> ${count}\n`;
    });

    await interaction.reply({ content: message });
  }

  if (interaction.commandName === 'testaudio') {
    const typ = interaction.options.getString('typ', true);
    const customUrl = interaction.options.getString('url');
    const memberVoiceChannelId = interaction.member?.voice?.channelId || null;
    const resolvedChannelId = memberVoiceChannelId || VOICE_CHANNEL_ID || null;

    await interaction.reply({
      content: `🔊 Test audio: ${typ}${customUrl ? ' (custom URL)' : ''}\n🎤 Kanał: ${resolvedChannelId || 'brak'}`,
      ephemeral: true
    });

    try {
      const audioResult = await playMatchSong(typ === 'win', customUrl || null, resolvedChannelId);
      if (audioResult.ok) {
        await interaction.followUp({ content: '✅ Test audio zakończony (sprawdź kanał głosowy).', ephemeral: true });
      } else {
        await interaction.followUp({
          content: `⚠️ Audio nie wystartowało.\nPowód: ${audioResult.reason}`,
          ephemeral: true
        });
      }
    } catch (err) {
      await interaction.followUp({ content: `❌ Błąd audio (unexpected): ${err.message}`, ephemeral: true });
    }
  }

});

client.login(DISCORD_TOKEN);
