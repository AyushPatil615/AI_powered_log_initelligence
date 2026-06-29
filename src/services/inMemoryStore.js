const path    = require('path');
const { parseLogFile } = require('../parsers/logParser');
const cache   = require('./cacheService');

const DEFAULT_LOG_FILE = path.resolve(__dirname, '../../dataset/Apache_2k.log');

// ─── In-memory store ────────────────────────────────────────────────────────
// Logs are parsed ONCE at startup and stored here.
// No database is used — all processing is done in memory.
// ────────────────────────────────────────────────────────────────────────────

let logs            = [];
let isLoaded        = false;
let currentFilePath = DEFAULT_LOG_FILE;
let currentFileName = 'Apache_2k.log (sample)';

// Pre-computed indices — rebuilt on every load/reload for O(1) look-ups at request time
let _byLevel    = {};  // level  → Log[]
let _byCategory = {};  // category → Log[]
let _fingerprint = ''; // changes whenever the dataset changes — used as cache key prefix

// ─── Private: build indices ──────────────────────────────────────────────────
function _buildIndices() {
  _byLevel    = {};
  _byCategory = {};

  logs.forEach(function (log) {
    // Level index
    const lvl = log.level || 'unknown';
    if (!_byLevel[lvl]) _byLevel[lvl] = [];
    _byLevel[lvl].push(log);

    // Category index
    const cat = log.category || 'Unknown';
    if (!_byCategory[cat]) _byCategory[cat] = [];
    _byCategory[cat].push(log);
  });

  // Fingerprint: count + first + middle + last — prevents collision between
  // different datasets that share the same line count and boundary entries
  const mid = Math.floor(logs.length / 2);
  _fingerprint = String(logs.length) + '|' +
                 (logs[0]?.raw || '') + '|' +
                 (logs[mid]?.raw || '') + '|' +
                 (logs[logs.length - 1]?.raw || '');

  console.log('[inMemoryStore] Indices built. Fingerprint: ' + _fingerprint.substring(0, 60) + '...');
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Loads and parses the default log file into memory.
 * Should be called once when the server starts.
 */
function loadLogs() {
  if (isLoaded) {
    console.log('[inMemoryStore] Logs already loaded. Skipping.');
    return;
  }
  logs = parseLogFile(DEFAULT_LOG_FILE);
  currentFilePath = DEFAULT_LOG_FILE;
  currentFileName = 'Apache_2k.log (sample)';
  isLoaded = true;
  _buildIndices();
  console.log('[inMemoryStore] Logs loaded into memory. Total: ' + logs.length);
}

/**
 * Reloads logs from a new file path (e.g. after a user uploads a custom dataset).
 * Replaces the current in-memory store entirely and invalidates the AI response cache.
 *
 * @param {string} filePath - Absolute path to the new log file
 * @param {string} fileName - Display name shown in the UI
 */
function reloadLogs(filePath, fileName) {
  logs = parseLogFile(filePath);
  currentFilePath = filePath;
  currentFileName = fileName || path.basename(filePath);
  isLoaded = true;
  _buildIndices();
  cache.bust(); // Stale AI responses are no longer valid
  console.log('[inMemoryStore] Reloaded logs from: ' + fileName + '. Total: ' + logs.length);
}

/**
 * Returns the display name of the currently loaded dataset.
 * @returns {string}
 */
function getLoadedFileName() {
  return currentFileName;
}

/**
 * Returns a stable fingerprint of the current dataset.
 * Use this as a component of cache keys so stale cache entries are auto-skipped
 * after a dataset reload (cache.bust() already handles this, but the fingerprint
 * allows per-feature keys that survive unrelated updates in future).
 * @returns {string}
 */
function getFingerprint() {
  return _fingerprint;
}

/**
 * Returns all parsed log objects.
 * @returns {Object[]}
 */
function getAllLogs() {
  return logs;
}

/**
 * Returns logs filtered by level using the pre-built index (O(1) look-up).
 * @param {string} level - e.g. 'error', 'warn', 'notice', 'unknown'
 * @returns {Object[]}
 */
function getLogsByLevel(level) {
  return _byLevel[level.toLowerCase()] || [];
}

/**
 * Returns logs filtered by category using the pre-built index (O(1) look-up).
 * @param {string} category - e.g. 'Security', 'Error', 'Startup'
 * @returns {Object[]}
 */
function getLogsByCategory(category) {
  return _byCategory[category] || [];
}

/**
 * Searches logs where the message contains the given keyword (case-insensitive).
 * @param {string} keyword
 * @returns {Object[]}
 */
function searchLogs(keyword) {
  const kw = keyword.toLowerCase();
  return logs.filter(function (log) {
    return log.message.toLowerCase().includes(kw);
  });
}

/**
 * Returns a rich summary of the loaded logs.
 * Includes category breakdown and warn-level count (previously missing).
 * @returns {Object}
 */
function getStats() {
  const errorCount   = (_byLevel['error']   || []).length;
  const warnCount    = (_byLevel['warn']    || []).length;
  const noticeCount  = (_byLevel['notice']  || []).length;
  const unknownCount = (_byLevel['unknown'] || []).length;

  const ips = logs
    .filter(function (l) { return l.clientIp !== null; })
    .map(function (l) { return l.clientIp; });
  const uniqueIps = [...new Set(ips)];

  // Category breakdown from pre-built index
  const categories = {};
  Object.keys(_byCategory).forEach(function (cat) {
    categories[cat] = _byCategory[cat].length;
  });

  return {
    total:           logs.length,
    errorCount:      errorCount,
    warnCount:       warnCount,
    noticeCount:     noticeCount,
    unknownCount:    unknownCount,
    uniqueClientIps: uniqueIps.length,
    categoryBreakdown: categories,
    timeRange: {
      first: logs[0]?.timestamp    || null,
      last:  logs[logs.length - 1]?.timestamp || null
    }
  };
}

module.exports = {
  loadLogs,
  reloadLogs,
  getLoadedFileName,
  getFingerprint,
  getAllLogs,
  getLogsByLevel,
  getLogsByCategory,
  searchLogs,
  getStats
};
