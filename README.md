# GROUPE TAKATAK — Facturations

**Phase 1: read-only Wave Accounting connector.** This is an independent Node.js application intended for `https://facturations.bolon.ca`. It reads business names and IDs using your Wave Accounting personal access token. It does **not** create, approve, send, edit or delete invoices, and it has no database, email feature, AI integration or working OAuth callback yet. Nothing deploys automatically.

This repository is **public by the owner's choice**. Never commit credentials, `.env`, invoice data, customer records or sensitive logs. Do not modify or restart any existing TAKATAK production service.

## Requirements

- Node.js 20.11+ or Node.js 22.
- Personal Wave Accounting token for your own business, generated privately in the [Wave developer portal](https://developer.waveapps.com/hc/en-us).
- A separate MochaHost Node.js application and SSL certificate for `facturations.bolon.ca` (after MochaHost confirms setup).

## Start locally

```bash
git clone https://github.com/takatakca/Facturations.git
cd Facturations
node --version
npm run check
npm test
cp .env.example .env
openssl rand -hex 32
```

Edit `.env` **on your own computer only**: put the generated random value into `TAKATAK_ADMIN_KEY` and your Wave token into `WAVE_ACCESS_TOKEN`. Leave `NODE_ENV=development` and `PORT=3000` for local development. Do not paste credentials into GitHub, ChatGPT, Messenger or screenshots. The project has **no third-party dependencies**; no `npm install` is necessary.

Start the service:

```bash
npm run dev
```

From another terminal, test public health:

```bash
curl -i http://127.0.0.1:3000/health
```

Test your Wave connection while keeping the key out of shell history:

```bash
read -rs TAKATAK_ADMIN_KEY; echo
curl -i -H "X-Admin-Key: ${TAKATAK_ADMIN_KEY}" http://127.0.0.1:3000/api/wave/businesses
unset TAKATAK_ADMIN_KEY
```

The expected authenticated response contains `connected: true`, up to ten accessible Wave business names and IDs, `totalCount`, and pagination information. **Do not post that business data publicly.** Tests use simulated Wave responses, not a real token or live account.

## Endpoints

| Method | Path | Access |
| --- | --- | --- |
| GET | `/health` | Public, returns only service status |
| GET | `/api/wave/businesses` | Requires private `X-Admin-Key` header; read-only Wave query |
| Any | `/oauth/callback` | Not implemented; 404 expected during Phase 1 |

The administrator header is a **temporary server-side testing mechanism**, not a customer-login system. Never put it in browser JavaScript, URLs, apps or public documentation. The fixed upstream endpoint is `https://gql.waveapps.com/graphql/public`; the connector uses a fixed read-only query, timeout, response-size limit and sanitized errors.

## Deploy on MochaHost — only after support confirms DNS and SSL

1. Create an **independent** Node.js app at `facturations.bolon.ca`, using a private application root such as `takatak-wave` and startup file `app.js`. Confirm Node.js version and Passenger port configuration with support.
2. Deploy **only this repository** to that new application's root. Do not copy it into existing TAKATAK production application directories or public asset directories.
3. In the new app's **private environment variables**, set `NODE_ENV=production`, `TAKATAK_ADMIN_KEY` (32+ random characters), and `WAVE_ACCESS_TOKEN`. Let Passenger/cPanel supply its required port, if applicable. Do not publish `.env`.
4. Restart **only the new invoicing app**, then check `https://facturations.bolon.ca/health`. Test the protected route privately using your admin header; never put a secret in the URL.
5. Do not change `takatak.ca`, any existing app, its database, its GitHub repository or its configuration.

## Troubleshooting

- `ADMIN_NOT_CONFIGURED`: configure a 32+-character admin key and restart this app.
- `UNAUTHORIZED`: supply the correct key in `X-Admin-Key`, not in a URL.
- `WAVE_NOT_CONFIGURED`: add your private Wave token and restart this app.
- `WAVE_AUTH_FAILED` / `WAVE_ACCESS_DENIED`: inspect the token and its permissions privately in Wave.
- `WAVE_GRAPHQL_ERROR`: investigate current Wave query schema and permissions without sharing raw sensitive responses.
- `WAVE_TIMEOUT` / `WAVE_UNAVAILABLE`: investigate outbound HTTPS from MochaHost.
- `/oauth/callback` returns 404: expected; entering a redirect URI in Wave does not implement an OAuth handler.

Before implementing invoices, add user authentication, business isolation, human approval, idempotency, audit logging and appropriate storage controls. GitHub Actions will run the mocked tests on Node.js 20 and 22 without any secrets.
