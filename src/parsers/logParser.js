const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Format 1: Apache error log
// [Day Mon DD HH:MM:SS YYYY] [level] [client IP] message
// ─────────────────────────────────────────────────────────────────────────────
const APACHE_REGEX = /^\[([^\]]+)\]\s+\[([^\]]+)\]\s+(?:\[client\s+([\d.:/]+)\]\s+)?(.+)$/;

// ─────────────────────────────────────────────────────────────────────────────
// Format 2: Syslog / OpenSSH / Linux auth.log
// Mon DD HH:MM:SS hostname process[pid]: message
// e.g. Dec 10 06:55:46 LabSZ sshd[24200]: Failed password for root from 5.36.59.76
// ─────────────────────────────────────────────────────────────────────────────
const SYSLOG_REGEX = /^(\w{3}\s+\d{1,2}\s+[\d:]+)\s+\S+\s+\S+\[\d+\]:\s+(.+)$/;

// ─────────────────────────────────────────────────────────────────────────────
// Format 4: HDFS / Hadoop log (loghub format)
// YYMMDD HHMMSS PID LEVEL ClassName: message
// e.g. 081109 203615 148 INFO dfs.DataNode$DataXceiver: Receiving block blk_...
// ─────────────────────────────────────────────────────────────────────────────
const HDFS_REGEX = /^(\d{6}\s+\d{6})\s+\d+\s+(INFO|WARN|ERROR|DEBUG|FATAL)\s+[\w.$]+:\s+(.+)$/;

// ─────────────────────────────────────────────────────────────────────────────
// Format 3: Nginx access log
// IP - - [DD/Mon/YYYY:HH:MM:SS +ZZZZ] "METHOD /path HTTP/1.x" STATUS bytes
// ─────────────────────────────────────────────────────────────────────────────
const NGINX_REGEX = /^([\d.]+)\s+-\s+-\s+\[([^\]]+)\]\s+"([^"]+)"\s+(\d{3})\s+(\d+)/;

// ─────────────────────────────────────────────────────────────────────────────
// Generic loose patterns — used as last-resort extraction for unknown formats
// ─────────────────────────────────────────────────────────────────────────────
const GENERIC_IP_REGEX        = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/;
const GENERIC_TIMESTAMP_REGEX = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}|\[\w[^\]]+\])/;
const GENERIC_LEVEL_KEYWORDS  = {
  error:   /\b(error|err|fail|failed|failure|fatal|crit|critical|alert|emerg|break-in|invalid|illegal|refused|denied)\b/i,
  warn:    /\b(warn|warning|disconnect|timeout|deprecated)\b/i,
  notice:  /\b(info|notice|debug|accepted|success|open|start|stop|listen)\b/i
};

