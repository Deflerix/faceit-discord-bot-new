const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

function buildCommands() {
  return [
    new SlashCommandBuilder().setName('zmecz_zweiha').setDescription('Zlicza zmeczenie Zweiha'),
    new SlashCommandBuilder().setName('leaderboard').setDescription('Pokazuje ranking zmeczeń'),
    new SlashCommandBuilder()
      .setName('add_player')
      .setDescription('Dodaje gracza do monitorowania')
      .addStringOption(option => option.setName('nick').setDescription('Nick FACEIT').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('remove_player')
      .setDescription('Usuwa gracza z monitorowania')
      .addStringOption(option => option.setName('nick').setDescription('Nick FACEIT').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('set_channel')
      .setDescription('Ustawia bieżący kanał jako kanał raportów')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  ];
}

async function registerCommands(client, guildId) {
  const payload = buildCommands().map(c => c.toJSON());
  if (guildId) await client.application.commands.set(payload, guildId);
  else await client.application.commands.set(payload);
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

async function handleCommand(interaction, storage) {
  const { commandName } = interaction;

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

  if (!isAdmin(interaction)) {
    await interaction.reply({ content: '❌ Ta komenda jest tylko dla admina (Manage Server).', ephemeral: true });
    return;
  }

  if (commandName === 'add_player') {
    const nick = interaction.options.getString('nick', true);
    const result = storage.addPlayer(nick);
    await interaction.reply({ content: result.ok ? `✅ Dodano gracza: ${result.nick}` : `⚠️ ${result.reason}`, ephemeral: true });
    return;
  }

  if (commandName === 'remove_player') {
    const nick = interaction.options.getString('nick', true);
    const result = storage.removePlayer(nick);
    await interaction.reply({ content: result.ok ? `✅ Usunięto gracza: ${result.nick}` : `⚠️ ${result.reason}`, ephemeral: true });
    return;
  }

  if (commandName === 'set_channel') {
    storage.setChannelId(interaction.channelId);
    await interaction.reply({ content: `✅ Ustawiono kanał raportów na <#${interaction.channelId}>`, ephemeral: true });
  }
}

module.exports = {
  registerCommands,
  handleCommand
};
