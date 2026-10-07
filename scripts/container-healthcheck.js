'use strict';

// Container liveness probe. Presents the exact public Host and the HTTPS
// proxy marker so the production edge guard accepts the loopback request.
// Uses /ready: the container is healthy only when PostgreSQL answers.
const http = require('node:http');

const port = Number(process.env.PORT || 3000);
let host = `127.0.0.1:${port}`;
try {
  if (process.env.FACTURATIONS_PUBLIC_ORIGIN) host = new URL(process.env.FACTURATIONS_PUBLIC_ORIGIN).host;
} catch {
  process.exit(1);
}

const request = http.request({
  host: '127.0.0.1',
  port,
  path: '/ready',
  method: 'GET',
  timeout: 4000,
  headers: { Host: host, 'X-Forwarded-Proto': 'https' },
}, (response) => {
  response.resume();
  process.exit(response.statusCode === 200 ? 0 : 1);
});
request.on('timeout', () => { request.destroy(); process.exit(1); });
request.on('error', () => process.exit(1));
request.end();
