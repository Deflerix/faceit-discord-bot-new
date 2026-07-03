const { 
  AttachmentBuilder, 
  EmbedBuilder, 
  SlashCommandBuilder, 
  PermissionFlagsBits 
} = require('discord.js');

const { getPlayerEloHistory } = require('./services/eloService');
const { generateEloChart } = require('./services/eloChart');
const storage = require('./storage');

/* =========================
🔥 GRIND SYSTEM
========================= */

function startGrind(userId) {
  const sessions = storage.getGrindSessions();

  if (sessions[userId]) {
    return { ok: false, msg: "❌ Już masz aktywny grind" };
  }

  sessions[userId] = {
    startTime: Date.now(),
    matches: [],
    wins: 0,
    loses: 0
  };

  storage.saveGrindSessions(sessions);

  return { ok: true };
}

function endGrind(userId) {
  const sessions = storage.getGrindSessions();
  const session = sessions[userId];

  if (!session) {
    return { ok: false, msg: "❌ Brak aktywnego grindu" };
  }

  delete sessions[userId];
  storage.saveGrindSessions(sessions);

  return {
    ok: true,
    session
  };
}

/* =========================
COMMANDS
========================= */

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('start_grind')
      .setDescription('Rozpoczyna sesję grindu'),

    new SlashCommandBuilder()
      .setName('end_grind')
      .setDescription('Kończy sesję grindu i pokazuje raport'),

    new SlashCommandBuilder()
      .setName('zmecz_zweiha')
      .setDescription('Zlicza zmeczenie Zweiha'),

    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Pokazuje ranking zmeczeń'),

    new SlashCommandBuilder()
      .setName('add_player')
      .setDescription('Dodaje gracza do monitorowania')
      .addStringOption(option =>
        option.setName('nick')
          .setDescription('Nick FACEIT')
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('remove_player')
      .setDescription('Usuwa gracza z monitorowania')
      .addStringOption(option =>
        option.setName('nick')
          .setDescription('Nick FACEIT')
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('set_channel')
      .setDescription('Ustawia kanał raportów')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName('elo')
      .setDescription('Pokazuje wykres historii ELO')
      .addStringOption(option =>
        option.setName('player')
          .setDescription('Nick lub ID')
          .setRequired(false)
      )
      .addIntegerOption(option =>
        option.setName('limit')
          .setDescription('Ilość meczów')
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(false)
      )
  ];
}

