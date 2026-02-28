const { compileTemplateText, hasVarRefs, renderTemplateText } = require('../template');

function parseStrictInt(value, fallback, { min, max, label }) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim();
  if (!/^-?\d+$/.test(raw)) throw new Error(`${label} must be an integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be an integer`);
  if (!Number.isFinite(n)) throw new Error(`${label} must be an integer`);
  if (n < min || n > max) throw new Error(`${label} must be in range ${min}..${max}`);
  return n;
}

function ensureNonEmptyText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is empty`);
  return text;
}

function compileRegexSpec(rawRegex, rawFlags, { availableVars, env, label }) {
  const sourceTemplate = compileTemplateText(String(rawRegex || ''), {
    availableVars,
    env,
    label: `${label}.regex`
  });
  const flags = String(rawFlags || '');
  if (!sourceTemplate.parts.length) {
    throw new Error(`${label}.regex is empty`);
  }

  if (!hasVarRefs(sourceTemplate)) {
    const source = renderTemplateText(sourceTemplate, { vars: {}, env });
    try {
      return {
        sourceTemplate,
        flags,
        precompiled: new RegExp(source, flags)
      };
    } catch (err) {
      throw new Error(`${label}.regex invalid: ${String(err)}`);
    }
  }

  try {
    void new RegExp('', flags);
  } catch (err) {
    throw new Error(`${label}.flags invalid: ${String(err)}`);
  }
  return {
    sourceTemplate,
    flags,
    precompiled: null
  };
}

module.exports = {
  compileRegexSpec,
  ensureNonEmptyText,
  parseStrictInt
};
