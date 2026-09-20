'use strict';

const COOKIE_NAME = '__Host-facturations-session';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_COOKIE_HEADER = 4096;

// Accept only the session cookie. Duplicates and malformed tokens fail closed.
// Never trust this token without the tenant-scoped DB getSession() check.
function readStaffSessionCookie(header) {
  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_COOKIE_HEADER) return null;
  let token = null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const equals = trimmed.indexOf('=');
    if (equals < 0 || trimmed.slice(0, equals).trim() !== COOKIE_NAME) continue;
    const candidate = trimmed.slice(equals + 1);
    if (token !== null || !TOKEN_PATTERN.test(candidate)) return null;
    token = candidate;
  }
  return token;
}

// These builders are backend-only and are NOT used to issue sessions until a
// separate login flow has passed HTTPS, CSRF, MFA and trusted-edge limits.
function createStaffSessionCookie(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new TypeError('Invalid session token');
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=43200; Secure; HttpOnly; SameSite=Strict`;
}

function clearStaffSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

module.exports = { COOKIE_NAME, readStaffSessionCookie, createStaffSessionCookie, clearStaffSessionCookie };
