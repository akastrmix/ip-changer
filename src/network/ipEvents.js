const { postJson } = require('./http');
const {
  IP_EVENT_TYPES,
  IP_EVENTS_CONTRACT_VERSION,
  validateEventPayload
} = require('../contracts/ipEvents');
const {
  recordIpEventPostAttempt,
  recordIpEventPostFailure,
  recordIpEventPostSuccess
} = require('../runtime/metrics');

function truncate(text, maxLen) {
  const s = String(text || '');
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

const TERMINAL_EVENT_RETRY_SET = new Set([
  IP_EVENT_TYPES.CHANGE_SUCCEEDED,
  IP_EVENT_TYPES.CHANGE_NO_CHANGE,
  IP_EVENT_TYPES.CHANGE_FAILED
]);
const TERMINAL_EVENT_MAX_ATTEMPTS = 3;
const TERMINAL_EVENT_RETRY_BASE_DELAY_MS = 250;
const TERMINAL_EVENT_RETRY_MAX_DELAY_MS = 1000;

function isRetryableStatus(status) {
  const code = Number(status) || 0;
  if (code === 408 || code === 429) return true;
  return code >= 500 && code <= 599;
}

function computeRetryDelayMs(retryIndex) {
  const expDelay = Math.min(
    TERMINAL_EVENT_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, retryIndex - 1)),
    TERMINAL_EVENT_RETRY_MAX_DELAY_MS
  );
  const jitterMs = Math.floor(Math.random() * 120);
  return expDelay + jitterMs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

async function postIpEvent(config, payload) {
  const event = String(payload?.event || '').trim() || 'unknown';
  const payloadWithContract = {
    ...(payload || {}),
    contract_version: String(payload?.contract_version || '').trim() || IP_EVENTS_CONTRACT_VERSION
  };
  recordIpEventPostAttempt(event);

  if (!config.ipEventsActive) {
    const error = 'ip events disabled';
    recordIpEventPostFailure(event, error);
    return { ok: false, error };
  }
  const contractCheck = validateEventPayload(payloadWithContract);
  if (!contractCheck.ok) {
    const error = `invalid event payload: ${contractCheck.error}`;
    recordIpEventPostFailure(event, error);
    return { ok: false, error };
  }

  const maxAttempts = TERMINAL_EVENT_RETRY_SET.has(event) ? TERMINAL_EVENT_MAX_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) recordIpEventPostAttempt(event);

    let resp;
    try {
      resp = await postJson(config.ipEventsEndpoint, {
        token: config.ipEventsToken,
        body: payloadWithContract,
        timeoutMs: 8000,
        userAgent: 'ip-changer'
      });
    } catch (err) {
      const error = String(err);
      recordIpEventPostFailure(event, error);
      if (attempt < maxAttempts) {
        await sleep(computeRetryDelayMs(attempt));
        continue;
      }
      return { ok: false, error };
    }

    if (resp.ok) {
      recordIpEventPostSuccess(event);
      return { ok: true, error: '' };
    }

    const msg = `${resp.status} ${truncate(resp.text, 200)}`.trim();
    const error = msg || `status ${resp.status}`;
    recordIpEventPostFailure(event, error);
    if (attempt < maxAttempts && isRetryableStatus(resp.status)) {
      await sleep(computeRetryDelayMs(attempt));
      continue;
    }
    return { ok: false, error };
  }

  return { ok: false, error: 'unknown ip event post failure' };
}

module.exports = {
  postIpEvent
};
