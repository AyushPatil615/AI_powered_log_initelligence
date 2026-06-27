const express = require('express');
const router = express.Router();
const { analyzeRootCause } = require('../services/llmService');
const { getRootCauseContext } = require('../parsers/contextSelector');

/**
 * POST /api/ai/root-cause-analysis
 *
 * Accepts: {} (empty body is fine — context is auto-selected from error logs)
 * Analyzes error logs to determine the root cause of the incident.
 */
router.post('/', async function (req, res) {
  const startTime = Date.now();

  try {
    // Get deduplicated error logs for root cause analysis
    const contextLogs = getRootCauseContext();

    if (contextLogs.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No error logs found to perform root cause analysis.',
        processingTimeMs: Date.now() - startTime,
        data: null
      });
    }

    // Call Gemini
    const result = await analyzeRootCause(contextLogs);

    return res.status(200).json({
      success: true,
      message: 'Root cause analysis completed successfully.',
      processingTimeMs: Date.now() - startTime,
      data: {
        logsAnalyzed: contextLogs.length,
        rootCause: result.rootCause,
        evidence: result.evidence,
        impact: result.impact,
        recommendation: result.recommendation,
        confidence: result.confidence,
        affectedComponents: result.affectedComponents || []
      }
    });

  } catch (error) {
    console.error('[rootCause] Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Root cause analysis failed.',
      processingTimeMs: Date.now() - startTime,
      data: null
    });
  }
});

module.exports = router;
