// ================= DEBUG ŚRODOWISKA =================
console.log("=== ROZPOCZYNAM URUCHOMIENIE BOTA NA RENDER ===");
console.log("Node version:", process.version);
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("PORT:", process.env.PORT);

const criticalVars = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN ? `✅ ISTNIEJE (${process.env.DISCORD_TOKEN.length} znaków)` : "❌ BRAK",
  FACEIT_API_KEY: process.env.FACEIT_API_KEY ? "✅ ISTNIEJE" : "❌ BRAK",
  CHANNEL_ID: process.env.CHANNEL_ID || "❌ BRAK",
  FACEIT_NICKS: process.env.FACEIT_NICKS || "❌ BRAK",
  GUILD_ID: process.env.GUILD_ID || "nie ustawione"
};
console.table(criticalVars);

if (!process.env.DISCORD_TOKEN) {
  console.error("❌ KRRYTYCZNY BŁĄD: Brak DISCORD_TOKEN!");
}

// Tylko lokalnie wczytujemy .env
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
  console.log("✅ dotenv wczytany lokalnie");
} else {
  console.log("Produkcja - dotenv pominięty");
}

// ================= IMPORTY =================
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const express = require('express');

// ================= KEEP ALIVE =================
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(port, () => console.log(`Server running on port ${port}`));

// ================= CLIENT Z POPRAWIONYMI INTENTS =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,     // ważne przy slash commands i rejestracji
    GatewayIntentBits.GuildMessages    // na wszelki wypadek
  ]
});

console.log("✅ Client utworzony z intents: Guilds + GuildMembers + GuildMessages");

// ================= ZMIENNE =================
const { DISCORD_TOKEN, FACEIT_API_KEY, CHANNEL_ID, CHECK_INTERVAL, FACEIT_NICKS, GUILD_ID } = process.env;

const nicknames = (FACEIT_NICKS || '').split(',').map(n => n.trim()).filter(Boolean);

let checkedMatches = new Set();
let playerCache = {};
let eloCache = {};
let lastImage = null;
let leaderboard = {};

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

// ================= FACEIT + HELPERS (bez zmian) =================
// ... (cała reszta Twoich funkcji: getPlayer, getLastMatch, getMatchStats, getMention, formatPlayerStats itd.)
// Wklej tutaj wszystkie funkcje bez zmian (getTeamScore, getTopFragger, getElProfesore, getRandomImage, processMatch)

// ================= READY (przeniesione przed login) =================
client.once('ready', async () => {
  console.log(`✅ ZALOGOWANO JAKO ${client.user.tag} (${client.user.id})`);
  console.log(`Na serwerach: ${client.guilds.cache.size}`);

  loadMatches();
  loadLeaderboard();

  try {
    const commands = [
      new SlashCommandBuilder().setName('zmecz_zweiha').setDescription('Zlicza zmeczenie Zweiha'),
      new SlashCommandBuilder().setName('leaderboard').setDescription('Pokazuje ranking zmeczeń')
    ];

    for (const c of commands) {
      await client.application.commands.create(c, GUILD_ID);
      console.log(`✅ Polecenie ${c.name} zarejestrowane na guild ${GUILD_ID}`);
    }
  } catch (err) {
    console.error("Błąd rejestracji slash commands:", err.message);
  }

  setInterval(() => processMatch(), Number(CHECK_INTERVAL) || 180000);
  console.log(`Interval do sprawdzania meczów ustawiony co ${Number(CHECK_INTERVAL) || 180000} ms`);
});

// ================= INTERACTION (bez zmian) =================
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
});

// ================= GLOBALNE HANDLERY BŁĘDÓW =================
client.on('error', err => console.error('Client error:', err));
client.on('shardError', err => console.error('Shard error:', err));

process.on('unhandledRejection', error => {
  console.error('❌ Nieobsłużony błąd (unhandledRejection):', error);
});

process.on('uncaughtException', error => {
  console.error('❌ Nieobsłużony wyjątek (uncaughtException):', error);
});

// ================= LOGIN (na samym końcu!) =================
client.login(DISCORD_TOKEN)
  .then(() => {
    console.log("✅ client.login() zakończone pomyślnie – czekam na ready...");
  })
  .catch(err => {
    console.error("❌ BŁĄD LOGOWANIA:", err.message);
    if (err.message.includes("401") || err.message.includes("token")) {
      console.error("→ Token jest nieprawidłowy lub wygasł. Zresetuj go w Discord Developer Portal.");
    } else if (err.message.includes("disallowed intent")) {
      console.error("→ Włącz Privileged Gateway Intents w Discord Developer Portal (Server Members Intent itp.)");
    }
  });
