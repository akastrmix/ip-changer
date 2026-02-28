const { fetchPublicIpv4, isValidIpv4 } = require('../ip/ipv4');
const { loadIpState, saveIpState } = require('../state');
const { postIpEvent } = require('../network/ipEvents');
const {
  buildChangeTerminalPayload,
  clearChangeSession,
  clearChangeSessionIfCurrent,
  loadChangeSession,
  markChangeSessionOfflineObserved,
  markChangeSessionTimeoutStuckAlert,
  nowIso,
  recordChangeSessionError,
  resolvePendingSessionContext,
  sendChangeStartedEvent
} = require('../change/session');
const { recordPendingTimeoutStuckAlert } = require('../runtime/metrics');
const { computePendingNextDueMs } = require('./helpers');

const PENDING_TIMEOUT_STUCK_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

function isStrictPendingSchema(pending) {
  if (!pending || typeof pending !== 'object') return false;
  if (typeof pending.provider_started !== 'boolean') return false;
  if (typeof pending.provider_failed_reason !== 'string') return false;
  if (typeof pending.started_sent !== 'boolean') return false;
  return true;
}

function isInvalidEventPayloadError(errorText) {
  return String(errorText || '').startsWith('invalid event payload:');
}

async function handleInvalidPendingSession(config, pending, reason) {
  const opId = String(pending?.op_id || '').trim();
  const nowMs = Date.now();
  const intervalMs = Math.max(config.changeMonitorIntervalSeconds, 1) * 1000;
  const fallbackNextDueMs = nowMs + intervalMs;
  const timeoutAtMs = Number(pending?.timeout_at_ms);

  if (!opId) {
    console.error('[changeip-http] invalid pending_change without op_id, clearing session');
    const cleared = clearChangeSession(config);
    if (cleared) return { handled: true, done: true };
    return { handled: true, nextDueMs: fallbackNextDueMs };
  }

  const terminal = buildChangeTerminalPayload({
    opId,
    serverLabel: String(pending?.server_label || '').trim() || config.serverLabel,
    channel: String(pending?.channel || '').trim() || config.reportChannel,
    oldIpv4: pending?.old_ipv4,
    event: 'change_failed',
    reason
  });

  let report;
  try {
    report = await postIpEvent(config, terminal);
  } catch (err) {
    recordChangeSessionError(config, opId, String(err));
    maybeReportPendingTimeoutStuck({
      config,
      opId,
      timeoutAtMs,
      nowMs,
      reason: `invalid_pending_terminal_exception:${String(err || 'unknown')}`
    });
    return { handled: true, nextDueMs: fallbackNextDueMs };
  }

  if (report.ok) {
    const cleared = clearChangeSessionIfCurrent(config, opId);
    if (cleared) return { handled: true, done: true };
    recordChangeSessionError(config, opId, 'failed to clear pending after invalid pending terminal report');
    return { handled: true, nextDueMs: fallbackNextDueMs };
  }

  if (isInvalidEventPayloadError(report.error)) {
    console.error(
      `[changeip-http] invalid pending terminal payload for op_id=${opId}, clearing session: ${String(report.error)}`
    );
    const cleared = clearChangeSessionIfCurrent(config, opId);
    if (cleared) return { handled: true, done: true };
    recordChangeSessionError(config, opId, 'failed to clear pending after unrecoverable invalid payload');
    return { handled: true, nextDueMs: fallbackNextDueMs };
  }

  recordChangeSessionError(config, opId, report.error);
  maybeReportPendingTimeoutStuck({
    config,
    opId,
    timeoutAtMs,
    nowMs,
    reason: `invalid_pending_terminal_rejected:${String(report.error || 'unknown')}`
  });
  return { handled: true, nextDueMs: fallbackNextDueMs };
}