async function registerCommands(client, guildId) {
  const payload = buildCommands().map(c => c.toJSON());

  if (guildId) {
    await client.application.commands.set(payload, guildId);
  } else {
    await client.application.commands.set(payload);
  }
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

/* =========================
HANDLE COMMANDS
========================= */

async function handleCommand(interaction, storage, { faceit, matchLogger } = {}) {
  const { commandName } = interaction;

  /* =========================
  🔥 GRIND START
  ========================= */
  if (commandName === 'start_grind') {
    const res = startGrind(interaction.user.id);

    await interaction.reply({
      content: res.ok ? "🔥 Grind started — lecimy!" : res.msg,
      ephemeral: true
    });

    return;
  }

  /* =========================
  🔥 GRIND END
  ========================= */
  if (commandName === 'end_grind') {
    const res = endGrind(interaction.user.id);

    if (!res.ok) {
      await interaction.reply({ content: res.msg, ephemeral: true });
      return;
    }

    const s = res.session;

    const winrate = s.matches.length
      ? (s.wins / s.matches.length * 100).toFixed(1)
      : 0;

    const embed = new EmbedBuilder()
      .setTitle("🎮 FC Grind Summary")
      .setColor(0x5865F2)
      .addFields(
        {
          name: "🏆 Result",
          value: `🟢 ${s.wins} Win\n🔴 ${s.loses} Lose\n📈 Winrate: ${winrate}%`
        },
        {
          name: "📊 Matches",
          value: String(s.matches.length)
        },
        {
          name: "⏱️ Duration",
          value: `<t:${Math.floor(s.startTime / 1000)}:R>`
        }
      );

    await interaction.reply({ embeds: [embed] });
    return;
  }

  /* =========================
  OLD COMMANDS (UNCHANGED)
  ========================= */

  if (commandName === 'zmecz_zweiha') {
    const count = storage.incrementLeaderboard(interaction.user.id);
    await interaction.reply({ content: `<@${interaction.user.id}> zmeczył Zweiha 🍆 🤬 (${count})` });
    return;
  }

  if (commandName === 'leaderboard') {
    const sorted = storage.getLeaderboardSorted();

    if (!sorted.length) {
      await interaction.reply('Brak zmeczeń w tabeli.');
      return;
    }

    let message = 'Leaderboard:\n';
    const emojis = ['🥇', '🥈', '🥉'];

    sorted.forEach(([id, count], i) => {
      const prefix = i < 3 ? emojis[i] : `${i + 1}️⃣`;
      message += `${prefix} <@${id}> ${count}\n`;
    });

    await interaction.reply({ content: message });
    return;
  }

  if (commandName === 'elo') {
    const requestedPlayer = interaction.options.getString('player');
    const limit = interaction.options.getInteger('limit') || 30;

    const activePlayers = matchLogger.getAllPlayers();
    let player = null;

    if (requestedPlayer) {
      player =
        matchLogger.getPlayerByNickname(requestedPlayer) ||
        matchLogger.getPlayerById(requestedPlayer);
    } else {
      player = activePlayers[0] || null;
    }

    if (!player || !player.active) {
      await interaction.reply({
        content: '⚠️ Nie znaleziono aktywnego gracza w SQLite.',
        ephemeral: true
      });
      return;
    }

    const history = getPlayerEloHistory(player.player_id, limit);

    if (!history.length) {
      await interaction.reply({
        content: `⚠️ Brak historii ELO dla ${player.nickname}.`,
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();

    const chartBuffer = await generateEloChart(history);

    const currentElo = history[history.length - 1].elo;
    const delta = currentElo - history[0].elo;

    const attachment = new AttachmentBuilder(chartBuffer, {
      name: 'elo-chart.png'
    });

    const embed = new EmbedBuilder()
      .setTitle(`📈 ELO history - ${player.nickname}`)
      .addFields(
        { name: 'Current ELO', value: String(currentElo), inline: true },
        { name: 'Change', value: `${delta >= 0 ? '+' : ''}${delta}`, inline: true },
        { name: 'Matches', value: String(history.length), inline: true }
      )
      .setImage('attachment://elo-chart.png')
      .setColor(delta >= 0 ? 0x2ecc71 : 0xe74c3c);

    await interaction.editReply({
      embeds: [embed],
      files: [attachment]
    });

    return;
  }

  /* =========================
  ADMIN CHECK
  ========================= */
  if (!isAdmin(interaction)) {
    await interaction.reply({
      content: '❌ Ta komenda jest tylko dla admina (Manage Server).',
      ephemeral: true
    });
    return;
  }

  if (commandName === 'add_player') {
    const nick = interaction.options.getString('nick', true).trim();

    try {
      const existing = matchLogger.getPlayerByNickname(nick);

      if (existing?.active) {
        await interaction.reply({
          content: '⚠️ Gracz już istnieje.',
          ephemeral: true
        });
        return;
      }

      const player = await faceit.getPlayer(nick, { forceRefresh: true });

      const result = matchLogger.upsertPlayer({
        player_id: player.player_id,
        nickname: player.nickname || nick,
        active: true
      });

      if (!result.ok) {
        await interaction.reply({
          content: `⚠️ Nie udało się dodać gracza: ${result.reason || 'błąd DB'}`,
          ephemeral: true
        });
        return;
      }

      storage.addPlayerLegacy(player.nickname || nick);

      await interaction.reply({
        content: `✅ Dodano gracza: ${player.nickname || nick}`,
        ephemeral: true
      });

    } catch (err) {
      console.error(`[COMMAND] add_player DB failed: ${err.message}`);

      await interaction.reply({
        content: `❌ Nie udało się dodać gracza: ${err.message}`,
        ephemeral: true
      });
    }

    return;
  }

  if (commandName === 'remove_player') {
    const nick = interaction.options.getString('nick', true).trim();

    try {
      const removed = matchLogger.deactivatePlayerByNickname(nick);

      if (!removed) {
        await interaction.reply({
          content: '⚠️ Nie znaleziono gracza.',
          ephemeral: true
        });
        return;
      }

      storage.removePlayerLegacy(nick);

      await interaction.reply({
        content: `✅ Usunięto gracza: ${nick}`,
        ephemeral: true
      });

    } catch (err) {
      console.error(`[COMMAND] remove_player DB failed: ${err.message}`);

      await interaction.reply({
        content: `❌ Nie udało się usunąć gracza: ${err.message}`,
        ephemeral: true
      });
    }

    return;
  }

  if (commandName === 'set_channel') {
    storage.setChannelId(interaction.channelId);

    await interaction.reply({
      content: `✅ Ustawiono kanał raportów na <#${interaction.channelId}>`,
      ephemeral: true
    });

    return;
  }
}

module.exports = {
  registerCommands,
  handleCommand
};
