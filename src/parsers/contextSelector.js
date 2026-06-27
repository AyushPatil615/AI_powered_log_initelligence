const { getAllLogs, getLogsByLevel, getLogsByCategory, searchLogs } = require('../services/inMemoryStore');

// ─────────────────────────────────────────────────────────────────────────────
// Context Selector
//
// This is the key piece of the architecture.
// The full log file (2000 lines) is NEVER sent to the LLM directly.
// Instead, this module picks only the most relevant logs for each API request.
//
// Why? Sending all 2000 lines would:
//   1. Exceed token limits
//   2. Slow down responses
//   3. Increase cost
//   4. Add noise that hurts AI accuracy
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LOGS_PER_REQUEST = 50; // Cap sent to LLM per API call

/**
 * Removes duplicate or near-duplicate log messages.
 * e.g. 500 lines of "mod_jk child workerEnv in error state 6" → keep only a few.
 *
 * @param {Array} logs
 * @param {number} maxPerMessage - Max times the same message can appear
 * @returns {Array}
 */
function deduplicate(logs, maxPerMessage) {
  const seen = {};
  const result = [];

  logs.forEach(function (log) {
    // Normalize message as the dedup key (strip trailing numbers/IDs)
    const key = log.message.replace(/\d+/g, '#');
    seen[key] = (seen[key] || 0) + 1;

    if (seen[key] <= maxPerMessage) {
      result.push(log);
    }
  });

  return result;
}

// ─────────────────────────────────────────────
// API 1: Log Classification Context
// Goal: Pick a representative sample of logs
// covering different levels and categories.
// ─────────────────────────────────────────────

/**
 * Selects context logs for the Classification API.
 * If specific log lines are provided in the request body, those are used.
 * Otherwise, a smart sample is pulled from the store.
 *
 * @param {string[]} [providedLogs] - Raw log strings from the API request body (optional)
 * @returns {Object[]} Array of log objects to send to the LLM
 */
function getClassificationContext(providedLogs) {
  // If the user passed specific logs in the request, parse and use those
  if (providedLogs && providedLogs.length > 0) {
    return providedLogs.slice(0, MAX_LOGS_PER_REQUEST).map(function (raw, i) {
      return { lineNumber: i + 1, raw: raw, message: raw };
    });
  }

  // Otherwise pick a smart sample from the in-memory store
  const allLogs = getAllLogs();

  // Take every Nth log to get an evenly spread sample
  const step = Math.floor(allLogs.length / MAX_LOGS_PER_REQUEST);
  const sample = [];
  for (let i = 0; i < allLogs.length; i += step) {
    sample.push(allLogs[i]);
    if (sample.length >= MAX_LOGS_PER_REQUEST) break;
  }

  return sample;
}

// ─────────────────────────────────────────────
// API 2: Incident Timeline Context
// Goal: Pick logs spread chronologically,
// with duplicates removed so events are distinct.
// ─────────────────────────────────────────────

/**
 * Selects context logs for the Incident Timeline API.
 * Picks logs spread across the full time range, deduplicating repeats.
 *
 * @returns {Object[]} Array of log objects to send to the LLM
 */
function getTimelineContext() {
  const allLogs = getAllLogs();

  // Sort by parsedDate (chronological order)
  const sorted = allLogs
    .filter(function (l) { return l.parsedDate !== null; })
    .sort(function (a, b) { return a.parsedDate - b.parsedDate; });

  // Deduplicate repeated messages (keep max 2 of each)
  const deduped = deduplicate(sorted, 2);

  // Take evenly spread sample across the full timeline
  const step = Math.max(1, Math.floor(deduped.length / MAX_LOGS_PER_REQUEST));
  const sample = [];
  for (let i = 0; i < deduped.length; i += step) {
    sample.push(deduped[i]);
    if (sample.length >= MAX_LOGS_PER_REQUEST) break;
  }

  return sample;
}

// ─────────────────────────────────────────────
// API 3: Root Cause Analysis Context
// Goal: Focus on error logs and repeated failure
// patterns — noise (notice logs) filtered out.
// ─────────────────────────────────────────────

/**
 * Selects context logs for the Root Cause Analysis API.
 * Focuses on error-level logs and clusters repeated failures.
 *
 * @returns {Object[]} Array of log objects to send to the LLM
 */
function getRootCauseContext() {
  // Focus only on error-level logs — these are what root cause is about
  const errorLogs = getLogsByLevel('error');

  // Deduplicate (keep max 3 of each repeated error)
  const deduped = deduplicate(errorLogs, 3);

  // Cap at MAX_LOGS_PER_REQUEST
  return deduped.slice(0, MAX_LOGS_PER_REQUEST);
}

module.exports = {
  getClassificationContext,
  getTimelineContext,
  getRootCauseContext
};
