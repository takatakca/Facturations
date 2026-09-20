# GROUPE TAKATAK — Facturations

Independent Node.js Wave Accounting connector for `facturations.bolon.ca`.

**Phase 1 only:** protected read-only Wave business connectivity and tests. No invoice creation, approval, email delivery, OAuth callback, or production deployment yet.

This repository is public by the owner's choice. Never commit API keys, `.env`, client information or invoices.

Run `npm run check` and `npm test` before deployment. The Wave token and administrator key must be configured only through private environment variables. Existing TAKATAK production services must remain untouched.
