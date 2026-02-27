const { URL, URLSearchParams } = require('url');

const { renderTemplateText, renderTemplateValue } = require('./template');
const { getHeader, hasHeader, headerToText, requestWithRedirects } = require('./httpClient');

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

async function executeRequestStep(step, ctx, defaults, env) {
  const headers = {};
  for (const entry of step.headers) {
    const value = renderTemplateValue(entry.valueTemplate, { vars: ctx.vars, env });
    headers[entry.name] = String(value ?? '');
  }

  let body = null;
  if (step.bodyMode === 'json') {
    body = JSON.stringify(renderTemplateValue(step.bodyValueTemplate, { vars: ctx.vars, env }));
    if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
  } else if (step.bodyMode === 'form') {
    const params = new URLSearchParams();
    for (const formEntry of step.bodyValueTemplate) {
      const value = renderTemplateValue(formEntry.valueTemplate, { vars: ctx.vars, env });
      params.append(formEntry.key, String(value ?? ''));
    }
    body = params.toString();
    if (!hasHeader(headers, 'content-type')) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
  } else if (step.bodyMode === 'body') {
    const raw = renderTemplateValue(step.bodyValueTemplate, { vars: ctx.vars, env });
    body = typeof raw === 'string' ? raw : JSON.stringify(raw);
  }

  const userAgent = renderTemplateText(
    step.userAgentTemplate || defaults.userAgentTemplate,
    { vars: ctx.vars, env }
  );
  const response = await requestWithRedirects({
    urlObj: resolveStepUrl(step.urlTemplate, ctx, defaults, env),
    method: step.method,
    headers,
    body,
    timeoutMs: step.timeoutMs === null ? defaults.timeoutMs : step.timeoutMs,
    followRedirects: step.followRedirects === null ? defaults.followRedirects : step.followRedirects,
    maxRedirects: step.maxRedirects === null ? defaults.maxRedirects : step.maxRedirects,
    cookieJar: ctx.cookieJar,
    userAgent
  });
  ctx.last = response;

  if (step.expectStatus && !step.expectStatus.includes(response.status)) {
    throw new Error(`expected status ${step.expectStatus.join('/')} but got ${response.status}`);
  }

  if (step.saveBodyAs) ctx.vars[step.saveBodyAs] = response.body;
  if (step.saveStatusAs) ctx.vars[step.saveStatusAs] = String(response.status);
  for (const item of step.saveHeadersAs) {
    const headerName = renderTemplateText(item.headerTemplate, { vars: ctx.vars, env }).trim();
    if (!headerName) throw new Error('save_headers_as resolved empty header name');
    ctx.vars[item.varName] = headerToText(getHeader(response.headers, headerName));
  }
}

async function executeExtractStep(step, ctx, env) {
  const sourceText = readSourceText(step.source, ctx, env, step.label);
  const regex = resolveRegex(step.regex, ctx, env);
  const match = sourceText.match(regex);
  if (!match) throw new Error('extract did not match');
  if (step.group >= match.length) throw new Error(`extract group ${step.group} out of range`);

  let value = String(match[step.group] ?? '');
  if (step.trim) value = value.trim();
  if (step.decodeUriComponent) {
    try {
      value = decodeURIComponent(value);
    } catch (err) {
      throw new Error(`decode_uri_component failed: ${String(err)}`);
    }
  }
  ctx.vars[step.to] = value;
}

async function executeAssertStep(step, ctx, env) {
  const actual = readSourceText(step.source, ctx, env, step.label);
  if (step.op === 'exists') {
    const ok = actual.length > 0;
    if (ok !== step.expected) {
      throw new Error(`assert exists failed (expected ${step.expected}, got ${ok})`);
    }
    return;
  }
  if (step.op === 'equals') {
    const expected = String(renderTemplateValue(step.expectedTemplate, { vars: ctx.vars, env }) ?? '');
    if (actual !== expected) {
      throw new Error(`assert equals failed (expected "${expected}", got "${actual}")`);
    }
    return;
  }
  if (step.op === 'includes') {
    const expected = String(renderTemplateValue(step.expectedTemplate, { vars: ctx.vars, env }) ?? '');
    if (!actual.includes(expected)) {
      throw new Error(`assert includes failed (missing "${expected}")`);
    }
    return;
  }
  if (step.op === 'regex') {
    const regex = resolveRegex(step.regex, ctx, env);
    if (!regex.test(actual)) {
      throw new Error(`assert regex failed: /${regex.source}/${regex.flags}`);
    }
    return;
  }
  throw new Error(`unsupported assert op: ${step.op}`);
}

async function executeSetStep(step, ctx, env) {
  if (step.mode === 'from_env') {
    if (!Object.prototype.hasOwnProperty.call(env, step.envName)) {
      throw new Error(`env var not found: ${step.envName}`);
    }
    ctx.vars[step.name] = String(env[step.envName] ?? '');
    return;
  }
  ctx.vars[step.name] = renderTemplateValue(step.valueTemplate, { vars: ctx.vars, env });
}

async function runCompiledFlow(flow, env = process.env) {
  const ctx = {
    vars: {},
    last: null,
    cookieJar: []
  };

  for (const item of flow.vars) {
    ctx.vars[item.name] = renderTemplateValue(item.valueTemplate, { vars: ctx.vars, env });
  }

  for (const step of flow.steps) {
    try {
      if (step.type === 'request') {
        await executeRequestStep(step, ctx, flow.defaults, env);
      } else if (step.type === 'extract') {
        await executeExtractStep(step, ctx, env);
      } else if (step.type === 'assert') {
        await executeAssertStep(step, ctx, env);
      } else if (step.type === 'sleep') {
        await new Promise((resolve) => setTimeout(resolve, step.ms));
      } else if (step.type === 'set') {
        await executeSetStep(step, ctx, env);
      } else {
        throw new Error(`unsupported step type: ${step.type}`);
      }
    } catch (err) {
      throw new Error(`${step.label}: ${String(err && err.message ? err.message : err)}`);
    }
  }
}

module.exports = {
  runCompiledFlow
};
