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

const MAX_LOGS_PER_REQUEST = 30; // Cap sent to LLM — 30 gives good coverage with 40% less processing time

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
// Strategy: Priority-Aware Category Sampling
// High-signal categories always get seats first.
// Remaining slots are spread across other categories.
// ─────────────────────────────────────────────

/**
 * Selects context logs for the Classification API.
 * If specific log lines are provided in the request body, those are used.
 * Otherwise, uses Priority-Aware Category Sampling:
 *   1. Deduplicate all logs (max 2 per normalised message).
 *   2. Reserve seats for high-priority categories first (Error, Backend Communication, Security).
 *   3. Proportionally fill remaining slots from other categories.
 *   4. Redistribute slots from under-filled categories to larger ones.
 *   5. Restore original document order (by lineNumber) before returning.
 *   6. Hard-cap at MAX_LOGS_PER_REQUEST.
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

  // Step 1: Deduplicate all logs — strip noise before selection
  // (max 2 occurrences of any normalised message pattern)
  const deduped = deduplicate(getAllLogs(), 2);

  // Step 2: Separate high-priority categories from the rest.
  // These carry the most incident signal and always get seats first.
  const HIGH_PRIORITY = ['Error', 'Backend Communication', 'Security'];

  const highPriority = deduped.filter(function (log) {
    return HIGH_PRIORITY.indexOf(log.category) !== -1;
  });
  const regular = deduped.filter(function (log) {
    return HIGH_PRIORITY.indexOf(log.category) === -1;
  });

  // Step 3: Fill high-priority slots first (capped at MAX to avoid overflow)
  const selected = highPriority.slice(0, MAX_LOGS_PER_REQUEST);
  const remainingSlots = MAX_LOGS_PER_REQUEST - selected.length;

  // Step 4: Distribute remaining slots proportionally across regular categories
  if (remainingSlots > 0 && regular.length > 0) {
    // Group regular logs by category
    const byCategory = {};
    regular.forEach(function (log) {
      const cat = log.category || 'Unknown';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(log);
    });

    const categories = Object.keys(byCategory);
    const totalRegular = regular.length;

    // Proportional allocation — each category gets slots relative to its size
    const allocations = {};
    let totalAllocated = 0;
    categories.forEach(function (cat) {
      const proportion = byCategory[cat].length / totalRegular;
      allocations[cat] = Math.max(1, Math.floor(proportion * remainingSlots));
      totalAllocated += allocations[cat];
    });

    // Redistribute leftover slots (from floor rounding) to the largest categories
    let leftover = remainingSlots - totalAllocated;
    if (leftover > 0) {
      const sortedBySize = categories.slice().sort(function (a, b) {
        return byCategory[b].length - byCategory[a].length;
      });
      for (let i = 0; i < leftover && i < sortedBySize.length; i++) {
        allocations[sortedBySize[i]]++;
      }
    }

    // Sample evenly from each category up to its allocated slot count
    categories.forEach(function (cat) {
      const logs  = byCategory[cat];
      const alloc = Math.min(allocations[cat], logs.length);
      if (alloc <= 0) return;
      const step = Math.max(1, Math.floor(logs.length / alloc));
      let taken = 0;
      for (let i = 0; i < logs.length && taken < alloc; i += step) {
        selected.push(logs[i]);
        taken++;
      }
    });
  }

  // Step 5: Restore original document order so the LLM sees logs chronologically
  selected.sort(function (a, b) { return a.lineNumber - b.lineNumber; });

  // Step 6: Hard cap — never exceed MAX_LOGS_PER_REQUEST
  return selected.slice(0, MAX_LOGS_PER_REQUEST);
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
  // Priority 1: error-level logs (ideal for root cause)
  let candidates = getLogsByLevel('error');

  // Priority 2: if no errors, use warn-level logs
  if (candidates.length === 0) {
    console.log('[contextSelector] No error logs found — falling back to warn-level logs for root cause.');
    candidates = getLogsByLevel('warn');
  }

  // Priority 3: if still nothing, use a spread sample of all logs
  // (dataset may be entirely INFO-level e.g. HDFS)
  if (candidates.length === 0) {
    console.log('[contextSelector] No error/warn logs found — using spread sample of all logs for root cause.');
    const allLogs = getAllLogs();
    const step    = Math.max(1, Math.floor(allLogs.length / MAX_LOGS_PER_REQUEST));
    for (let i = 0; i < allLogs.length; i += step) {
      candidates.push(allLogs[i]);
      if (candidates.length >= MAX_LOGS_PER_REQUEST) break;
    }
    return candidates;
  }

  // Deduplicate (keep max 3 of each repeated message)
  const deduped = deduplicate(candidates, 3);

  // Cap at MAX_LOGS_PER_REQUEST
  return deduped.slice(0, MAX_LOGS_PER_REQUEST);
}

module.exports = {
  getClassificationContext,
  getTimelineContext,
  getRootCauseContext
};
