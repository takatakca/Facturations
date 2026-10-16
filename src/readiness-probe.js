'use strict';

function createReadinessProbe({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('Dedicated PostgreSQL pool required');
  }
  let draining = false;

  async function check() {
    if (draining) return false;
    try {
      const result = await pool.query('SELECT 1 AS ok');
      // A shutdown can begin while PostgreSQL is answering this probe.
      // Never report ready after the server has entered draining mode.
      return !draining && result.rows?.[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  function markDraining() {
    draining = true;
  }

  return Object.freeze({ check, markDraining });
}

module.exports = { createReadinessProbe };
