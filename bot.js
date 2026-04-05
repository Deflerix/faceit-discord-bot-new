require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const express = require("express");

// ================= KEEP ALIVE =================
const app = express();
const port = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Bot is alive!"));
app.listen(port, () => console.log(`Server running on port ${port}`));
// =============================================

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const { DISCORD_TOKEN, FACEIT_API_KEY, CHANNEL_ID, CHECK_INTERVAL, FACEIT_NICKS, GUILD_ID } = process.env;
const nicknames = FACEIT_NICKS.split(',').map(n => n.trim());

let checkedMatches = new Set();
let playerCache = {};
let lastImage = null;

// ================= AXIOS =================
const api = axios.create({ timeout: 5000, headers: { Authorization: `Bearer ${FACEIT_API_KEY}` } });

// ================= FILE STORAGE =================
const saveMatches = () => fs.writeFileSync('matches.json', JSON.stringify([...checkedMatches].slice(-100)));
const loadMatches = () => { if (fs.existsSync('matches.json')) checkedMatches = new Set(JSON.parse(fs.readFileSync('matches.json'))); };

// ================= FACEIT =================
async function getPlayer(nick) {
    if (playerCache[nick]) return playerCache[nick];
    const res = await api.get(`https://open.faceit.com/data/v4/players?nickname=${nick}`);
    playerCache[nick] = res.data;
    return res.data;
}

async function getLastMatch(playerId) {
    const res = await api.get(`https://open.faceit.com/data/v4/players/${playerId}/history?game=cs2&limit=1`);
    return res.data.items?.[0];
}

async function getMatchStats(matchId) {
    const res = await api.get(`https://open.faceit.com/data/v4/matches/${matchId}/stats`);
    return res.data;
}

// ================= HELPERS =================
function getMention(nick) { const id = process.env[`MENTION_${nick}`]; return id ? `<@${id}>` : nick; }

function formatPlayerStats(players = []) {
    return players.map(p => {
        const s = p.player_stats || {};
        const kd = Number(s["K/D Ratio"]) || 0;
        return `${p.nickname.padEnd(12)} | ${s.Kills||0}/${s.Deaths||0} | ${kd.toFixed(2)} | HS:${s["Headshots %"]||"-"}`;
    }).join("\n");
}

function getTeamScore(round, ourTeam) {
    const [s1, s2] = (round.round_stats?.Score || "0/0").split("/").map(Number);
    const [team1, team2] = round.teams;
    return ourTeam === team1 ? { our: s1, enemy: s2 } : { our: s2, enemy: s1 };
}

function getTopFragger(players) {
    return players.reduce((best, p) => { 
        const kills = Number(p.player_stats?.Kills || 0); 
        return kills > best.kills ? { nick: p.nickname, kills } : best; 
    }, { nick: "?", kills: -1 });
}

function getElProfesore(players) {
    const target = ["deflerix", "w4kky", "pawik"];
    let filtered = players.filter(p => target.includes(p.nickname.toLowerCase()));
    if (!filtered.length) filtered = players;
    return filtered.reduce((worst, p) => { 
        const kills = Number(p.player_stats?.Kills || 0); 
        return kills < worst.kills ? { nick: p.nickname, kills } : worst; 
    }, { nick: "?", kills: Infinity });
}

function getRandomImage(isWin) {
    const images = isWin
        ? [process.env.IMAGE_WIN_1, process.env.IMAGE_WIN_2, process.env.IMAGE_WIN_3]
        : [process.env.IMAGE_LOSE_1, process.env.IMAGE_LOSE_2, process.env.IMAGE_LOSE_3];
    const valid = images.filter(Boolean).filter(img => img !== lastImage);
    if (!valid.length) valid.push(...images.filter(Boolean));
    const selected = valid[Math.floor(Math.random() * valid.length)];
    lastImage = selected;
    return selected;
}

