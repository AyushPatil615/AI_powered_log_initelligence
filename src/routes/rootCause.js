const express = require('express');
const router  = express.Router();
const { analyzeRootCause }      = require('../services/llmService');
const { getRootCauseContext }   = require('../parsers/contextSelector');
const { getLoadedFileName }     = require('../services/inMemoryStore');

/**
 * POST /api/ai/root-cause-analysis
 *
 * Body: {} (empty — context is auto-selected, prioritising error → warn → all logs)
 *
 * The engine focuses on error-level logs for maximum signal-to-noise ratio.
 * Falls back to warn-level and then a spread sample if no errors exist.
 *
 * Response includes:
 *   - rootCause, evidence[], impact, remediationSteps[], confidence,
 *     confidenceRationale, affectedComponents[]
 *   - logsAnalyzed count
 *   - model used
 *   - fromCache flag
 *   - processingTimeMs
 */
router.post('/', async function (req, res) {
  const startTime = performance.now();

  const contextLogs = getRootCauseContext();

  if (contextLogs.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'No logs found for root cause analysis. Load a dataset first.',
      processingTimeMs: parseFloat((performance.now() - startTime).toFixed(2)),
      data: null
    });
  }

  try {
    const result = await analyzeRootCause(contextLogs);

    return res.status(200).json({
      success:          true,
      message:          'Root cause analysis completed successfully.',
      processingTimeMs: parseFloat((performance.now() - startTime).toFixed(2)),
      model:            result._model     || 'gemini-2.5-flash',
      fromCache:        result._fromCache || false,
      dataset:          getLoadedFileName(),
      data: {
        logsAnalyzed:        contextLogs.length,
        rootCause:           result.rootCause            || '',
        evidence:            result.evidence             || [],
        impact:              result.impact               || '',
        // Support both old (recommendation) and new (remediationSteps) prompt schemas
        remediationSteps:    result.remediationSteps     || (result.recommendation ? [result.recommendation] : []),
        confidence:          result.confidence           ?? null,
        confidenceRationale: result.confidenceRationale || '',
        affectedComponents:  result.affectedComponents  || []
      }
    });

  } catch (error) {
    console.error('[rootCause] Error:', error.message);
    return res.status(500).json({
      success:          false,
      message:          error.message || 'Root cause analysis failed.',
      processingTimeMs: parseFloat((performance.now() - startTime).toFixed(2)),
      data:             null
    });
  }
});

module.exports = router;
