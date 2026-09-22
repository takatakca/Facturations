'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loginDriver, editorDriver } = require('../scripts/owner-review-chrome-drivers');

for (const lang of ['fr', 'en']) {
  test(`generated ${lang} owner Chrome drivers parse and keep deliberate confirmations`, () => {
    const login = loginDriver(lang, `owner-${lang}@example.test`, 'fictional-only-password', '123456');
    const editor = editorDriver(lang);
    assert.doesNotThrow(() => new vm.Script(login));
    assert.doesNotThrow(() => new vm.Script(editor));
    assert.match(editor, /CREATE_IMMUTABLE_DRAFT_ONLY/);
    assert.match(editor, /APPROVE_DRAFT_ONLY/);
    assert.match(editor, /UNISSUED DRAFT/);
    assert.doesNotMatch(editor, /WAVE_ACCESS_TOKEN|invoiceSend|invoiceCreate/);
  });
}
