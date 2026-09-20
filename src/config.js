'use strict';

const DEFAULT_PORT = 3000;

function loadConfig(env = process.env) {
  const rawPort = env.PORT || String(DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(rawPort)) {
    throw new Error('PORT must be an integer from 0 to 65535');
  }
  const port = Number(rawPort);
  if (port < 0 || port > 65535) {
    throw new Error('PORT must be an integer from 0 to 65535');
  }

  const adminKey = env.TAKATAK_ADMIN_KEY || '';
  if (adminKey && adminKey.length < 32) {
    throw new Error('TAKATAK_ADMIN_KEY must contain at least 32 characters');
  }

  return Object.freeze({
    port,
    adminKey,
    waveToken: (env.WAVE_ACCESS_TOKEN || '').trim(),
  });
}

module.exports = { loadConfig };
