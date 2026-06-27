require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const { loadLogs } = require('./src/services/inMemoryStore');

// Import routes
const classificationRoute = require('./src/routes/classification');
const timelineRoute        = require('./src/routes/timeline');
const rootCauseRoute       = require('./src/routes/rootCause');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve frontend

// ─── Parse logs once on startup ───────────────────────────────────
// This is a key requirement: logs are parsed ONCE and cached in memory.
// No parsing happens during API requests.
loadLogs();

// ─── API Routes ────────────────────────────────────────────────────
app.use('/api/ai/log-classification',  classificationRoute);
app.use('/api/ai/incident-timeline',   timelineRoute);
app.use('/api/ai/root-cause-analysis', rootCauseRoute);

// ─── Health Check ──────────────────────────────────────────────────
app.get('/api/health', function (req, res) {
  const { getStats } = require('./src/services/inMemoryStore');
  res.json({
    success: true,
    message: 'AI Log Intelligence Engine is running.',
    data: getStats()
  });
});

// ─── 404 Handler ───────────────────────────────────────────────────
app.use(function (req, res) {
  res.status(404).json({
    success: false,
    message: 'Route not found.',
    data: null
  });
});

// ─── Start Server ──────────────────────────────────────────────────
app.listen(PORT, function () {
  console.log('');
  console.log('  AI Log Intelligence Engine');
  console.log('  Server running at http://localhost:' + PORT);
  console.log('');
  console.log('  Available APIs:');
  console.log('  POST /api/ai/log-classification');
  console.log('  POST /api/ai/incident-timeline');
  console.log('  POST /api/ai/root-cause-analysis');
  console.log('  GET  /api/health');
  console.log('');
});
