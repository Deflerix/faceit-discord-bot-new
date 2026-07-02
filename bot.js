require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const { Storage } = require('./storage');
const { createFaceitService } = require('./faceit');
const { processMatches } = require('./matchProcessor');
const { registerCommands, handleCommand } = require('./commands');
const matchLogger = require('./services/matchLogger');

const {
  DISCORD_TOKEN,
  FACEIT_API_KEY,
  CHANNEL_ID,
  CHECK_INTERVAL,
  FACEIT_NICKS,
  GUILD_ID,
  PORT
} = process.env;

const fallbackPlayers = (FACEIT_NICKS || '').split(',').map(v => v.trim()).filter(Boolean);
const storage = new Storage({ playersFromEnv: fallbackPlayers, matchLogger });
const faceit = createFaceitService(FACEIT_API_KEY);
const eloCache = {};

const app = express();
app.get('/', (_req, res) => res.send('Bot is alive!'));
app.listen(PORT || 3000, () => console.log(`Server running on port ${PORT || 3000}`));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function tick() {
  try {
    await processMatches({
      client,
      storage,
      faceit,
      defaultChannelId: CHANNEL_ID,
      eloCache,
      matchLogger
    });
  } catch (err) {
    console.error(`[TICK ERROR] ${err.message}`);
  }
}

client.once('ready', async () => {
  console.log(`Zalogowano jako ${client.user.tag}`);
  try {
    matchLogger.initDatabase();
    await storage.syncLegacyPlayers(faceit);
    await registerCommands(client, GUILD_ID);
    console.log('[INFO] Komendy slash zarejestrowane.');
  } catch (err) {
    console.error(`[ERROR] Rejestracja komend nie powiodła się: ${err.message}`);
  }

  await tick();
  setInterval(tick, Number(CHECK_INTERVAL) || 180000);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleCommand(interaction, storage, { faceit, matchLogger });
  } catch (err) {
    console.error(`[COMMAND ERROR] ${err.message}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Wystąpił błąd podczas wykonywania komendy.', ephemeral: true });
    }
  }
});

client.on('error', err => console.error('Discord Client Error:', err));
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

if (!DISCORD_TOKEN) {
  console.error('❌ Brak DISCORD_TOKEN.');
  process.exit(1);
}
if (!FACEIT_API_KEY) {
  console.error('❌ Brak FACEIT_API_KEY.');
  process.exit(1);
}

client.login(DISCORD_TOKEN).catch(err => {
  console.error(`❌ Błąd logowania: ${err.message}`);
  process.exit(1);
});
