const express = require('express');
const router = express.Router();
const { generateTimeline } = require('../services/llmService');
const { getTimelineContext } = require('../parsers/contextSelector');

/**
 * POST /api/ai/incident-timeline
 *
 * Accepts: {} (empty body is fine — context is auto-selected)
 * Generates a chronological incident timeline from the Apache logs.
 */
router.post('/', async function (req, res) {
  const startTime = Date.now();

  try {
    // Get chronologically spread, deduplicated logs
    const contextLogs = getTimelineContext();

    if (contextLogs.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No logs available to generate a timeline.',
        processingTimeMs: Date.now() - startTime,
        data: null
      });
    }

    // Call Gemini
    const result = await generateTimeline(contextLogs);

    return res.status(200).json({
      success: true,
      message: 'Incident timeline generated successfully.',
      processingTimeMs: Date.now() - startTime,
      data: {
        totalEvents: result.timeline.length,
        timeline: result.timeline
      }
    });

  } catch (error) {
    console.error('[timeline] Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Timeline generation failed.',
      processingTimeMs: Date.now() - startTime,
      data: null
    });
  }
});

module.exports = router;
