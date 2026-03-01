require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
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
  console.log(`[DEBUG] Pobieram dane gracza: ${nick}`);
  const res = await axios.get(
    `https://open.faceit.com/data/v4/players?nickname=${nick}`,
    { headers: { Authorization: `Bearer ${FACEIT_API_KEY}` } }
  );
  return res.data;
}

async function getLastMatch(playerId) {
  console.log(`[DEBUG] Pobieram ostatni mecz dla playerId: ${playerId}`);
  const res = await axios.get(
    `https://open.faceit.com/data/v4/players/${playerId}/history?game=cs2&limit=1`,
    { headers: { Authorization: `Bearer ${FACEIT_API_KEY}` } }
  );
  return res.data.items[0];
}

async function getMatchStats(matchId) {
  console.log(`[DEBUG] Pobieram statystyki meczu: ${matchId}`);
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

function buildEmbed(nick, map, score, oldElo, currentElo, eloChange, players) {
  return new EmbedBuilder()
    .setTitle(`Nowy mecz FACEIT (CS2) - ${nick}`)
    .addFields(
      { name: "Mapa", value: map, inline: true },
      { name: "Wynik", value: score, inline: true },
      { name: "ELO", value: `${oldElo} → ${currentElo} (${eloChange >= 0 ? "+" : ""}${eloChange})` }
    )
    .setDescription(formatPlayers(players))
    .setTimestamp()
    .setColor(eloChange >= 0 ? 0x2ecc71 : 0xe74c3c);
}

async function processMatch(nick, forceSend = false, interaction = null) {
  try {
    console.log(`\n[CHECK ${new Date().toLocaleTimeString()}] ${nick}`);

    const player = await getPlayer(nick);
    const lastMatch = await getLastMatch(player.player_id);

    if (!lastMatch) {
      console.log(`[INFO] Brak meczów dla ${nick}`);
      return;
    }

    if (checkedMatches.has(lastMatch.match_id) && !forceSend) {
      console.log(`[INFO] Mecz ${lastMatch.match_id} już był wysłany.`);
      return;
    }

    const stats = await getMatchStats(lastMatch.match_id);
    const round = stats?.rounds?.[0];

    if (!round) {
      console.log(`[WARN] Brak rund w statystykach meczu ${lastMatch.match_id}`);
      return;
    }

    const map = round?.round_stats?.Map || "-";
    const score = round?.round_stats?.Score || "-";

    const currentElo = Number(player?.games?.cs2?.faceit_elo ?? 0);
    const oldElo = Number(playerCache[nick] ?? currentElo);
    const eloChange = currentElo - oldElo;

    playerCache[nick] = currentElo;

    let playersToShow = [];
    if (MODE === "ALL") {
      playersToShow = (round.teams || []).flatMap(t => t.players || []);
    } else {
      const team = (round.teams || []).find(t =>
        (t.players || []).some(p => p.nickname?.toLowerCase() === nick.toLowerCase())
      );
      if (!team) {
        console.log(`[WARN] Nie znaleziono drużyny gracza ${nick} w meczu ${lastMatch.match_id}`);
        return;
      }
      playersToShow = team.players || [];
    }

    // Normalizacja statystyk pod embed (żeby nie było undefined).
    playersToShow = playersToShow.map(p => {
      const s = p.player_stats || {};
      return {
        ...p,
        player_stats: {
          ...s,
          Kills: s.Kills ?? "-",
          Deaths: s.Deaths ?? "-",
          "K/D Ratio": s["K/D Ratio"] ?? "-",
          "Average Damage per Round": s["Average Damage per Round"] ?? "-",
          "Headshots %": s["Headshots %"] ?? "-"
        }
      };
    });

    const embed = buildEmbed(nick, map, score, oldElo, currentElo, eloChange, playersToShow);
    const mention = getMention(nick);

    // Kluczowa poprawka: ten sam payload (ping + embed) dla auto tick i /checkmatch.
    const messagePayload = {
      content: mention ? `${mention}` : "",
      embeds: [embed]
    };

    if (interaction) {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(messagePayload);
      } else {
        await interaction.reply(messagePayload);
      }
    } else {
      const channel = await client.channels.fetch(CHANNEL_ID);
      if (!channel || !channel.isTextBased()) {
        console.log(`[ERROR] Nieprawidłowy kanał docelowy: ${CHANNEL_ID}`);
        return;
      }

      await channel.send(messagePayload);

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

  await checkMatches(); // natychmiastowe sprawdzenie po starcie
  setInterval(checkMatches, interval); // cykliczne sprawdzanie
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
