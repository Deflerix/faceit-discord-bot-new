const matchLogger = require('./matchLogger');

function getPlayerEloHistory(player_id, limit = 30) {
  try {
    return matchLogger.getPlayerEloHistoryRows(player_id, limit)
      .filter(point => Number.isFinite(point.timestamp) && Number.isFinite(point.elo));
  } catch (err) {
    console.error(`[ELO] Failed to load ELO history for ${player_id}: ${err.message}`);
    return [];
  }
}

module.exports = {
  getPlayerEloHistory
};
