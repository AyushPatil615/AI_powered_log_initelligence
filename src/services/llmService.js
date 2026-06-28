require('dotenv').config();

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Format logs into a readable text block for the prompt
// ─────────────────────────────────────────────────────────────────────────────
function formatLogsForPrompt(logs) {
  return logs.map(function (log) {
    return '[Line ' + log.lineNumber + '] ' + log.raw;
  }).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Sleep for a given number of milliseconds
// ─────────────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Parse the "retry in X seconds" value from Gemini's 429 error body.
// Gemini returns messages like: "Please retry in 43.928925857s."
// ─────────────────────────────────────────────────────────────────────────────
function parseRetryDelay(errorMessage) {
  if (!errorMessage) return null;
  const match = errorMessage.match(/retry in ([\d.]+)s/i);
  if (match) {
    const seconds = parseFloat(match[1]);
    return Math.min(Math.ceil(seconds) * 1000 + 2000, 65000);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: callGeminiWithKey(prompt, apiKey, model, label)
//
// Makes a single Gemini REST call with retry logic.
// Used by both the primary and fallback providers.
//
// Returns: parsed JSON object on success
// Throws:  Error on failure after all retries
// ─────────────────────────────────────────────────────────────────────────────
const MAX_RETRIES   = 3;
const BASE_DELAY_MS = 5000;

async function callGeminiWithKey(prompt, apiKey, model, label) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      });

      // Rate limit / overload — read body for exact wait time then retry
      if (response.status === 429 || response.status === 503) {
        const errData = await response.json().catch(function () { return {}; });
        const errMsg  = errData.error?.message || '';
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

        // All retries for this provider exhausted — throw so caller can fallback
        const isQuota = errMsg.toLowerCase().includes('quota');
        lastError = new Error(
          isQuota
            ? label + ' quota exceeded.'
            : (errMsg || label + ' rate limit exceeded.')
        );
        throw lastError;
      }

      // Other HTTP errors — fail immediately
      if (!response.ok) {
        const errData = await response.json().catch(function () { return {}; });
        throw new Error(errData.error?.message || label + ' call failed with status ' + response.status);
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

      // Empty response — retryable
      if (!text) {
        lastError = new Error('Empty response from ' + label + '.');
        console.warn('[llmService] Empty response from ' + label + ' on attempt ' + attempt + '/' + MAX_RETRIES + '.');
        if (attempt < MAX_RETRIES) { await sleep(BASE_DELAY_MS * attempt); continue; }
        throw lastError;
      }

      // Strip markdown code fences if model wraps JSON in them
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      try {
        return JSON.parse(cleaned);
      } catch (err) {
        console.error('[llmService] Failed to parse JSON from ' + label + ':\n', cleaned);
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
// callLLM(prompt)
//
// Primary:  gemini-2.5-flash  using GEMINI_API_KEY
// Fallback: gemini-2.5-flash-lite  using GEMINI_API_KEY_2
//
// If the primary fails for any reason, the fallback is tried automatically.
// ─────────────────────────────────────────────────────────────────────────────
async function callLLM(prompt) {
  const primaryKey  = process.env.GEMINI_API_KEY;
  const fallbackKey = process.env.GEMINI_API_KEY_2;

  // ── Try Primary ─────────────────────────────────────────────────────────────
  try {
    console.log('[llmService] Using primary: gemini-2.5-flash');
    return await callGeminiWithKey(prompt, primaryKey, 'gemini-2.5-flash', 'Primary (2.5-flash)');
  } catch (primaryErr) {
    console.warn('[llmService] Primary failed: ' + primaryErr.message);

    // ── Try Fallback ───────────────────────────────────────────────────────────
    if (!fallbackKey) {
      console.warn('[llmService] No GEMINI_API_KEY_2 set — skipping fallback.');
      throw primaryErr;
    }

    try {
      console.log('[llmService] Switching to fallback: gemini-2.5-flash-lite');
      return await callGeminiWithKey(prompt, fallbackKey, 'gemini-2.5-flash-lite', 'Fallback (2.5-flash-lite)');
    } catch (fallbackErr) {
      console.error('[llmService] Fallback also failed: ' + fallbackErr.message);
      // Throw a combined message so the user knows both were tried
      throw new Error(
        'Both Gemini providers failed.\n' +
        '  Primary (2.5-flash): ' + primaryErr.message + '\n' +
        '  Fallback (2.5-flash-lite): ' + fallbackErr.message
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1: Log Classification
// Classifies each log entry into a category with a confidence score
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies log entries using Gemini.
 *
 * @param {Object[]} logs - Array of log objects from contextSelector
 * @returns {Object} JSON response with classifications array
 */
async function classifyLogs(logs) {
  const logText = formatLogsForPrompt(logs);

  const prompt = `
You are an expert Apache server log analyst working in a SIEM (Security Information and Event Management) platform.

Analyze the following Apache log entries and classify each one into the most appropriate category.

Available categories:
- Startup
- Shutdown
- Configuration
- Worker Initialization
- Backend Communication
- Warning
- Error
- Performance
- Security
- Unknown

Return ONLY a valid JSON object in this exact format (no explanation, no markdown):
{
  "classifications": [
    {
      "lineNumber": <line number>,
      "category": "<category name>",
      "confidence": <confidence as decimal between 0 and 1>,
      "explanation": "<one sentence explaining why this category was chosen>"
    }
  ]
}

Apache Log Entries:
${logText}
`;

  return await callLLM(prompt);
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 2: Incident Timeline Generator
// Builds a chronological list of key events from the logs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates an incident timeline using Gemini.
 *
 * @param {Object[]} logs - Array of log objects from contextSelector
 * @returns {Object} JSON response with timeline array
 */
async function generateTimeline(logs) {
  const logText = formatLogsForPrompt(logs);

  const prompt = `
You are an expert Apache server log analyst working in a SIEM platform.

Analyze the following Apache log entries and generate a chronological incident timeline.

Group related log events into meaningful timeline entries. Do NOT list every log line — instead, 
summarize related events into single timeline entries (e.g. group all worker initialization logs 
into one "Worker Initialization Phase" event).

Return ONLY a valid JSON object in this exact format (no explanation, no markdown):
{
  "timeline": [
    {
      "timestamp": "<timestamp from the earliest log in this group>",
      "eventTitle": "<short title for this event>",
      "summary": "<1-2 sentence description of what happened>",
      "logRefs": [<array of line numbers that support this event>],
      "severity": "<info | warning | error>"
    }
  ]
}

Apache Log Entries:
${logText}
`;

  return await callLLM(prompt);
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 3: Root Cause Analysis
// Analyzes error logs to determine the most probable root cause
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Performs root cause analysis using Gemini.
 *
 * @param {Object[]} logs - Array of error log objects from contextSelector
 * @returns {Object} JSON response with root cause details
 */
async function analyzeRootCause(logs) {
  const logText = formatLogsForPrompt(logs);

  const prompt = `
You are a senior DevOps engineer and Apache server expert analyzing an incident in a SIEM platform.

Analyze the following Apache error logs and determine the most probable root cause of the incident.
Your analysis must be evidence-driven — reference specific log lines to support your findings.

Return ONLY a valid JSON object in this exact format (no explanation, no markdown):
{
  "rootCause": "<clear one-sentence description of the root cause>",
  "evidence": [
    "<specific observation from the logs that supports the root cause>",
    "<another supporting observation>"
  ],
  "impact": "<description of what users or systems are affected and how>",
  "recommendation": "<actionable step to resolve the issue>",
  "confidence": <confidence as decimal between 0 and 1>,
  "affectedComponents": ["<component 1>", "<component 2>"]
}

Apache Error Log Entries:
${logText}
`;

  return await callLLM(prompt);
}

module.exports = {
  classifyLogs,
  generateTimeline,
  analyzeRootCause
};
