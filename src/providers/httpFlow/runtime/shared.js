const { URL } = require('url');

const { renderTemplateText } = require('../template');
const { getHeader, headerToText } = require('../httpClient');

function resolveStepUrl(urlTemplate, ctx, defaults, env) {
  const text = renderTemplateText(urlTemplate, { vars: ctx.vars, env });
  try {
    return new URL(text);
  } catch {
    if (ctx.last?.url) return new URL(text, ctx.last.url);
    if (defaults.baseUrl) return new URL(text, defaults.baseUrl);
    throw new Error('relative url requires base_url or a previous request step');
  }
}

function resolveRegex(regexSpec, ctx, env) {
  if (regexSpec.precompiled) return regexSpec.precompiled;
  const source = renderTemplateText(regexSpec.sourceTemplate, { vars: ctx.vars, env });
  try {
    return new RegExp(source, regexSpec.flags);
  } catch (err) {
    throw new Error(`regex build failed: ${String(err)}`);
  }
}

function readSourceText(source, ctx, env, stepLabel) {
  if (!ctx.last && (source.from === 'body' || source.from === 'status' || source.from === 'header')) {
    throw new Error(`${stepLabel}: requires a previous request step`);
  }
  if (source.from === 'body') return String(ctx.last.body || '');
  if (source.from === 'status') return String(ctx.last.status || 0);
  if (source.from === 'header') {
    const headerName = renderTemplateText(source.headerTemplate, { vars: ctx.vars, env }).trim();
    if (!headerName) throw new Error(`${stepLabel}: header source resolved to empty name`);
    return headerToText(getHeader(ctx.last.headers, headerName));
  }
  if (source.from === 'var') {
    return Object.prototype.hasOwnProperty.call(ctx.vars, source.varName)
      ? String(ctx.vars[source.varName] ?? '')
      : '';
  }
  throw new Error(`${stepLabel}: unsupported source ${source.from}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  readSourceText,
  resolveRegex,
  resolveStepUrl,
  sleep
};
