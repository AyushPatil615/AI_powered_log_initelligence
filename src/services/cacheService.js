/**
 * cacheService.js
 *
 * A lightweight in-process TTL cache.
 * Prevents hammering the Gemini API with identical requests during a demo session.
 *
 * Key design decisions:
 *  - TTL defaults to 10 minutes (enough for a demo, short enough for fresh data)
 *  - Cache is keyed by a stable hash of (endpoint + dataset fingerprint)
 *  - When the dataset is reloaded the cache is invalidated automatically via bust()
 */

// ── Config ────────────────────────────────────────────────────────────────────
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Store ─────────────────────────────────────────────────────────────────────
const _cache = new Map(); // key → { data, expiresAt }

/**
 * Get a cached value.
 * @param {string} key
 * @returns {any|null} Cached value or null if missing / expired.
 */
function get(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * Store a value in the cache.
 * @param {string} key
 * @param {any}    data
 * @param {number} [ttlMs] - Time to live in milliseconds. Defaults to 10 min.
 */
function set(key, data, ttlMs = DEFAULT_TTL_MS) {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/**
 * Invalidate all cached entries.
 * Called whenever the dataset is reloaded so stale AI responses are discarded.
 */
function bust() {
  _cache.clear();
  console.log('[cacheService] Cache cleared (dataset change).');
}

/**
 * Returns current cache statistics for diagnostics.
 */
function stats() {
  let valid = 0;
  const now = Date.now();
  _cache.forEach(function (v) { if (v.expiresAt > now) valid++; });
  return { totalKeys: _cache.size, validKeys: valid };
}

module.exports = { get, set, bust, stats };
