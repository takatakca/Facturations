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

  let shutdownPromise = null;

  // Every caller observes the same in-flight shutdown. A repeated SIGINT or
  // a caller awaiting shutdown must not receive a premature completion.
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = performShutdown();
    return shutdownPromise;
  }

  async function performShutdown() {
    readinessProbe?.markDraining?.();

    // The deadline must settle the shutdown even if an HTTP callback or
    // pool.end() never completes. A forced connection close alone is not a
    // guarantee that those asynchronous operations will resolve.
    let resolveDeadline;
    const deadline = new Promise(resolve => { resolveDeadline = resolve; });
    const timer = setTimeoutImpl(() => {
      processLike.exitCode = 1;
      try { server.closeAllConnections?.(); } catch { /* already failing */ }
      resolveDeadline();
    }, timeoutMs);
    timer?.unref?.();

    try {
      // A failed or hung HTTP close must not skip PostgreSQL cleanup. Node's
      // close callback can receive an error (e.g. ERR_SERVER_NOT_RUNNING).
      try {
        await Promise.race([
          new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeIdleConnections?.();
          }),
          deadline,
        ]);
      } catch {
        processLike.exitCode = 1;
      }

      try {
        if (pool && typeof pool.end === 'function') {
          // Still attempt pool.end() after the deadline, but never wait forever.
          await Promise.race([Promise.resolve().then(() => pool.end()), deadline]);
        }
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
