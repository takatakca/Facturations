'use strict';

const SAFE_FIELDS = new Set([
  'requestId',
  'method',
  'route',
  'statusCode',
  'durationMs',
  'component',
  'state',
  'code',
  'port',
  'mode',
]);

function cleanString(value, max = 160) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, max);
  return cleaned || null;
}

function cleanValue(key, value) {
  if (['statusCode', 'durationMs', 'port'].includes(key)) {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
  }
  return cleanString(value);
}

function createOperationalLogger({
  now = () => new Date(),
  writeInfo = line => process.stdout.write(line + '\n'),
  writeError = line => process.stderr.write(line + '\n'),
} = {}) {
  if (typeof now !== 'function' || typeof writeInfo !== 'function' || typeof writeError !== 'function') {
    throw new TypeError('Logger dependencies must be functions');
  }

  function emit(level, event, fields = {}) {
    const safeEvent = cleanString(event, 80);
    if (!safeEvent || !/^[a-z][a-z0-9_.-]*$/u.test(safeEvent)) {
      throw new TypeError('Safe event name required');
    }
    const payload = {
      ts: now().toISOString(),
      level,
      event: safeEvent,
    };
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      for (const [key, value] of Object.entries(fields)) {
        if (!SAFE_FIELDS.has(key)) continue;
        const cleaned = cleanValue(key, value);
        if (cleaned !== null) payload[key] = cleaned;
      }
    }
    const line = JSON.stringify(payload);
    (level === 'error' ? writeError : writeInfo)(line);
    return payload;
  }

  return Object.freeze({
    info(event, fields) { return emit('info', event, fields); },
    warn(event, fields) { return emit('warn', event, fields); },
    error(event, fields) { return emit('error', event, fields); },
  });
}

module.exports = { createOperationalLogger, SAFE_FIELDS };
