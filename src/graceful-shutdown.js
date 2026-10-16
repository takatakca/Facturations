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
      // A failed HTTP close must not skip PostgreSQL cleanup. Node's close
      // callback can receive an error (for example ERR_SERVER_NOT_RUNNING).
      try {
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeIdleConnections?.();
        });
      } catch {
        processLike.exitCode = 1;
      }

      try {
        if (pool && typeof pool.end === 'function') await pool.end();
      } catch {
        processLike.exitCode = 1;
      }
      if (processLike.exitCode == null) processLike.exitCode = 0;
    } finally {
      clearTimeoutImpl(timer);
    }
  }

  processLike.once('SIGTERM', () => { void shutdown(); });
  processLike.once('SIGINT', () => { void shutdown(); });

  return Object.freeze({ shutdown });
}

module.exports = { installGracefulShutdown };
