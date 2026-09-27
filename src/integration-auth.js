'use strict';

const crypto = require('node:crypto');

const ROLES = new Set(['OWNER', 'STAFF']);
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const JTI = /^[A-Za-z0-9._:-]{16,128}$/u;

class IntegrationAuthError extends Error {
  constructor(code, statusCode = 401) {
    super(code);
    this.name = 'IntegrationAuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function decodeBase64Url(value, code) {
  if (typeof value !== 'string' || !value || !BASE64URL.test(value)) {
    throw new IntegrationAuthError(code);
  }
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    throw new IntegrationAuthError(code);
  }
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntegrationAuthError(code);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    throw new IntegrationAuthError(code);
  }
}

function verifySignature(signingInput, encodedSignature, secret) {
  const provided = decodeBase64Url(encodedSignature, 'INVALID_INTEGRATION_TOKEN');
  const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function verifyIntegrationBearer({
  authorization,
  secret,
  issuer,
  audience,
  businessId,
  nowMs = Date.now(),
} = {}) {
  if (typeof secret !== 'string' || secret.length < 32 ||
      typeof issuer !== 'string' || !issuer ||
      typeof audience !== 'string' || !audience ||
      typeof businessId !== 'string' || !businessId) {
    throw new IntegrationAuthError('INTEGRATION_NOT_CONFIGURED', 503);
  }
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    throw new IntegrationAuthError('INTEGRATION_AUTH_REQUIRED');
  }
  const token = authorization.slice('Bearer '.length);
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !part)) {
    throw new IntegrationAuthError('INVALID_INTEGRATION_TOKEN');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(decodeBase64Url(encodedHeader, 'INVALID_INTEGRATION_TOKEN').toString('utf8'));
    payload = JSON.parse(decodeBase64Url(encodedPayload, 'INVALID_INTEGRATION_TOKEN').toString('utf8'));
  } catch (error) {
    if (error instanceof IntegrationAuthError) throw error;
    throw new IntegrationAuthError('INVALID_INTEGRATION_TOKEN');
  }

  exactObject(header, ['alg', 'typ'], 'INVALID_INTEGRATION_TOKEN');
  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    throw new IntegrationAuthError('INVALID_INTEGRATION_TOKEN');
  }
  if (!verifySignature(`${encodedHeader}.${encodedPayload}`, encodedSignature, secret)) {
    throw new IntegrationAuthError('INVALID_INTEGRATION_TOKEN');
  }

  exactObject(payload, [
    'version', 'iss', 'aud', 'sub', 'business_id', 'roles', 'iat', 'exp', 'jti',
  ], 'INVALID_INTEGRATION_CLAIMS');

  if (payload.version !== 1 ||
      payload.iss !== issuer ||
      payload.aud !== audience ||
      payload.business_id !== businessId ||
      typeof payload.sub !== 'string' || payload.sub.length < 8 || payload.sub.length > 200 ||
      typeof payload.jti !== 'string' || !JTI.test(payload.jti) ||
      !Array.isArray(payload.roles) || payload.roles.length < 1 || payload.roles.length > 2 ||
      payload.roles.some(role => typeof role !== 'string' || !ROLES.has(role)) ||
      new Set(payload.roles).size !== payload.roles.length ||
      !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) {
    throw new IntegrationAuthError('INVALID_INTEGRATION_CLAIMS');
  }

  const now = Math.floor(nowMs / 1000);
  if (payload.iat > now + 10 || payload.exp <= now - 10 ||
      payload.exp <= payload.iat || payload.exp - payload.iat > 90) {
    throw new IntegrationAuthError('EXPIRED_OR_INVALID_INTEGRATION_TOKEN');
  }

  return Object.freeze({
    subject: payload.sub,
    businessId: payload.business_id,
    roles: Object.freeze([...payload.roles]),
    jti: payload.jti,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  });
}

module.exports = {
  verifyIntegrationBearer,
  IntegrationAuthError,
};
