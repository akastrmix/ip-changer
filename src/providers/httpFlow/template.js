const { hasOwn, isObject } = require('./common');

function compileTemplateText(raw, {
  availableVars = null,
  env = process.env,
  label = 'template'
} = {}) {
  const text = String(raw ?? '');
  const parts = [];
  let cursor = 0;
  const re = /\$\{([^}]+)\}/g;
  let match;

  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) {
      parts.push({ type: 'text', value: text.slice(cursor, match.index) });
    }
    cursor = match.index + match[0].length;

    const expr = String(match[1] || '').trim();
    if (!expr) throw new Error(`${label}: empty template expression`);

    if (expr.startsWith('ENV:')) {
      const envName = expr.slice(4).trim();
      if (!envName) throw new Error(`${label}: empty env expression`);
      if (!hasOwn(env, envName)) throw new Error(`${label}: env var not found: ${envName}`);
      parts.push({ type: 'env', name: envName });
      continue;
    }

    const varName = expr;
    if (availableVars && !availableVars.has(varName)) {
      throw new Error(`${label}: template references unknown var: ${varName}`);
    }
    parts.push({ type: 'var', name: varName });
  }

  if (cursor < text.length) {
    parts.push({ type: 'text', value: text.slice(cursor) });
  }

  return { kind: 'template_text', parts };
}

function hasVarRefs(compiledText) {
  return compiledText.parts.some((part) => part.type === 'var');
}

function renderTemplateText(compiledText, { vars = {}, env = process.env } = {}) {
  const out = [];
  for (const part of compiledText.parts) {
    if (part.type === 'text') {
      out.push(part.value);
      continue;
    }
    if (part.type === 'env') {
      if (!hasOwn(env, part.name)) throw new Error(`env var not found: ${part.name}`);
      out.push(String(env[part.name] ?? ''));
      continue;
    }
    if (!hasOwn(vars, part.name)) throw new Error(`flow var not found: ${part.name}`);
    out.push(String(vars[part.name] ?? ''));
  }
  return out.join('');
}

function compileTemplateValue(value, options = {}) {
  if (typeof value === 'string') {
    return {
      kind: 'string',
      value: compileTemplateText(value, options)
    };
  }
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      items: value.map((item) => compileTemplateValue(item, options))
    };
  }
  if (isObject(value)) {
    const entries = [];
    for (const [k, v] of Object.entries(value)) {
      entries.push([k, compileTemplateValue(v, options)]);
    }
    return {
      kind: 'object',
      entries
    };
  }
  return { kind: 'literal', value };
}

function renderTemplateValue(compiledValue, ctx = {}) {
  if (compiledValue.kind === 'string') {
    return renderTemplateText(compiledValue.value, ctx);
  }
  if (compiledValue.kind === 'array') {
    return compiledValue.items.map((item) => renderTemplateValue(item, ctx));
  }
  if (compiledValue.kind === 'object') {
    const out = {};
    for (const [k, v] of compiledValue.entries) {
      out[k] = renderTemplateValue(v, ctx);
    }
    return out;
  }
  return compiledValue.value;
}

module.exports = {
  compileTemplateText,
  compileTemplateValue,
  hasVarRefs,
  renderTemplateText,
  renderTemplateValue
};
