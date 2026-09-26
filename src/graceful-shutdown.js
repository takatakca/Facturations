'use strict';

function installGracefulShutdown({
  server,
  pool = null,
  readinessProbe = null,
  processLike = process,
  timeoutMs = 10000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!server || typeof server.close !== 'function') {
    throw new TypeError('HTTP server required');
  }
  if (!processLike || typeof processLike.once !== 'function') {
    throw new TypeError('Process-like event source required');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new TypeError('Graceful shutdown timeout must be 1000-60000 ms');
  }

  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    readinessProbe?.markDraining?.();

    const timer = setTimeoutImpl(() => {
      processLike.exitCode = 1;
      server.closeAllConnections?.();
    }, timeoutMs);
    timer?.unref?.();

    try {
      await new Promise(resolve => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      });
      if (pool && typeof pool.end === 'function') await pool.end();
      if (processLike.exitCode == null) processLike.exitCode = 0;
    } catch {
      processLike.exitCode = 1;
    } finally {
      clearTimeoutImpl(timer);
    }
  }

  processLike.once('SIGTERM', () => { void shutdown(); });
  processLike.once('SIGINT', () => { void shutdown(); });

  return Object.freeze({ shutdown });
}

module.exports = { installGracefulShutdown };
