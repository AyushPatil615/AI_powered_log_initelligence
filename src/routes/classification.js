const express = require('express');
const router = express.Router();
const { classifyLogs } = require('../services/llmService');
const { getClassificationContext } = require('../parsers/contextSelector');

/**
 * POST /api/ai/log-classification
 *
 * Accepts: { logs: ["raw log line 1", "raw log line 2"] }  (optional)
 * If no logs are provided, a smart sample is selected from the in-memory store.
 */
router.post('/', async function (req, res) {
  const startTime = Date.now();

  try {
    // Get relevant logs for this request (from body or smart sample)
    const providedLogs = req.body.logs || null;
    const contextLogs = getClassificationContext(providedLogs);

    if (contextLogs.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No logs available to classify.',
        processingTimeMs: Date.now() - startTime,
        data: null
      });
    }

    // Call Gemini
    const result = await classifyLogs(contextLogs);

    return res.status(200).json({
      success: true,
      message: 'Log classification completed successfully.',
      processingTimeMs: Date.now() - startTime,
      data: {
        totalClassified: result.classifications.length,
        classifications: result.classifications
      }
    });

  } catch (error) {
    console.error('[classification] Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Classification failed.',
      processingTimeMs: Date.now() - startTime,
      data: null
    });
  }
});

module.exports = router;
