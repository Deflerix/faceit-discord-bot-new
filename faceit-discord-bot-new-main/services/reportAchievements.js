/* =========================
   ODZNAKI ZA POJEDYNCZY MECZ
========================= */
function getReportAchievements(player) {
    const achievements = [];

    const {
        kills = 0,
        deaths = 0,
        assists = 0,
        hs = 0,
        kd = 0,
        adr = 0,
        quadro = 0,
        penta = 0,
        mvp,
        elo_delta = 0,
        result
    } = player;

    const hsPercent = hs || 0;

    if (result === "win" && kills >= 25) achievements.push("🔥 Carry");
    if (hsPercent >= 75) achievements.push("🎯 Aim God");
    if (result === "loss" && kills <= 10) achievements.push("💀 Disaster");
    if (mvp) achievements.push("👑 MVP");
    if (elo_delta >= 25) achievements.push("📈 Elo Boost");
    if (elo_delta <= -25) achievements.push("📉 Throw Game");
    if (kd >= 1.8) achievements.push("⚡ Impact Player");

    // nowe
    if (penta >= 1) achievements.push("🖐️ Ace");
    else if (quadro >= 1) achievements.push("4️⃣ Quadro Kill");
    if (adr >= 100) achievements.push("💥 Damage Dealer");
    if (assists >= 10) achievements.push("🤝 Support God");
    if (result === "win" && deaths <= 5 && kills >= 10) achievements.push("🧱 Unkillable");
    if (result === "loss" && deaths >= 25) achievements.push("⚰️ Feeder");

    return achievements;
}

/* =========================
   NAGRODY ZA CAŁY GRIND
   players = tablica zagregowanych statystyk graczy
   (patrz aggregateGrind w services/grindReport.js)
========================= */
function maxBy(arr, score) {
    return arr.reduce((best, p) => (best === null || score(p) > score(best) ? p : best), null);
}

function getGrindAwards(players = []) {
    if (!players.length) return [];

    const awards = [];

    const mvp = maxBy(players, p => p.topFrags * 1000 + p.kd);
    awards.push({
        label: "👑 MVP Grindu",
        nick: mvp.nick,
        detail: `${mvp.topFrags}× top frag • K/D ${mvp.kd.toFixed(2)}`
    });

    // reszta ma sens dopiero gdy jest z kim porównywać
    if (players.length < 2) return awards;

    const bestKd = maxBy(players, p => p.kd);
    awards.push({ label: "🧱 Najlepsze K/D", nick: bestKd.nick, detail: bestKd.kd.toFixed(2) });

    const mostKills = maxBy(players, p => p.kills);
    awards.push({ label: "🔫 Najwięcej killi", nick: mostKills.nick, detail: String(mostKills.kills) });

    const hsPool = players.filter(p => p.kills >= 10);
    const bestHs = hsPool.length ? maxBy(hsPool, p => p.hs) : null;
    if (bestHs && bestHs.hs > 0) {
        awards.push({ label: "🎯 Headshot Machine", nick: bestHs.nick, detail: `${bestHs.hs.toFixed(1)}%` });
    }

    const adrPool = players.filter(p => p.adr !== null);
    const bestAdr = adrPool.length ? maxBy(adrPool, p => p.adr) : null;
    if (bestAdr) {
        awards.push({ label: "💥 Damage King", nick: bestAdr.nick, detail: `ADR ${bestAdr.adr.toFixed(1)}` });
    }

    const mostAssists = maxBy(players, p => p.assists);
    if (mostAssists.assists > 0) {
        awards.push({ label: "🤝 Support Grindu", nick: mostAssists.nick, detail: `${mostAssists.assists} asyst` });
    }

    const mostDeaths = maxBy(players, p => p.deaths);
    awards.push({ label: "⚰️ Feeder Grindu", nick: mostDeaths.nick, detail: `${mostDeaths.deaths} zgonów` });

    return awards;
}

module.exports = {
    getReportAchievements,
    getGrindAwards
};
