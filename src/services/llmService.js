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
// Helper: Call Gemini REST API directly using fetch
// This supports the new AQ. key format seamlessly
// ─────────────────────────────────────────────────────────────────────────────
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }]
    })
  });

  if (!response.ok) {
    const errData = await response.json();
    throw new Error(errData.error?.message || 'Gemini API call failed');
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error('Empty response received from Gemini.');
  }

  // Gemini sometimes wraps JSON in markdown code blocks — strip them
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[llmService] Failed to parse Gemini response as JSON:', cleaned);
    throw new Error('LLM returned invalid JSON. Please try again.');
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

  return await callGemini(prompt);
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

  return await callGemini(prompt);
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

  return await callGemini(prompt);
}

module.exports = {
  classifyLogs,
  generateTimeline,
  analyzeRootCause
};
