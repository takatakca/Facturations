# Bilingual read-only dashboard — development-only access

`GET /internal/dashboard?lang=fr` (or `lang=en`) renders a responsive, server-side HTML view from the same tenant-scoped PostgreSQL summary and recent-draft list as the existing JSON API. The page has no scripts, forms, external assets, browser-stored tokens, login, or write actions. Customer email, street address, full invoice contents, Wave credentials and internal approval details are not included. Draft totals are **never** presented as issued invoices, payments or revenue.

## Access restrictions

The route accepts `GET` only and requires an already valid, unexpired and unrevoked staff `Authorization: Bearer …` session, independently scoped to the configured business. A missing or invalid bearer is denied; `X-Admin-Key` **cannot** access the HTML page and cannot serve as a fallback. A normal browser address-bar navigation does not supply this header: this is a backend/UI integration foundation, **not** a public or production-ready dashboard. Do not put a bearer token in a URL, browser script, localStorage, screenshot, commit or public issue. HTML output escapes all customer-controlled text and sets no-store, a restrictive Content Security Policy and anti-framing headers.

## Test and release limits

Synthetic-only unit and HTTP integration tests exercise both languages, HTML escaping, invalid input and authorization. Existing PostgreSQL tests cover the tenant-scoped dashboard data sources. No MochaHost deployment, Wave write, invoice issuance, customer communication or actual login is included. Before exposing this page in a browser, build and test audited owner enrollment, MFA, HttpOnly/Secure/SameSite cookie sessions, CSRF defenses, logout/revocation, rate limits, session rotation and a separate customer portal. Verify all protections in isolated staging and never migrate an existing TAKATAK production database.
