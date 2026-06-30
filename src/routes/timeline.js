const express = require('express');
const router = express.Router();
const { generateTimeline } = require('../services/llmService');
const { getTimelineContext } = require('../parsers/contextSelector');
const { getLoadedFileName } = require('../services/inMemoryStore');

/**
 * POST /api/ai/incident-timeline
 *
 * Body: {} (empty — context is auto-selected from the loaded dataset)
 *
 * The engine picks a chronologically spread, deduplicated log sample and
 * generates a meaningful incident timeline with grouped events.
 *
 * Response includes:
 *   - timeline array (timestamp, eventTitle, summary, logRefs, severity)
 *   - totalEvents count
 *   - logsAnalyzed count (how many were sent to the LLM)
 *   - model used
 *   - fromCache flag
 *   - processingTimeMs
 */
router.post('/', async function (req, res) {
  const startTime = performance.now();

  const contextLogs = getTimelineContext();

  if (contextLogs.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'No logs available to generate a timeline. Load a dataset first.',
      processingTimeMs: parseFloat((performance.now() - startTime).toFixed(2)),
      data: null
    });
  }

  try {
    const result = await generateTimeline(contextLogs);

    return res.status(200).json({
      success: true,
      message: 'Incident timeline generated successfully.',
      processingTimeMs: parseFloat((performance.now() - startTime).toFixed(2)),
      model: result._model || 'gemini-2.5-flash',
      fromCache: result._fromCache || false,
      dataset: getLoadedFileName(),
      data: {
        logsAnalyzed: contextLogs.length,
        totalEvents: result.timeline?.length || 0,
        timeline: result.timeline || []
      }
    });

  } catch (error) {
    console.error('[timeline] Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Timeline generation failed.',
      processingTimeMs: parseFloat((performance.now() - startTime).toFixed(2)),
      data: null
    });
  }
});

module.exports = router;