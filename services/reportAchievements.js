function getReportAchievements(player) {
    const achievements = [];

    const {
        kills,
        deaths,
        hs,
        kd,
        mvp,
        elo_delta,
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

    return achievements;
}

module.exports = {
    getReportAchievements
};
