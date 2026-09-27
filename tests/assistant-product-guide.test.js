'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getProductGuide } = require('../src/assistant-product-guide');

test('product guide is bilingual and screen-specific without secrets or customer data', () => {
  for (const language of ['fr', 'en']) {
    for (const screenId of [
      'dashboard',
      'draft-editor',
      'saved-drafts',
      'customers',
      'review',
      'client-portal',
      'assistant',
      'settings',
      'unknown',
    ]) {
      const guide = getProductGuide(language, screenId);
      assert.equal(guide.version, 1);
      assert.equal(guide.language, language);
      assert.ok(typeof guide.title === 'string' && guide.title.length > 0);
      assert.ok(Array.isArray(guide.facts) && guide.facts.length > 0);
      const serialized = JSON.stringify(guide);
      assert.doesNotMatch(serialized, /OPENAI_API_KEY|FACTURATIONS_DATABASE_URL|TOTP|session cookie/i);
      assert.doesNotMatch(serialized, /@example\.(com|test)/i);
    }
  }
});

test('unknown screen falls back to non-inventive guide', () => {
  const guide = getProductGuide('fr', 'not-real');
  assert.equal(guide.screenId, 'unknown');
  assert.match(guide.facts.join(' '), /ne pas inventer/i);
});

test('guide fails closed on unsupported language', () => {
  assert.throws(() => getProductGuide('es', 'dashboard'), TypeError);
});

test('assistant guide preserves preview-only and human-workflow boundaries', () => {
  const fr = getProductGuide('fr', 'assistant');
  const text = fr.facts.join(' ');
  assert.match(text, /PREVIEW_ONLY/);
  assert.match(text, /rien n’est sauvegardé, émis ou envoyé/);

  const review = getProductGuide('en', 'review');
  assert.match(review.facts.join(' '), /does not mean an invoice was issued, sent, paid/i);
});