// ================= MATCH =================
async function processMatch(nick, forceSend = false, interaction = null) {
    try {
        const player = await getPlayer(nick);
        const lastMatch = await getLastMatch(player.player_id);
        if (!lastMatch) return;
        if (checkedMatches.has(lastMatch.match_id) && !forceSend) return;

        const stats = await getMatchStats(lastMatch.match_id);  
        const round = stats.rounds?.[0];  
        if (!round) return;  

        const ourTeam = round.teams?.find(t => t.players?.some(p => p.nickname.toLowerCase() === nick.toLowerCase()));  
        if (!ourTeam) return;  
        const enemyTeam = round.teams.find(t => t !== ourTeam);  

        const { our, enemy } = getTeamScore(round, ourTeam);  
        const isWin = our > enemy;  

        const resultText = `${isWin ? "🟢 WIN" : "🔴 LOSE"} | ${our}:${enemy}`;  
        const top = getTopFragger(ourTeam.players);  
        const profesore = getElProfesore(ourTeam.players);  

        let eloLines = "";  
        for (const n of nicknames) {  
            try {  
                const p = await getPlayer(n);  
                const elo = p.games?.cs2?.faceit_elo || 0;  
                const prev = playerCache[n]?.lastElo ?? "X";  
                eloLines += `-${n} ${prev} → ${elo}\n`;  
                playerCache[n].lastElo = elo;  
            } catch { eloLines += `-${n} brak danych\n`; }  
        }  

        const mentions = nicknames.map(getMention).join(' ');  
        const image = getRandomImage(isWin);  

        const message = `📊 Raport ${mentions}

📅 Data: ${new Date((lastMatch.finished_at||lastMatch.started_at||Date.now())*1000).toLocaleString('pl-PL',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}
${resultText}
🌍 Mapa: ${round.round_stats.Map}
🐐 GOAT: ${top.nick} (${top.kills})
🚑 PROFESORE: ${profesore.nick} (${profesore.kills})

📈 ELO:
${eloLines}
📋 OUR:
${formatPlayerStats(ourTeam.players)}

📋 ENEMY:
${formatPlayerStats(enemyTeam?.players)}`;

        if (interaction) await interaction.reply({ content: message, files: image ? [image] : [] });  
        else {  
            const channel = await client.channels.fetch(CHANNEL_ID);  
            if (!channel) return;  
            await channel.send({ content: message, files: image ? [image] : [] });  
            checkedMatches.add(lastMatch.match_id);  
            saveMatches();  
        }

    } catch (err) { console.error(err.message); }
}

// ================= READY =================
client.once('ready', async () => {
    console.log(`Zalogowano jako ${client.user.tag}`);
    loadMatches();

    // Tworzenie komend Slash
    const commands = [
        new SlashCommandBuilder()
            .setName('checkmatch')
            .setDescription('Sprawdza mecz')
            .addStringOption(o => o.setName('nick').setRequired(true))
    ];
    for (const c of commands) await client.application.commands.create(c, GUILD_ID);

    // ===== Wyślij pierwszy mecz przy starcie i oznacz jako wysłany =====
    for (const nick of nicknames) {
        try {
            const player = await getPlayer(nick);
            const lastMatch = await getLastMatch(player.player_id);
            if (!lastMatch) continue;
            if (!checkedMatches.has(lastMatch.match_id)) {
                await processMatch(nick, true); // forceSend = true
                checkedMatches.add(lastMatch.match_id);
                saveMatches();
            }
        } catch (err) { console.error(err.message); }
    }

    // Cykliczne sprawdzanie meczy
    setInterval(() => { nicknames.forEach(n => processMatch(n)); }, Number(CHECK_INTERVAL) || 180000);
});

// ================= INTERACTION =================
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'checkmatch') {
        const nick = interaction.options.getString('nick');
        await processMatch(nick, true, interaction);
    }
});

client.login(DISCORD_TOKEN);
