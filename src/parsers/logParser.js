const fs = require('fs');
const path = require('path');

// Regex pattern to parse Apache log lines
// Format: [Day Mon DD HH:MM:SS YYYY] [level] [client IP] message
const LOG_REGEX = /^\[([^\]]+)\]\s+\[([^\]]+)\]\s+(?:\[client\s+([\d.]+)\]\s+)?(.+)$/;

/**
 * Pre-categorizes a log message based on the assessment's suggested categories:
 * Startup, Shutdown, Configuration, Worker Initialization,
 * Backend Communication, Warning, Error, Performance, Security, Unknown
 */
function categorizeLog(level, message) {
  const msg = message.toLowerCase();

  if (msg.includes('shutdown') || msg.includes('stopping'))                    return 'Shutdown';
  if (msg.includes('restart') || msg.includes('resuming'))                     return 'Startup';
  if (msg.includes('jk2_init') || msg.includes('scoreboard'))                 return 'Worker Initialization';
  if (msg.includes('workerenv') && level === 'notice')                        return 'Worker Initialization';
  if (msg.includes('workerenv') && level === 'error')                         return 'Backend Communication';
  if (msg.includes('mod_jk') && msg.includes('error state'))                  return 'Backend Communication';
  if (msg.includes('workers2.properties'))                                    return 'Configuration';
  if (msg.includes('directory index forbidden'))                               return 'Security';
  if (msg.includes('timeout') || msg.includes('latency') || msg.includes('response time')) return 'Performance';
  if (msg.includes('can\'t find child'))                                      return 'Error';
  if (level === 'error')                                                      return 'Error';
  if (level === 'warn')                                                       return 'Warning';

  return 'Unknown';
}

/**
 * Reads the Apache log file and parses each line into a structured object.
 * Called once at server startup and cached in memory (no database used).
 */
function parseLogFile(filePath) {
  const absolutePath = path.resolve(filePath);

  // Check if file exists
  if (!fs.existsSync(absolutePath)) {
    throw new Error('Log file not found: ' + absolutePath);
  }

  const fileContent = fs.readFileSync(absolutePath, 'utf-8');
  const lines = fileContent.split(/\r?\n/);
  const logs = [];

  lines.forEach(function (line, index) {
    // Skip empty lines
    if (!line.trim()) return;

    const match = line.match(LOG_REGEX);

    if (match) {
      const level = match[2].trim().toLowerCase();
      const message = match[4].trim();

      logs.push({
        lineNumber: index + 1,
        timestamp: match[1].trim(),
        parsedDate: new Date(match[1].trim()), // JS Date object for chronological sorting (used by timeline API)
        level: level,                          // 'notice' | 'error'
        clientIp: match[3] || null,            // null if no client IP in log
        message: message,
        category: categorizeLog(level, message), // pre-categorized for AI context
        raw: line
      });
    } else {
      // Line didn't match the pattern — store as-is
      logs.push({
        lineNumber: index + 1,
        timestamp: null,
        level: 'unknown',
        clientIp: null,
        message: line.trim(),
        category: 'Unknown',
        raw: line
      });
    }
  });

  console.log('[logParser] Total lines parsed: ' + logs.length);
  return logs;
}

module.exports = { parseLogFile };
