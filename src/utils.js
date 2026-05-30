export function sanitizeFilename(name) {
  let sanitized = name.replace(/[<>:"/\\|?*]/g, '_');
  sanitized = sanitized.replace(/[- ]+/g, ' ').trim();
  return sanitized.length > 100 ? sanitized.slice(0, 100) : sanitized;
}

export function extractEpisodeNumber(url) {
  const segments = url.split('-');
  for (let i = segments.length - 1; i >= 0; i--) {
    const num = parseInt(segments[i], 10);
    if (!isNaN(num)) return num;
  }
  return 0;
}

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export class Logger {
  constructor(debug = false) {
    this.debugMode = debug;
  }

  info(...args) {
    console.log(...args);
  }

  error(...args) {
    console.error(...args);
  }

  debug(...args) {
    if (this.debugMode) {
      console.log('[DEBUG]', ...args);
    }
  }

  warn(...args) {
    console.warn(...args);
  }

  success(message) {
    console.log(`✔ ${message}`);
  }

  warning(message) {
    console.log(`⚠ ${message}`);
  }
}
