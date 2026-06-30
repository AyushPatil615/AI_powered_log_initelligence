require('dotenv').config();

const cache = require('./cacheService');
const { getFingerprint, getLoadedFileName, getStats } = require('./inMemoryStore');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

// The model names for primary / fallback
const PRIMARY_MODEL = 'gemini-2.5-flash';      // Confirmed working on free tier
const FALLBACK_MODEL = 'gemini-2.5-flash-lite'; // Lighter fallback

// ─────────────────────────────────────────────────────────────────────────────
// Helper: sleep
// ─────────────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Extract retry-after delay from Gemini 429 message bodies
// e.g. "Please retry in 43.928925857s."
// ─────────────────────────────────────────────────────────────────────────────
function parseRetryDelay(errorMessage) {
  if (!errorMessage) return null;
  const match = errorMessage.match(/retry in ([\d.]+)s/i);
  if (match) {
    return Math.min(Math.ceil(parseFloat(match[1])) * 1000 + 2000, 65000);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Format log objects into a compact, LLM-friendly text block
//
// Design choice: include lineNumber so the LLM can cite evidence by line,
// and format to keep token usage low.
// ─────────────────────────────────────────────────────────────────────────────
function formatLogsForPrompt(logs) {
  return logs.map(function (log) {
    return '[Line ' + log.lineNumber + '] ' + log.raw;
  }).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Build a dataset context summary injected at the start of every prompt.
//
// Why: Telling the LLM about the dataset composition (how many errors vs notices,
// what format) helps it calibrate confidence scores and make better category
// decisions — especially when given a sparse sample.
// ─────────────────────────────────────────────────────────────────────────────
function buildDatasetContext() {
  try {
    const stats = getStats();
    const cats = stats.categoryBreakdown || {};
    const catSummary = Object.entries(cats)
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 6)
      .map(function (e) { return e[0] + ': ' + e[1]; })
      .join(', ');

    return (
      'DATASET CONTEXT (do not analyse these lines — use for calibration only):\n' +
      '  File: ' + getLoadedFileName() + '\n' +
      '  Total logs: ' + stats.total + '\n' +
      '  Errors: ' + stats.errorCount + '\n' +
      '  Warnings: ' + (stats.warnCount || 0) + '\n' +
      '  Notices: ' + stats.noticeCount + '\n' +
      '  Unique IPs: ' + stats.uniqueClientIps + '\n' +
      '  Top categories: ' + (catSummary || 'N/A') + '\n' +
      '  Time range: ' + (stats.timeRange?.first || '?') +
      ' → ' + (stats.timeRange?.last || '?') + '\n'
    );
  } catch (_) {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: callGeminiWithKey
//
// Single Gemini REST call with exponential-backoff retry.
// Returns a parsed JSON object on success; throws on exhausted retries.
// ─────────────────────────────────────────────────────────────────────────────
async function callGeminiWithKey(prompt, apiKey, model, label, maxOutputTokens) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,   // Lower = more deterministic / factual
            topP: 0.85,
            maxOutputTokens: maxOutputTokens || 2048,
            responseMimeType: 'application/json'
          }
        })
      });

      // Rate limit / overload — honour Gemini's retry-after header / body
      if (response.status === 429 || response.status === 503) {
        const errData = await response.json().catch(function () { return {}; });
        const errMsg = errData.error?.message || '';
        const retryAfterHeader = response.headers.get('Retry-After');
        const waitMs =
          parseRetryDelay(errMsg) ||
          (retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : null) ||
          BASE_DELAY_MS * Math.pow(2, attempt - 1);

        console.warn(
          '[llmService] ' + label + ' ' + response.status +
          ' — attempt ' + attempt + '/' + MAX_RETRIES +
          '. Waiting ' + (waitMs / 1000).toFixed(1) + 's...' +
          (errMsg ? ' (' + errMsg.substring(0, 80) + '...)' : '')
        );

        if (attempt < MAX_RETRIES) { await sleep(waitMs); continue; }

        const isQuota = errMsg.toLowerCase().includes('quota');
        lastError = new Error(
          isQuota ? label + ' quota exceeded.' : (errMsg || label + ' rate limit exceeded.')
        );
        throw lastError;
      }

      // Other HTTP errors
      if (!response.ok) {
        const errData = await response.json().catch(function () { return {}; });
        throw new Error(errData.error?.message || label + ' call failed with status ' + response.status);
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        lastError = new Error('Empty response from ' + label + '.');
        console.warn('[llmService] Empty response from ' + label + ' on attempt ' + attempt + '/' + MAX_RETRIES + '.');
        if (attempt < MAX_RETRIES) { await sleep(BASE_DELAY_MS * attempt); continue; }
        throw lastError;
      }

      // Strip markdown fences if model wraps JSON in them
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      try {
        return JSON.parse(cleaned);
      } catch (err) {
        console.error('[llmService] Failed to parse JSON from ' + label + ':\n', cleaned.substring(0, 500));
        throw new Error('LLM returned invalid JSON. Please try again.');
      }

    } catch (err) {
      // Network-level errors — retry
      if (attempt < MAX_RETRIES && (err.code === 'ECONNRESET' || err.message.includes('fetch'))) {
        lastError = err;
        const waitMs = BASE_DELAY_MS * attempt;
        console.warn('[llmService] ' + label + ' network error on attempt ' + attempt + '. Retrying in ' + (waitMs / 1000) + 's...');
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error(label + ' failed after ' + MAX_RETRIES + ' attempts.');
}

// ─────────────────────────────────────────────────────────────────────────────
// callLLM(prompt, cacheKey)
//
// Primary:  gemini-2.5-flash   using GEMINI_API_KEY
// Fallback: gemini-2.5-flash-lite using GEMINI_API_KEY_2
//
// If the primary fails for any reason, the fallback is tried automatically.
// Results are cached by cacheKey to avoid redundant Gemini calls.
// ─────────────────────────────────────────────────────────────────────────────
async function callLLM(prompt, cacheKey, maxOutputTokens) {
  // ── Cache check ────────────────────────────────────────────────────────────
  if (cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('[llmService] Cache HIT for key:', cacheKey.substring(0, 50));
      return { ...cached, _fromCache: true };
    }
  }

  const primaryKey = process.env.GEMINI_API_KEY;
  const fallbackKey = process.env.GEMINI_API_KEY_2;

  let result;
  let modelUsed;

  // ── Try Primary ────────────────────────────────────────────────────────────
  try {
    console.log('[llmService] Using primary: ' + PRIMARY_MODEL);
    result = await callGeminiWithKey(prompt, primaryKey, PRIMARY_MODEL, 'Primary (' + PRIMARY_MODEL + ')', maxOutputTokens);
    modelUsed = PRIMARY_MODEL;
  } catch (primaryErr) {
    console.warn('[llmService] Primary failed: ' + primaryErr.message);

    // ── Try Fallback ───────────────────────────────────────────────────────
    if (!fallbackKey) {
      console.warn('[llmService] No GEMINI_API_KEY_2 set — skipping fallback.');
      throw primaryErr;
    }

    try {
      console.log('[llmService] Switching to fallback: ' + FALLBACK_MODEL);
      result = await callGeminiWithKey(prompt, fallbackKey, FALLBACK_MODEL, 'Fallback (' + FALLBACK_MODEL + ')', maxOutputTokens);
      modelUsed = FALLBACK_MODEL;
    } catch (fallbackErr) {
      console.error('[llmService] Fallback also failed: ' + fallbackErr.message);
      throw new Error(
        'Both Gemini providers failed.\n' +
        '  Primary (' + PRIMARY_MODEL + '): ' + primaryErr.message + '\n' +
        '  Fallback (' + FALLBACK_MODEL + '): ' + fallbackErr.message
      );
    }
  }

  // Attach model metadata to every result so routes can surface it in responses
  result._model = modelUsed;

  // ── Cache store ────────────────────────────────────────────────────────────
  if (cacheKey) {
    cache.set(cacheKey, result);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1: Log Classification Engine
//
// Prompt design rationale:
//  - System-role persona grounds the model in SIEM/security analyst context
//  - Dataset context calibrates confidence scores against the real distribution
//  - Explicit chain-of-thought ("reasoning") field improves accuracy by forcing
//    the model to justify its category before committing to a confidence score
//  - Strict JSON schema prevents freeform text responses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies log entries using Gemini with chain-of-thought prompting.
 *
 * @param {Object[]} logs - Array of log objects from contextSelector
 * @returns {Object} JSON response with classifications array
 */
async function classifyLogs(logs) {
  const logText = formatLogsForPrompt(logs);
  const dsContext = buildDatasetContext();

  // Cache key: feature + dataset fingerprint + sample of first/last log line numbers
  const cacheKey = 'classify|' + getFingerprint() + '|' + logs[0]?.lineNumber + '-' + logs[logs.length - 1]?.lineNumber;

  const prompt = `ROLE: Apache/SIEM log analyst. Classify each log entry below.
Base ALL answers strictly on the text provided — do not infer information absent from the logs.

${dsContext}
CATEGORIES (pick exactly one):
Startup | Shutdown | Configuration | Worker Initialization | Backend Communication | Warning | Error | Performance | Security | Unknown

CONFIDENCE GUIDE:
1.0 = explicit signal word matches category perfectly
0.8 = strong match, minor ambiguity
0.6 = probable match based on context
0.4 = weak match, multiple categories plausible
0.2 = largely unknown, best guess

OUTPUT RULES:
- Return ONLY the JSON object below. No markdown, no prose, no code fences.
- Every input log entry must appear in "classifications" exactly once.
- "lineNumber" must match the [Line N] prefix exactly.
- "explanation" must quote at least one phrase from the log.

{
  "classifications": [
    {
      "lineNumber": <integer>,
      "category": "<category>",
      "confidence": <float 0.0-1.0>,
      "explanation": "<one sentence quoting a specific phrase from this log>"
    }
  ]
}

LOG ENTRIES:
${logText}`;

  return await callLLM(prompt, cacheKey, 2048); // 30 logs × ~60 tokens = ~1800 max needed
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 2: Incident Timeline Generator
//
// Prompt design rationale:
//  - Explicitly forbids "one event per log line" to force meaningful grouping
//  - severity field drives colour-coding in rich UIs
//  - logRefs allow the UI to link back to source lines (evidence traceability)
//  - Dataset context helps the model understand the time range it's summarising
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a chronological incident timeline using Gemini.
 *
 * @param {Object[]} logs - Chronologically sorted, deduplicated log objects
 * @returns {Object} JSON response with timeline array
 */
async function generateTimeline(logs) {
  const logText = formatLogsForPrompt(logs);
  const dsContext = buildDatasetContext();
  const cacheKey = 'timeline|' + getFingerprint();

  const prompt = `ROLE: SRE performing incident timeline reconstruction from server logs.
Base ALL conclusions strictly on the log entries provided — do not assume events not present in the data.

${dsContext}
TASK: Produce a concise chronological incident timeline.

RULES:
1. Group related entries into one event — never one event per log line.
2. Produce 5–8 events maximum. Fewer clear events beats many vague ones.
3. "timestamp": copy the timestamp exactly as it appears in the earliest log of the group.
4. "logRefs": use the integer from the [Line N] prefix of each supporting entry.
5. "severity": "error" for failures, "warning" for degraded/retry states, "info" for normal ops.
6. "summary": 1–2 sentences max — what happened and its operational significance.

OUTPUT RULES:
- Return ONLY the JSON object below. No markdown, no prose, no code fences.
- Do not add fields beyond those in the schema.

{
  "timeline": [
    {
      "timestamp": "<copied verbatim from the log>",
      "eventTitle": "<action-oriented title, ≤7 words>",
      "summary": "<1-2 sentences: what happened and why it matters>",
      "logRefs": [<line numbers>],
      "severity": "<info|warning|error>"
    }
  ]
}

LOG ENTRIES (chronological):
${logText}`;

  return await callLLM(prompt, cacheKey, 1500); // 5-8 timeline events fits in 1500 tokens
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 3: Root Cause Analysis
//
// Prompt design rationale:
//  - Forces evidence-first reasoning (evidence → impact → cause) to reduce
//    hallucination and ensure every claim is anchored in a log line
//  - "affectedComponents" field surfaces the blast-radius clearly
//  - "remediationSteps" (plural, ordered) is more actionable than a single recommendation
//  - confidenceRationale makes the score auditable by the evaluator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Performs root cause analysis using Gemini with evidence-driven prompting.
 *
 * @param {Object[]} logs - Error/warn log objects from contextSelector
 * @returns {Object} JSON response with root cause details
 */
async function analyzeRootCause(logs) {
  const logText = formatLogsForPrompt(logs);
  const dsContext = buildDatasetContext();
  const cacheKey = 'rootcause|' + getFingerprint();

  const prompt = `ROLE: SRE performing formal root cause analysis on server logs.
Base ALL findings strictly on the logs provided. Do not speculate about causes absent from the evidence.

${dsContext}
TASK: Identify the single most probable root cause of the incident.

REASONING APPROACH (internal — do not output these steps):
- Which log entries repeat or cluster? Repetition = likely root cause, not consequence.
- What was the first failure chronologically? Earlier failures cause later ones.
- Does removing one cause eliminate all other symptoms?

FIELD RULES:
- "rootCause": one sentence describing the underlying failure, NOT a symptom.
- "evidence": 3–5 items, each quoting a phrase or [Line N] from the logs.
- "impact": one sentence on affected users/systems.
- "remediationSteps": 3 ordered, specific actions (not generic advice).
- "confidence": 0.9 = all logs point to one cause; 0.7 = strong pattern; 0.5 = ambiguous.
- "confidenceRationale": one sentence on what limits or supports confidence.
- "affectedComponents": list of named system components from the logs.

OUTPUT RULES:
- Return ONLY the JSON object below. No markdown, no prose, no code fences.
- Do not add or rename fields.

{
  "rootCause": "<one sentence: underlying technical failure>",
  "evidence": [
    "<observation quoting log phrase or [Line N]>",
    "<observation>",
    "<observation>"
  ],
  "impact": "<one sentence: affected systems and severity>",
  "remediationSteps": [
    "<step 1 — most urgent>",
    "<step 2>",
    "<step 3>"
  ],
  "confidence": <float 0.0-1.0>,
  "confidenceRationale": "<one sentence>",
  "affectedComponents": ["<component>", "<component>"]
}

LOG ENTRIES:
${logText}`;

  return await callLLM(prompt, cacheKey, 1500); // single root cause JSON fits in 1500 tokens
}

module.exports = {
  classifyLogs,
  generateTimeline,
  analyzeRootCause
};