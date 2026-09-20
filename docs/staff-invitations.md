# GROUPE TAKATAK — staff invitation and account activation foundation

**Development-only backend module. Not a public registration service, production-ready login or email-delivery system.**

## What this change implements

Apply `db/004_staff_invitations.sql` after `001`, `002`, and `003` **only in a new, isolated Facturations database**. The disposable GitHub CI database applies migrations in order. A trusted server-side provisioning process can first call `createStaffAuthStore({pool,businessId}).createPendingStaff({email,password,role})`. It then calls `createStaffInvitationStore({pool,businessId}).issueInvitation({staffId})` to generate a cryptographically random one-time token that expires after 24 hours. The raw token is returned once and never persisted; PostgreSQL stores only its SHA-256 digest. A replacement invitation invalidates the previous one in the same transaction.

After the owner has independently confirmed the intended recipient and a **future audited, secure invitation-delivery integration** has delivered the token to that mailbox, `redeemInvitation({token,password})` atomically verifies the token's tenant, expiry, state and the pending enabled staff member, sets the user's chosen scrypt password, records email verification, consumes the invitation, and revokes other sessions. Replays, invalid/expired/revoked tokens, cross-business redemption and concurrent double redemption fail closed. All operations scope to the server-configured business and use row locks to serialize issuance/redemption.

**Critical limitation:** Possession of a token is proof of mailbox control **only if its delivery to the correct mailbox was genuinely authenticated and secure**. No email sender or public redemption endpoint exists yet. Never paste tokens into GitHub, CI logs, tickets, chat or screenshots. Do not call `issueInvitation` or `redeemInvitation` with real accounts before approved enrollment/delivery, rate limiting, MFA and browser session security are completed. The earlier `createPendingStaff` password is superseded at redemption; a future trusted bootstrap should avoid collecting a password before invitation delivery.

## Still missing before launch

- Trusted OWNER bootstrap, audited invitation issuance and verified email delivery with appropriate retry and bounce handling.
- Protected HTTP activation/login endpoints, distributed rate limiting, MFA for privileged roles, secure HttpOnly/SameSite cookie sessions, CSRF defense, session rotation and credential recovery.
- Server-side role and tenant checks on each dashboard/client route, cross-customer access tests, independent privacy/security review and staging acceptance.
- Dedicated least-privilege runtime database role, secure backup/restore verification and MochaHost DNS/SSL environment sign-off.

No existing TAKATAK application/database was touched, no Wave write/email occurred and nothing was deployed.
