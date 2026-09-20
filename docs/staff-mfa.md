# Staff TOTP MFA — backend foundation only

This component is **not** a public login, MFA enrollment webpage, or production-ready account system. It does not issue sessions, emails or invoices. It belongs exclusively to the separate GROUPE TAKATAK Facturations database.

## Setup and trusted enrollment

1. Apply `db/007_staff_totp.sql` only after migrations 001–006 in the dedicated Facturations database; the CI script runs it only on disposable `localhost/facturations_test`.
2. Generate a **new, separate** 32-byte random key using `openssl rand -hex 32`. Keep it in a private secret manager or restricted environment variable, never in GitHub, a URL, logs or user-facing JavaScript. Pass its hexadecimal value into `createStaffTotpStore({pool,businessId,encryptionKeyHex})` on the server only. Reusing a key from any other service is prohibited.
3. After separately verifying a staff member's identity and intended mailbox, a trusted administrator may call `provisionTrusted(staffId)`; the function returns a Base32 secret **once**. Convey it in a securely authenticated enrollment ceremony directly to the intended employee. Do not mail or log the secret in plaintext. The provisioned record is **inactive**.
4. Have the employee enter a current six-digit authenticator code in that trusted ceremony, then call `confirmTrusted(staffId,code)`. The code activates the credential and is consumed; enrollment is never equivalent to merely showing a QR code.
5. For a later login, verify email/password and the TOTP code as a single controlled flow with rate limits, HTTPS and CSRF/Origin defenses. `verify(staffId,code)` atomically consumes one time step and rejects concurrent replay. Do not issue a session before **all** factors pass.

Only SHA-1 HMAC over a 30-second time step is used for RFC-compatible six-digit TOTP, with a one-step tolerance either way. The 20-byte TOTP seed is encrypted using AES-256-GCM with a random nonce and associated data binding it to the business and employee; the encryption key stays outside the database. No seed or live OTP belongs in repository fixtures.

## Remaining prerequisites

A trusted identity-confirmed enrollment UI and delivery mechanism, key rotation and lost-device recovery (requiring separately verified human approval and revoking old sessions), account/IP throttling, full HTTPS/CSRF-safe browser login and logout, MFA policy, backup/restore and operational security review are **not implemented** here. Losing the encryption key makes existing stored TOTP secrets unrecoverable. Do not deploy or advertise login based on this component alone.
