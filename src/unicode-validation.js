'use strict';

// JSON.parse accepts lone UTF-16 surrogates in escaped strings, while PostgreSQL
// jsonb rejects them. Check code units without replacing valid supplementary text.
function hasUnpairedSurrogate(value) {
  if (typeof value !== 'string') throw new TypeError('String required');
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (i + 1 >= value.length) return true;
      const next = value.charCodeAt(++i);
      if (next < 0xdc00 || next > 0xdfff) return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

module.exports = { hasUnpairedSurrogate };