function maybeReportPendingTimeoutStuck({
  config,
  opId,
  timeoutAtMs,
  nowMs,
  reason
}) {
  if (!timeoutAtMs || nowMs < timeoutAtMs) return;
  const shouldAlert = markChangeSessionTimeoutStuckAlert(config, opId, {
    nowMs,
    reason,
    cooldownMs: PENDING_TIMEOUT_STUCK_ALERT_COOLDOWN_MS
  });
  if (!shouldAlert) return;

  const ageMs = Math.max(nowMs - timeoutAtMs, 0);
  const detail = String(reason || 'unknown').slice(0, 300);
  console.error(
    `[changeip-http] ALERT pending change stuck after timeout: op_id=${opId} age_ms=${ageMs} reason=${detail}`
  );
  recordPendingTimeoutStuckAlert(detail);
}

async function postTerminalEventAndHandleSession({
  config,
  opId,
  terminal,
  timeoutAtMs,
  nowMs,
  clearErrorMessage,
  clearOnSuccess = true,
  rejectedReasonPrefix = 'terminal_post_rejected',
  exceptionReasonPrefix = 'terminal_post_exception'
}) {
  try {
    const result = await postIpEvent(config, terminal);
    if (result.ok) {
      if (!clearOnSuccess) return { done: false, posted: true };
      const cleared = clearChangeSessionIfCurrent(config, opId);
      if (cleared) return { done: true };
      recordChangeSessionError(config, opId, clearErrorMessage);
      return { done: false };
    }

    const errorText = String(result.error || 'unknown');
    recordChangeSessionError(config, opId, errorText);
    maybeReportPendingTimeoutStuck({
      config,
      opId,
      timeoutAtMs,
      nowMs,
      reason: `${rejectedReasonPrefix}:${errorText}`
    });
    return { done: false };
  } catch (err) {
    const errorText = String(err || 'unknown');
    recordChangeSessionError(config, opId, errorText);
    maybeReportPendingTimeoutStuck({
      config,
      opId,
      timeoutAtMs,
      nowMs,
      reason: `${exceptionReasonPrefix}:${errorText}`
    });
    return { done: false };
  }
}

