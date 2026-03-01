require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const express = require("express"); // <- dodane keep-alive

// ===== Express keep-alive =====
const app = express();
const port = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Bot is alive!"));
app.listen(port, () => console.log(`Keep-alive server running on port ${port}`));

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const {
  DISCORD_TOKEN,
  FACEIT_API_KEY,
  CHANNEL_ID,
  CHECK_INTERVAL,
  MODE,
  FACEIT_NICKS
} = process.env;

const nicknames = FACEIT_NICKS.split(',').map(n => n.trim());
let checkedMatches = new Set();
let playerCache = {};

const saveMatches = () => {
  fs.writeFileSync('matches.json', JSON.stringify([...checkedMatches]));
};

const loadMatches = () => {
  if (fs.existsSync('matches.json')) {
    checkedMatches = new Set(JSON.parse(fs.readFileSync('matches.json')));
  }
};

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

function formatPlayers(players) {
  return players.map(p => {
    const s = p.player_stats;
    return `**${p.nickname}**
K/D: ${s.Kills}/${s.Deaths} (${s["K/D Ratio"]})
ADR: ${s["Average Damage per Round"]}
HS%: ${s["Headshots %"]}`;
  }).join('\n\n');
}

async function checkMatches() {
  try {
    for (const nick of nicknames) {
      const player = await getPlayer(nick);
      const lastMatch = await getLastMatch(player.player_id);
      if (!lastMatch) continue;

      if (checkedMatches.has(lastMatch.match_id)) continue;

      const stats = await getMatchStats(lastMatch.match_id);
      if (!stats.rounds || !stats.rounds[0]) continue;

      const round = stats.rounds[0];
      const map = round.round_stats.Map;
      const score = round.round_stats.Score;

      const currentElo = player.games.cs2.faceit_elo;
      const oldElo = playerCache[nick] || currentElo;
      const eloChange = currentElo - oldElo;

      playerCache[nick] = currentElo;

      let playersToShow = [];

      if (MODE === "ALL") {
        playersToShow = round.teams.flatMap(t => t.players);
      } else {
        const team = round.teams.find(team =>
          team.players.some(p =>
            p.nickname.toLowerCase() === nick.toLowerCase()
          )
        );
        if (!team) continue;
        playersToShow = team.players;
      }

      const embed = new EmbedBuilder()
        .setTitle("Nowy mecz FACEIT (CS2)")
        .addFields(
          { name: "Mapa", value: map, inline: true },
          { name: "Wynik", value: score, inline: true },
          { name: "ELO", value: `${oldElo} → ${currentElo} (${eloChange >= 0 ? "+" : ""}${eloChange})`, inline: false }
        )
        .setDescription(formatPlayers(playersToShow))
        .setTimestamp()
        .setColor(eloChange >= 0 ? 0x2ecc71 : 0xe74c3c);

      const channel = await client.channels.fetch(CHANNEL_ID);

      await channel.send({
        content: getMention(nick),
        embeds: [embed]
      });

      checkedMatches.add(lastMatch.match_id);
      saveMatches();

      console.log(`Wysłano mecz: ${lastMatch.match_id}`);
    }

  } catch (err) {
    console.error("Błąd:", err.response?.data || err.message);
  }
}

client.once('ready', () => {
  console.log(`Zalogowano jako ${client.user.tag}`);
  loadMatches();
  setInterval(checkMatches, Number(CHECK_INTERVAL));
});

client.login(DISCORD_TOKEN);
