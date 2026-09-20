# GROUPE TAKATAK — Facturations

**Phase 2 development: read-only Wave Accounting connectivity plus an authenticated, stateless invoice draft preview.** Intended for a separate Node.js application at `https://facturations.bolon.ca` once MochaHost confirms the infrastructure. This project **does not save drafts, create Wave invoices, email clients, generate PDFs or implement OAuth**. There is no customer database, AI integration, or automatic deployment yet.

This GitHub repository is **public by the owner's choice**. Never commit credentials, `.env`, customer information, invoices or private logs. Do not modify or restart existing TAKATAK production services.

## Requirements and local setup

Node.js 20.11+ or 22. No third-party runtime dependencies or npm install required.

```bash
git clone https://github.com/takatakca/Facturations.git
cd Facturations
npm run check
npm test
cp .env.example .env
openssl rand -hex 32
```

Only on your own machine, enter the random key as `TAKATAK_ADMIN_KEY` and your personal Wave token as `WAVE_ACCESS_TOKEN` inside `.env`. Do not send them to ChatGPT, GitHub, Messenger or a screenshot. Run `npm run dev` and visit `http://127.0.0.1:3000/health`. Wave business lookup requires the token; the draft calculator does not.

The private header is for temporary **server-side testing only**, not customer authentication. Never put it in browser JavaScript, URLs or publicly served pages.

## Available endpoints

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/health` | Non-sensitive health status |
| GET | `/api/wave/businesses` | Requires `X-Admin-Key`, retrieves a read-only Wave business summary |
| POST | `/api/drafts/preview` | Requires `X-Admin-Key` and `Content-Type: application/json`; validates input and calculates preview only |
| Any | `/oauth/callback` | Not implemented (404 expected) |
| Any | `/api/invoices` or `/api/email` | Not implemented (404 expected) |

The preview request is limited to 32 KiB, 50 lines, 3 explicitly supplied taxes, Canadian dollars, valid calendar dates and whole-number cent amounts. It uses integer arithmetic, independent tax calculations on the **same discounted taxable subtotal**, and rounds each tax half up to the nearest cent. **No rate is automatically assumed to be legally applicable.** The caller must supply the appropriate tax configuration, and verify applicability, exemptions, rounding and reporting with an accountant before issuing actual invoices.

### Preview example (fictional information only)

`rateMilliPercent` means 1/1000 of a percent: `5000` represents 5.000%, and `9975` represents 9.975%. These values are merely illustrative and do not determine what taxes legally apply. Each line must specify `taxable` as a boolean, and `discountCents` is the **total discount for that line**, not a per-unit discount.

```json
{
  "currency": "CAD",
  "customer": { "name": "Example Customer", "email": "customer@example.test" },
  "invoiceDate": "2026-09-20",
  "dueDate": "2026-10-20",
  "notes": "Example only — not an invoice",
  "lines": [
    { "description": "Website services", "quantity": 2, "unitPriceCents": 10005, "discountCents": 10, "taxable": true },
    { "description": "Untaxed example", "quantity": 1, "unitPriceCents": 200, "taxable": false }
  ],
  "taxes": [
    { "code": "GST", "label": "Example GST", "rateMilliPercent": 5000 },
    { "code": "QST", "label": "Example QST", "rateMilliPercent": 9975 }
  ]
}
```

Submit the JSON only from a secure backend/test client with your private administrator header (never from an unauthenticated web page). The example returns subtotal `20200` cents, illustrative taxes `1000` and `1995` cents, and total `23195` cents, plus explicit `PREVIEW_ONLY`, `persisted: false`, `waveSynced: false` and `emailed: false`. No invoice number is assigned.

## Deployment remains pending

Do not deploy until MochaHost confirms the separate `facturations.bolon.ca` DNS/SSL and Node.js environment. Configure `NODE_ENV=production`, `TAKATAK_ADMIN_KEY` and `WAVE_ACCESS_TOKEN` **only in that application's private environment** and start using `app.js`. Do not place credentials in GitHub or the document root. Never restart or change `takatak.ca` or another production service.

Before progressing from previews to persistent customer records and actual invoicing, build a dedicated database, proper user authentication, access control, audit logs, business isolation, invoice numbering, approval workflow, idempotency and validated Wave integration. The tests use mocked Wave responses; they do not prove live Wave or MochaHost connectivity.
