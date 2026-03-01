require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  SlashCommandBuilder 
} = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const express = require("express");

// ================= KEEP ALIVE =================
const app = express();
const port = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Bot is alive!"));
app.listen(port, () => console.log(`[KEEP-ALIVE] Server running on port ${port}`));
// =============================================

// ================= ENV DEBUG =================
console.log("=== ENV DEBUG START ===");
console.log("CHANNEL_ID:", process.env.CHANNEL_ID);
console.log("GUILD_ID:", process.env.GUILD_ID);
console.log("FACEIT_NICKS:", process.env.FACEIT_NICKS);
console.log("========================");
// =============================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const {
  DISCORD_TOKEN,
  FACEIT_API_KEY,
  CHANNEL_ID,
  CHECK_INTERVAL,
  MODE,
  FACEIT_NICKS,
  GUILD_ID
} = process.env;

if (!FACEIT_NICKS) {
  console.error("❌ FACEIT_NICKS nie jest ustawione w ENV");
  process.exit(1);
}

const nicknames = FACEIT_NICKS.split(',').map(n => n.trim());
let checkedMatches = new Set();
let playerCache = {}; // przechowuje aktualne ELO gracza po ostatnim meczu

const saveMatches = () => {
  fs.writeFileSync('matches.json', JSON.stringify([...checkedMatches]));
};

const loadMatches = () => {
  if (fs.existsSync('matches.json')) {
    checkedMatches = new Set(JSON.parse(fs.readFileSync('matches.json')));
  }
};

// ================== FACEIT API =================
async function getPlayer(nick) {
  const res = await axios.get(
    `https://open.faceit.com/data/v4/players?nickname=${nick}`,
    { headers: { Authorization: `Bearer ${FACEIT_API_KEY}` } }
  );
  return res.data;
}

async function getLastMatch(playerId) {
  const res = await axios.get(
    `https://open.faceit.com/data/v4/players/${playerId}/history?game=cs2&limit=1`,
    { headers: { Authorization: `Bearer ${FACEIT_API_KEY}` } }
  );
  return res.data.items[0];
}

async function getMatchStats(matchId) {
  const res = await axios.get(
    `https://open.faceit.com/data/v4/matches/${matchId}/stats`,
    { headers: { Authorization: `Bearer ${FACEIT_API_KEY}` } }
  );
  return res.data;
}

function getMention(nick) {
  const id = process.env[`MENTION_${nick}`];
  return id ? `<@${id}>` : nick;
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth()+1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2,'0');
  const minutes = String(d.getMinutes()).padStart(2,'0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

// ================== PROCESS MATCH =================
async function processMatch(nick, forceSend = false, interaction = null) {
  try {
    console.log(`\n[CHECK ${new Date().toLocaleTimeString()}] ${nick}`);

    const player = await getPlayer(nick);
    const lastMatch = await getLastMatch(player.player_id);
    if (!lastMatch) return;

    if (checkedMatches.has(lastMatch.match_id) && !forceSend) {
      console.log(`[INFO] Mecz ${lastMatch.match_id} już był wysłany.`);
      return;
    }

    console.log(`[INFO] Nowy mecz wykryty: ${lastMatch.match_id}`);

    const stats = await getMatchStats(lastMatch.match_id);
    if (!stats.rounds || !stats.rounds[0]) return;

    const round = stats.rounds[0];
    const map = round.round_stats.Map;
    const score = round.round_stats.Score;

    // drużyna gracza
    const team = round.teams.find(t =>
      t.players.some(p => p.nickname.toLowerCase() === nick.toLowerCase())
    );
    if (!team) return;

    // aktualne ELO śledzonych graczy
    const trackedNicks = ["Deflerix", "W4KKY", "pawik100737"];
    let eloLines = [];
    for (const n of trackedNicks) {
      const pData = await getPlayer(n);
      const cur = pData.games.cs2.faceit_elo || 0;
      const old = playerCache[n] || cur; // jeśli brak w cache, używa aktualnego
      playerCache[n] = cur; // zapisuje aktualne jako poprzednie na przyszłość
      eloLines.push(`-${n} ${old} → ${cur}`);
    }
    eloLines = eloLines.join("\n");

    // Data wydarzenia
    const eventTime = formatDate(lastMatch.finished_at || lastMatch.started_at || Date.now());

    // Mentions
    const mentions = trackedNicks.map(n => getMention(n)).join(' ');

    // Statystyki drużyny gracza
    const playersStats = team.players.map(p => {
      const s = p.player_stats || {};
      return `${p.nickname} K/D: ${s.Kills || 0}/${s.Deaths || 0} K/Dśr: ${s["K/D Ratio"] || "-"} ADR: ${s["Average Damage per Round"] || "-"} HS%: ${s["Headshots %"] || "-"}`;
    }).join("\n");

    const message = `📊 Raport z Faceit ${mentions}
📅 Data wydarzenia: ${eventTime}
🎯 Wynik: ${score}
🌍 Mapa: ${map}
📈 Zmiana ELO:
${eloLines}

📋 Statystyki graczy:
${playersStats}`;

    if (interaction) {
      await interaction.reply({ content: message });
    } else {
      const channel = await client.channels.fetch(CHANNEL_ID);
      if (!channel) {
        console.log(`[ERROR] Nie znaleziono kanału o ID ${CHANNEL_ID}`);
        return;
      }
      await channel.send({ content: message });
      checkedMatches.add(lastMatch.match_id);
      saveMatches();
    }

    console.log(`[SUCCESS] Wysłano mecz ${lastMatch.match_id}`);

  } catch (err) {
    console.error("[ERROR] Błąd podczas przetwarzania meczu:", err.response?.data || err.message);
  }
}

// ================= AUTO CHECK =================
async function checkMatches() {
  console.log(`\n[TICK] ${new Date().toLocaleTimeString()}`);
  for (const nick of nicknames) {
    await processMatch(nick);
  }
}
// =============================================

// ================= READY =================
client.once('ready', async () => {
  console.log(`Zalogowano jako ${client.user.tag}`);
  loadMatches();

  const command = new SlashCommandBuilder()
    .setName('checkmatch')
    .setDescription('Sprawdza ostatni mecz gracza')
    .addStringOption(option =>
      option.setName('nick')
        .setDescription('Nick FACEIT')
        .setRequired(true)
    );

  if (GUILD_ID) {
    await client.application.commands.create(command, GUILD_ID);
    console.log("[INFO] Komenda /checkmatch (guild) zarejestrowana");
  } else {
    await client.application.commands.create(command);
    console.log("[INFO] Komenda /checkmatch (global) zarejestrowana");
  }

  const interval = Number(CHECK_INTERVAL) || 180000;
  console.log(`[INFO] Interval ustawiony na ${interval} ms`);

  await checkMatches();
  setInterval(checkMatches, interval);
});
// =============================================

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'checkmatch') {
    const nick = interaction.options.getString('nick');
    await processMatch(nick, true, interaction);
  }
});

client.login(DISCORD_TOKEN);
