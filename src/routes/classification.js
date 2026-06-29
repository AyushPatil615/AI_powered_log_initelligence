const express = require('express');
const router = express.Router();
const { classifyLogs } = require('../services/llmService');
const { getClassificationContext } = require('../parsers/contextSelector');
const { getLoadedFileName } = require('../services/inMemoryStore');

/**
 * POST /api/ai/log-classification
 *
 * Body (optional):
 *   { "logs": ["raw log line 1", "raw log line 2", ...] }
 *
 * If no logs provided, a smart representative sample is auto-selected from
 * the in-memory store covering all severity levels and categories.
 *
 * Response includes:
 *   - classifications array (category, confidence, explanation per entry)
 *   - totalClassified count
 *   - logsAnalyzed count (how many were sent to the LLM)
 *   - model used (primary or fallback)
 *   - fromCache flag (true if served from TTL cache)
 *   - processingTimeMs
 */
router.post('/', async function (req, res) {
  const startTime = performance.now();

  // ── Input validation ────────────────────────────────────────────────────────
  const providedLogs = req.body.logs;
  if (providedLogs !== undefined && !Array.isArray(providedLogs)) {
    return res.status(400).json({
      success: false,
      message: 'Request body field "logs" must be an array of strings.',
      processingTimeMs: parseFloat((performance.now() - startTime).toFixed(2)),
      data: null
    });
  }

  // ── Context selection ───────────────────────────────────────────────────────
  const contextLogs = getClassificationContext(providedLogs);

  if (contextLogs.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'No logs available to classify. Load a dataset first.',
      processingTimeMs: parseFloat((performance.now() - startTime).toFixed(2)),
      data: null
    });
  }

  // ── AI call ─────────────────────────────────────────────────────────────────
  try {
    const result = await classifyLogs(contextLogs);

    return res.status(200).json({
      success: true,
      message: 'Log classification completed successfully.',
      processingTimeMs: parseFloat((performance.now() - startTime).toFixed(2)),
      model: result._model || 'gemini-2.5-flash',
      fromCache: result._fromCache || false,
      dataset: getLoadedFileName(),
      data: {
        logsAnalyzed: contextLogs.length,
        totalClassified: result.classifications?.length || 0,
        classifications: result.classifications || []
      }
    });

  } catch (error) {
    console.error('[classification] Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Classification failed.',
      processingTimeMs: parseFloat((performance.now() - startTime).toFixed(2)),
      data: null
    });
  }
});

module.exports = router;
