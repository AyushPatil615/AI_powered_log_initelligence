const path = require('path');
const { parseLogFile } = require('../parsers/logParser');

// ─── In-memory store ───────────────────────────────────────────────
// Logs are parsed once at startup and stored here.
// No database is used — all processing is done in memory.
// ───────────────────────────────────────────────────────────────────

let logs = [];       // All parsed log objects
let isLoaded = false;

const LOG_FILE_PATH = path.resolve(__dirname, '../../dataset/Apache_2k.log');

/**
 * Loads and parses the log file into memory.
 * Should be called once when the server starts.
 */
function loadLogs() {
  if (isLoaded) {
    console.log('[inMemoryStore] Logs already loaded. Skipping.');
    return;
  }

  logs = parseLogFile(LOG_FILE_PATH);
  isLoaded = true;
  console.log('[inMemoryStore] Logs loaded into memory. Total: ' + logs.length);
}

/**
 * Returns all logs.
 */
function getAllLogs() {
  return logs;
}

/**
 * Returns logs filtered by level ('error' or 'notice').
 */
function getLogsByLevel(level) {
  return logs.filter(function (log) {
    return log.level === level.toLowerCase();
  });
}

/**
 * Returns logs filtered by category.
 * Categories: Startup, Shutdown, Configuration, Worker Initialization,
 * Backend Communication, Warning, Error, Performance, Security, Unknown
 */
function getLogsByCategory(category) {
  return logs.filter(function (log) {
    return log.category === category;
  });
}

/**
 * Searches logs where the message contains the given keyword (case-insensitive).
 */
function searchLogs(keyword) {
  const kw = keyword.toLowerCase();
  return logs.filter(function (log) {
    return log.message.toLowerCase().includes(kw);
  });
}

/**
 * Returns a summary of the loaded logs.
 * Useful for the frontend dashboard and API health checks.
 */
function getStats() {
  const errorCount    = logs.filter(function (l) { return l.level === 'error'; }).length;
  const noticeCount   = logs.filter(function (l) { return l.level === 'notice'; }).length;
  const unknownCount  = logs.filter(function (l) { return l.level === 'unknown'; }).length;

  // Count unique client IPs
  const ips = logs
    .filter(function (l) { return l.clientIp !== null; })
    .map(function (l) { return l.clientIp; });
  const uniqueIps = [...new Set(ips)];

  // Category breakdown
  const categories = {};
  logs.forEach(function (log) {
    categories[log.category] = (categories[log.category] || 0) + 1;
  });

  return {
    total:        logs.length,
    errorCount:   errorCount,
    noticeCount:  noticeCount,
    unknownCount: unknownCount,
    uniqueClientIps: uniqueIps.length,
    categoryBreakdown: categories,
    timeRange: {
      first: logs[0]?.timestamp || null,
      last:  logs[logs.length - 1]?.timestamp || null
    }
  };
}

module.exports = {
  loadLogs,
  getAllLogs,
  getLogsByLevel,
  getLogsByCategory,
  searchLogs,
  getStats
};