async function handlePendingChange(config) {
  const pending = loadChangeSession(config);
  if (!pending) return { handled: false };

  const sessionOpId = String(pending.op_id || '').trim();
  if (!sessionOpId) {
    return handleInvalidPendingSession(config, pending, 'invalid_pending_op_id');
  }

  if (!isStrictPendingSchema(pending)) {
    return handleInvalidPendingSession(config, pending, 'invalid_pending_schema');
  }

  const session = resolvePendingSessionContext(config, pending);
  if (!session) {
    return handleInvalidPendingSession(config, pending, 'invalid_pending_timing');
  }

  const {
    opId,
    serverLabel,
    channel,
    startedAt,
    rebootDelayMinutes,
    monitorAfterMs,
    timeoutAtMs
  } = session;

  let nowMs = Date.now();
  const intervalMs = Math.max(config.changeMonitorIntervalSeconds, 1) * 1000;
  let fallbackNextDueMs = nowMs + intervalMs;

  const providerStarted = pending.provider_started !== false;
  if (!providerStarted) {
    const terminal = buildChangeTerminalPayload({
      opId,
      serverLabel,
      channel,
      oldIpv4: pending.old_ipv4,
      event: 'change_failed',
      reason: String(pending.provider_failed_reason || 'provider_start_failed').slice(0, 300)
    });
    const posted = await postTerminalEventAndHandleSession({
      config,
      opId,
      terminal,
      timeoutAtMs,
      nowMs,
      clearErrorMessage: 'failed to clear pending after provider_failed terminal report',
      rejectedReasonPrefix: 'provider_failed_terminal_rejected',
      exceptionReasonPrefix: 'provider_failed_terminal_exception'
    });
    if (posted.done) return { handled: true, done: true };

    const nextDueMs = computePendingNextDueMs({
      nowMs,
      timeoutAtMs,
      fallbackNextDueMs
    });
    return { handled: true, nextDueMs };
  }

  if (!pending.started_sent && startedAt) {
    await sendChangeStartedEvent(config, opId);
    nowMs = Date.now();
    fallbackNextDueMs = nowMs + intervalMs;
  }

  if (monitorAfterMs && nowMs < monitorAfterMs) {
    return { handled: true, nextDueMs: monitorAfterMs };
  }

  let ip;
  try {
    ip = await fetchPublicIpv4({ userAgent: 'ip-changer' });
  } catch (err) {
    if (rebootDelayMinutes === -1 && !pending.offline_observed) {
      markChangeSessionOfflineObserved(config, opId);
    }

    if (timeoutAtMs && nowMs >= timeoutAtMs) {
      const payload = buildChangeTerminalPayload({
        opId,
        serverLabel,
        channel,
        oldIpv4: pending.old_ipv4,
        event: 'change_failed',
        reason: 'no_ipv4_observed'
      });
      const posted = await postTerminalEventAndHandleSession({
        config,
        opId,
        terminal: payload,
        timeoutAtMs,
        nowMs,
        clearErrorMessage: 'failed to clear pending after no_ipv4_observed terminal report'
      });
      if (posted.done) return { handled: true, done: true };
    }

    const nextDueMs = computePendingNextDueMs({
      nowMs,
      timeoutAtMs,
      fallbackNextDueMs
    });
    return { handled: true, nextDueMs };
  }

  const oldIpv4 = isValidIpv4(pending.old_ipv4) ? pending.old_ipv4 : null;
  let terminal;
  if (!oldIpv4) {
    terminal = buildChangeTerminalPayload({
      opId,
      serverLabel,
      channel,
      newIpv4: ip,
      event: 'change_failed',
      reason: 'old_ipv4_unknown'
    });
  } else if (ip === oldIpv4) {
    if (rebootDelayMinutes === -1 && !pending.offline_observed) {
      if (timeoutAtMs && nowMs >= timeoutAtMs) {
        terminal = buildChangeTerminalPayload({
          opId,
          serverLabel,
          channel,
          oldIpv4,
          event: 'change_no_change'
        });
      } else {
        const nextDueMs = computePendingNextDueMs({
          nowMs,
          timeoutAtMs,
          fallbackNextDueMs
        });
        return { handled: true, nextDueMs };
      }
    } else {
      terminal = buildChangeTerminalPayload({
        opId,
        serverLabel,
        channel,
        oldIpv4,
        event: 'change_no_change'
      });
    }
  } else {
    terminal = buildChangeTerminalPayload({
      opId,
      serverLabel,
      channel,
      oldIpv4,
      newIpv4: ip,
      event: 'change_succeeded'
    });
  }

  const posted = await postTerminalEventAndHandleSession({
    config,
    opId,
    terminal,
    timeoutAtMs,
    nowMs,
    clearErrorMessage: 'failed to clear pending after terminal report',
    clearOnSuccess: false
  });
  if (!posted.posted) {
    return { handled: true, nextDueMs: fallbackNextDueMs };
  }

  const ipState = loadIpState(config);
  ipState.observed_ipv4 = ip;
  ipState.updated_at = nowIso();
  if (terminal.event === 'change_succeeded') {
    ipState.notified_ipv4 = ip;
    ipState.last_report_at = ipState.updated_at;
    ipState.last_report_error = '';
  }
  const saved = saveIpState(config, ipState);
  if (!saved.ok) {
    recordChangeSessionError(config, opId, `failed to persist ip state: ${saved.error}`);
    return { handled: true, nextDueMs: fallbackNextDueMs };
  }

  const cleared = clearChangeSessionIfCurrent(config, opId);
  if (!cleared) {
    recordChangeSessionError(config, opId, 'failed to clear pending after terminal report');
    return { handled: true, nextDueMs: fallbackNextDueMs };
  }
  return { handled: true, done: true };
}

module.exports = {
  handlePendingChange
};
