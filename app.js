require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

// ─── Multer: save uploaded logs to /dataset/ folder ───────────────────────────
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'dataset'));
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '_' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: function (req, file, cb) {
    cb(null, true); // Accept any text/log file
  }
});

// ─── Services & Routes ─────────────────────────────────────────────────────────
const { loadLogs, reloadLogs, getLoadedFileName, getStats } = require('./src/services/inMemoryStore');
const cache = require('./src/services/cacheService');

const classificationRoute = require('./src/routes/classification');
const timelineRoute = require('./src/routes/timeline');
const rootCauseRoute = require('./src/routes/rootCause');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Bootstrap: parse logs once at startup ────────────────────────────────────
// This is a key architectural requirement: logs are parsed ONCE and cached in
// memory. No file I/O or parsing occurs during API requests.
loadLogs();

// ─── AI Feature Routes ─────────────────────────────────────────────────────────
app.use('/api/ai/log-classification', classificationRoute);
app.use('/api/ai/incident-timeline', timelineRoute);
app.use('/api/ai/root-cause-analysis', rootCauseRoute);

// ─── Health Check ──────────────────────────────────────────────────────────────
app.get('/api/health', function (req, res) {
  res.json({
    success: true,
    message: 'AI Log Intelligence Engine is running.',
    dataset: getLoadedFileName(),
    cacheStats: cache.stats(),
    data: getStats()
  });
});

// ─── Dataset Info ───────────────────────────────────────────────────────────────
app.get('/api/dataset-info', function (req, res) {
  res.json({
    success: true,
    fileName: getLoadedFileName(),
    stats: getStats()
  });
});

// ─── Cache Stats ────────────────────────────────────────────────────────────────
app.get('/api/cache-stats', function (req, res) {
  res.json({
    success: true,
    message: 'AI response cache statistics.',
    data: cache.stats()
  });
});

// ─── Upload Custom Dataset ──────────────────────────────────────────────────────
app.post('/api/upload-dataset', upload.single('logfile'), function (req, res) {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded.' });
  }
  try {
    reloadLogs(req.file.path, req.file.originalname);
    res.json({
      success: true,
      message: 'Dataset loaded successfully.',
      fileName: req.file.originalname,
      stats: getStats()
    });
  } catch (err) {
    fs.unlinkSync(req.file.path);
    res.status(422).json({ success: false, message: 'Failed to parse log file: ' + err.message });
  }
});

// ─── Reset to Sample Dataset ───────────────────────────────────────────────────
app.post('/api/load-sample', function (req, res) {
  try {
    const samplePath = path.resolve(__dirname, 'dataset/Apache_2k.log');
    reloadLogs(samplePath, 'Apache_2k.log (sample)');
    res.json({
      success: true,
      message: 'Sample dataset loaded.',
      fileName: 'Apache_2k.log (sample)',
      stats: getStats()
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── 404 Handler ───────────────────────────────────────────────────────────────
app.use(function (req, res) {
  res.status(404).json({
    success: false,
    message: 'Route not found.',
    data: null
  });
});

// ─── Global Error Handler ──────────────────────────────────────────────────────
app.use(function (err, req, res, next) {
  console.error('[app] Unhandled error:', err.message);
  res.status(500).json({
    success: false,
    message: 'Internal server error.',
    data: null
  });
});

// ─── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, function () {
  console.log('');
  console.log('  AI Log Intelligence Engine');
  console.log('  Server running at http://localhost:' + PORT);
  console.log('');
  console.log('  AI Feature APIs:');
  console.log('  POST /api/ai/log-classification');
  console.log('  POST /api/ai/incident-timeline');
  console.log('  POST /api/ai/root-cause-analysis');
  console.log('');
  console.log('  Utility APIs:');
  console.log('  GET  /api/health');
  console.log('  GET  /api/dataset-info');
  console.log('  GET  /api/cache-stats');
  console.log('  POST /api/upload-dataset');
  console.log('  POST /api/load-sample');
  console.log('');
});