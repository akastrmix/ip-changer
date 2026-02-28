const { URLSearchParams } = require('url');

const { renderTemplateText, renderTemplateValue } = require('../template');
const { getHeader, hasHeader, headerToText, requestWithRedirects } = require('../httpClient');
const { resolveStepUrl, sleep } = require('./shared');

const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;

function resolveRetryDelayMs(step, response) {
  const fallbackMs = Math.max(Number(step.retryDelayMs) || 0, 0);
  const rawRetryAfter = headerToText(getHeader(response?.headers || {}, 'retry-after')).trim();
  if (!rawRetryAfter) return fallbackMs;

  let delayMs = NaN;
  if (/^\d+$/.test(rawRetryAfter)) {
    delayMs = Number.parseInt(rawRetryAfter, 10) * 1000;
  } else {
    const whenMs = Date.parse(rawRetryAfter);
    if (Number.isFinite(whenMs)) {
      delayMs = Math.max(0, whenMs - Date.now());
    }
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) return fallbackMs;
  return Math.min(delayMs, MAX_RETRY_AFTER_MS);
}

function saveRequestOutputs(step, ctx, env, response) {
  if (step.saveBodyAs) ctx.vars[step.saveBodyAs] = String(response.body || '');
  if (step.saveStatusAs) ctx.vars[step.saveStatusAs] = String(response.status || 0);
  for (const item of step.saveHeadersAs) {
    const headerName = renderTemplateText(item.headerTemplate, { vars: ctx.vars, env }).trim();
    if (!headerName) throw new Error('save_headers_as resolved empty header name');
    ctx.vars[item.varName] = headerToText(getHeader(response.headers, headerName));
  }
}

function resolveRequestTimeoutMs(baseTimeoutMs, deadlineMs) {
  if (!Number.isFinite(deadlineMs)) return baseTimeoutMs;
  const remainingMs = Math.max(Math.trunc(deadlineMs - Date.now()), 0);
  if (remainingMs <= 0) {
    throw new Error('wait_until deadline exceeded');
  }
  return Math.max(Math.min(baseTimeoutMs, remainingMs), 1);
}

async function sleepWithinDeadline(ms, deadlineMs) {
  if (!Number.isFinite(deadlineMs)) {
    await sleep(ms);
    return;
  }

  const remainingMs = Math.max(Math.trunc(deadlineMs - Date.now()), 0);
  if (remainingMs <= 0) {
    throw new Error('wait_until deadline exceeded');
  }

  await sleep(Math.min(ms, remainingMs));

  if (Date.now() > deadlineMs) {
    throw new Error('wait_until deadline exceeded');
  }
}

async function executeRequestStep(step, ctx, defaults, env, { deadlineMs = NaN } = {}) {
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
  const stepUrl = resolveStepUrl(step.urlTemplate, ctx, defaults, env);
  const totalAttempts = 1 + Math.max(step.retries || 0, 0);
  const defaultTimeoutMs = step.timeoutMs === null ? defaults.timeoutMs : step.timeoutMs;
  let lastError = null;

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    if (Number.isFinite(deadlineMs) && Date.now() > deadlineMs) {
      throw new Error('wait_until deadline exceeded');
    }

    let response;
    try {
      response = await requestWithRedirects({
        urlObj: stepUrl,
        method: step.method,
        headers,
        body,
        timeoutMs: resolveRequestTimeoutMs(defaultTimeoutMs, deadlineMs),
        followRedirects: step.followRedirects === null ? defaults.followRedirects : step.followRedirects,
        maxRedirects: step.maxRedirects === null ? defaults.maxRedirects : step.maxRedirects,
        cookieJar: ctx.cookieJar,
        userAgent
      });
    } catch (err) {
      if (step.allowNetworkError) {
        ctx.last = {
          status: 0,
          headers: {},
          body: '',
          url: stepUrl,
          request_error: String(err && err.message ? err.message : err)
        };
        saveRequestOutputs(step, ctx, env, ctx.last);
        return;
      }
      lastError = err;
      if (attempt + 1 < totalAttempts) {
        await sleepWithinDeadline(step.retryDelayMs, deadlineMs);
        continue;
      }
      throw err;
    }

    ctx.last = response;
    if (step.expectStatus && !step.expectStatus.includes(response.status)) {
      lastError = new Error(`expected status ${step.expectStatus.join('/')} but got ${response.status}`);
      if (attempt + 1 < totalAttempts) {
        await sleepWithinDeadline(resolveRetryDelayMs(step, response), deadlineMs);
        continue;
      }
      throw lastError;
    }

    saveRequestOutputs(step, ctx, env, response);
    return;
  }

  if (lastError) {
    throw lastError;
  }
}

module.exports = {
  executeRequestStep
};
