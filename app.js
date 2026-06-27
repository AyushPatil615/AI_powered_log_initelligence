require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const multer  = require('multer');
const fs      = require('fs');

// ─── Multer: save uploaded logs to /dataset/ folder ───────────────
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'dataset'));
  },
  filename: function (req, file, cb) {
    // Preserve original name but prefix with timestamp to avoid clashes
    const ts = Date.now();
    cb(null, ts + '_' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: function (req, file, cb) {
    // Accept any text/log file
    cb(null, true);
  }
});

const { loadLogs, reloadLogs, getLoadedFileName } = require('./src/services/inMemoryStore');

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

// ─── Dataset Info ───────────────────────────────────────────────────
app.get('/api/dataset-info', function (req, res) {
  const { getStats } = require('./src/services/inMemoryStore');
  res.json({
    success: true,
    fileName: getLoadedFileName(),
    stats: getStats()
  });
});

// ─── Upload Custom Dataset ──────────────────────────────────────────
app.post('/api/upload-dataset', upload.single('logfile'), function (req, res) {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded.' });
  }
  try {
    reloadLogs(req.file.path, req.file.originalname);
    const { getStats } = require('./src/services/inMemoryStore');
    res.json({
      success: true,
      message: 'Dataset loaded successfully.',
      fileName: req.file.originalname,
      stats: getStats()
    });
  } catch (err) {
    // Clean up the bad file
    fs.unlinkSync(req.file.path);
    res.status(422).json({ success: false, message: 'Failed to parse log file: ' + err.message });
  }
});

// ─── Reset to Sample Dataset ────────────────────────────────────────
app.post('/api/load-sample', function (req, res) {
  try {
    const samplePath = path.resolve(__dirname, 'dataset/Apache_2k.log');
    reloadLogs(samplePath, 'Apache_2k.log (sample)');
    const { getStats } = require('./src/services/inMemoryStore');
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