// ─────────────────────────────────────────────────────────────────────────────
// Detect which format a file uses by sampling the first 20 non-empty lines
// ─────────────────────────────────────────────────────────────────────────────
function detectFormat(lines) {
  const sample = lines.filter(function (l) { return l.trim().length > 0; }).slice(0, 20);
  const scores = { apache: 0, syslog: 0, nginx: 0, hdfs: 0 };

  sample.forEach(function (line) {
    if (APACHE_REGEX.test(line))  scores.apache++;
    if (SYSLOG_REGEX.test(line))  scores.syslog++;
    if (NGINX_REGEX.test(line))   scores.nginx++;
    if (HDFS_REGEX.test(line))    scores.hdfs++;
  });

  // Find the format with the most matches
  const best = Object.keys(scores).reduce(function (a, b) {
    return scores[a] >= scores[b] ? a : b;
  });

  // If no format got at least 20% of sample lines, treat as generic
  const threshold = Math.max(1, Math.floor(sample.length * 0.2));
  if (scores[best] < threshold) return 'generic';

  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classify severity level from syslog/generic message keywords
// ─────────────────────────────────────────────────────────────────────────────
function detectLevel(message) {
  if (GENERIC_LEVEL_KEYWORDS.error.test(message))  return 'error';
  if (GENERIC_LEVEL_KEYWORDS.warn.test(message))   return 'warn';
  if (GENERIC_LEVEL_KEYWORDS.notice.test(message)) return 'notice';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-categorize a log message into one of the assessment categories
// ─────────────────────────────────────────────────────────────────────────────
function categorizeLog(level, message) {
  const msg = message.toLowerCase();

  // Security (highest priority)
  if (
    msg.includes('break-in')               ||
    msg.includes('failed password')        ||
    msg.includes('invalid user')           ||
    msg.includes('illegal user')           ||
    msg.includes('authentication failure') ||
    msg.includes('unauthorized')           ||
    msg.includes('directory index forbidden') ||
    msg.includes('possible attack')        ||
    msg.includes('preauth')                ||
    msg.includes('sql injection')          ||
    msg.includes('xss')                    ||
    msg.includes('brute')
  ) return 'Security';

  if (msg.includes('accepted password') || msg.includes('session opened') ||
      msg.includes('session closed'))                                       return 'Security';

  // Lifecycle
  if (msg.includes('shutdown') || msg.includes('stopping'))                return 'Shutdown';
  if (msg.includes('restart')  || msg.includes('resuming') ||
      msg.includes('starting')  || msg.includes('listening'))              return 'Startup';

  // Apache / backend specific
  if (msg.includes('jk2_init') || msg.includes('scoreboard'))             return 'Worker Initialization';
  if (msg.includes('workerenv') && level === 'notice')                     return 'Worker Initialization';
  if (msg.includes('workerenv') && level === 'error')                      return 'Backend Communication';
  if (msg.includes('mod_jk')   && msg.includes('error state'))            return 'Backend Communication';
  if (msg.includes('workers2.properties'))                                 return 'Configuration';

  // General
  if (msg.includes('timeout') || msg.includes('latency') ||
      msg.includes('response time'))                                        return 'Performance';
  if (msg.includes('can\'t find child'))                                   return 'Error';
  if (level === 'error')                                                   return 'Error';
  if (level === 'warn')                                                    return 'Warning';

  return 'Unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Format-specific parsers
// ─────────────────────────────────────────────────────────────────────────────

function parseApacheLine(line, lineNumber) {
  const match = line.match(APACHE_REGEX);
  if (!match) return null;
  const level   = match[2].trim().toLowerCase();
  const message = match[4].trim();
  return {
    lineNumber, raw: line, format: 'apache',
    timestamp:  match[1].trim(),
    parsedDate: new Date(match[1].trim()),
    level, clientIp: match[3] || null, message,
    category: categorizeLog(level, message)
  };
}

function parseSyslogLine(line, lineNumber) {
  const match = line.match(SYSLOG_REGEX);
  if (!match) return null;
  const timestamp = match[1].trim();
  const message   = match[2].trim();
  const level     = detectLevel(message);
  const ipMatch   = message.match(/from\s+([\d.]+)/i) || message.match(GENERIC_IP_REGEX);
  return {
    lineNumber, raw: line, format: 'syslog',
    timestamp,
    parsedDate: new Date(timestamp + ' ' + new Date().getFullYear()),
    level, clientIp: ipMatch ? ipMatch[1] : null, message,
    category: categorizeLog(level, message)
  };
}

function parseNginxLine(line, lineNumber) {
  const match = line.match(NGINX_REGEX);
  if (!match) return null;
  const status  = parseInt(match[4], 10);
  const level   = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'notice';
  const message = match[3] + ' → ' + match[4];
  return {
    lineNumber, raw: line, format: 'nginx',
    timestamp:  match[2].trim(),
    parsedDate: new Date(match[2].trim()),
    level, clientIp: match[1], message,
    category: categorizeLog(level, message)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HDFS / Hadoop log parser
// ─────────────────────────────────────────────────────────────────────────────
function parseHdfsLine(line, lineNumber) {
  const match = line.match(HDFS_REGEX);
  if (!match) return null;

  const rawTimestamp = match[1].trim(); // e.g. "081109 203615"
  const rawLevel     = match[2].trim(); // INFO | WARN | ERROR | DEBUG | FATAL
  const message      = match[3].trim();

  // Map Hadoop levels to internal levels
  const levelMap = { INFO: 'notice', DEBUG: 'notice', WARN: 'warn', WARNING: 'warn', ERROR: 'error', FATAL: 'error' };
  const level    = levelMap[rawLevel] || 'unknown';

  // Parse YYMMDD HHMMSS → Date (prefix with 20 for year)
  const year    = '20' + rawTimestamp.substring(0, 2);
  const month   = rawTimestamp.substring(2, 4);
  const day     = rawTimestamp.substring(4, 6);
  const time    = rawTimestamp.substring(7); // HHMMSS
  const hh      = time.substring(0, 2);
  const mm      = time.substring(2, 4);
  const ss      = time.substring(4, 6);
  const isoStr  = year + '-' + month + '-' + day + 'T' + hh + ':' + mm + ':' + ss;

  const ipMatch = message.match(GENERIC_IP_REGEX);

  return {
    lineNumber, raw: line, format: 'hdfs',
    timestamp:  rawTimestamp,
    parsedDate: new Date(isoStr),
    level, clientIp: ipMatch ? ipMatch[1] : null, message,
    category: categorizeLog(level, message)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic fallback parser — works on ANY log format
// Extracts whatever it can using loose pattern matching.
// The AI always works because it uses `raw` regardless.
// ─────────────────────────────────────────────────────────────────────────────
function parseGenericLine(line, lineNumber) {
  const tsMatch = line.match(GENERIC_TIMESTAMP_REGEX);
  const ipMatch = line.match(GENERIC_IP_REGEX);
  const level   = detectLevel(line);

  return {
    lineNumber, raw: line, format: 'generic',
    timestamp:  tsMatch ? tsMatch[1] : null,
    parsedDate: tsMatch ? new Date(tsMatch[1]) : null,
    level,
    clientIp:   ipMatch ? ipMatch[1] : null,
    message:    line.trim(),
    category:   categorizeLog(level, line)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe file reader — tries UTF-8 first, falls back to latin1
// Prevents crashes on files with unusual encodings
// ─────────────────────────────────────────────────────────────────────────────
function readFileSafe(absolutePath) {
  try {
    return fs.readFileSync(absolutePath, 'utf-8');
  } catch (err) {
    console.warn('[logParser] UTF-8 read failed, retrying with latin1...');
    try {
      return fs.readFileSync(absolutePath, 'latin1');
    } catch (err2) {
      throw new Error('Could not read log file (tried utf-8 and latin1): ' + err2.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main: parseLogFile(filePath)
//
// 1. Auto-detects format: apache | syslog | nginx | generic
// 2. Parses every line with the matching parser
// 3. Falls back to generic extractor for any line that doesn't match
// 4. Never throws on bad lines — always returns something for the AI to use
// ─────────────────────────────────────────────────────────────────────────────
function parseLogFile(filePath) {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error('Log file not found: ' + absolutePath);
  }

  const fileContent = readFileSafe(absolutePath);
  const lines       = fileContent.split(/\r?\n/);
  const format      = detectFormat(lines);

  console.log('[logParser] Detected format: ' + format + ' (' + lines.length + ' lines)');

  const logs = [];
  let parseFailures = 0;

  lines.forEach(function (line, index) {
    if (!line.trim()) return;

    const lineNumber = index + 1;
    let parsed = null;

    // Try the detected format first
    if (format === 'apache')       parsed = parseApacheLine(line, lineNumber);
    else if (format === 'syslog')  parsed = parseSyslogLine(line, lineNumber);
    else if (format === 'nginx')   parsed = parseNginxLine(line, lineNumber);
    else if (format === 'hdfs')    parsed = parseHdfsLine(line, lineNumber);

    // If format-specific parser failed, use generic extractor (never returns null)
    if (!parsed) {
      parsed = parseGenericLine(line, lineNumber);
      parseFailures++;
    }

    logs.push(parsed);
  });

  if (parseFailures > 0) {
    console.log('[logParser] ' + parseFailures + ' lines used generic fallback extractor.');
  }

  console.log('[logParser] Done. ' + logs.length + ' entries parsed as "' + format + '".');
  return logs;
}

module.exports = { parseLogFile };
