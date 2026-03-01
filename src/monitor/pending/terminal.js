const { isValidIpv4 } = require('../../ip/ipv4');
const { postIpEvent } = require('../../network/ipEvents');
const {
  clearChangeSessionIfCurrent,
  markChangeSessionTerminalSent,
  markChangeSessionTimeoutStuckAlert,
  recordChangeSessionError
} = require('../../change/session');
const { recordPendingTimeoutStuckAlert } = require('../../runtime/metrics');

const PENDING_TIMEOUT_STUCK_ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const TERMINAL_SENT_IN_MEMORY = new Set();
const TERMINAL_SENT_IN_MEMORY_MAX = 2000;

function rememberTerminalSent(opId) {
  const id = String(opId || '').trim();
  if (!id) return;
  TERMINAL_SENT_IN_MEMORY.add(id);
  // Bound memory usage if we get stuck in a loop where pending sessions cannot be cleared.
  while (TERMINAL_SENT_IN_MEMORY.size > TERMINAL_SENT_IN_MEMORY_MAX) {
    const oldest = TERMINAL_SENT_IN_MEMORY.values().next().value;
    if (!oldest) break;
    TERMINAL_SENT_IN_MEMORY.delete(oldest);
  }
}

function isTerminalSentRemembered(opId) {
  const id = String(opId || '').trim();
  if (!id) return false;
  return TERMINAL_SENT_IN_MEMORY.has(id);
}

function forgetTerminalSent(opId) {
  const id = String(opId || '').trim();
  if (!id) return;
  TERMINAL_SENT_IN_MEMORY.delete(id);
}

function isInvalidEventPayloadError(errorText) {
  return String(errorText || '').startsWith('invalid event payload:');
}

function extractTerminalObservedIpv4(terminal) {
  const newIpv4 = String(terminal?.new_ipv4 || '').trim();
  if (isValidIpv4(newIpv4)) return newIpv4;
  // For change_no_change, the observed IPv4 is old_ipv4 (new_ipv4 is intentionally omitted).
  const event = String(terminal?.event || '').trim();
  if (event === 'change_no_change') {
    const oldIpv4 = String(terminal?.old_ipv4 || '').trim();
    if (isValidIpv4(oldIpv4)) return oldIpv4;
  }
  return '';
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
      const ipv4 = extractTerminalObservedIpv4(terminal);
      const marked = markChangeSessionTerminalSent(config, opId, {
        event: terminal.event,
        reason: terminal.reason,
        ipv4,
        sentAtIso: terminal.ts
      });
      if (!marked) {
        recordChangeSessionError(config, opId, 'failed to persist terminal_sent after terminal report');
      }
      rememberTerminalSent(opId);

      if (!clearOnSuccess) return { done: false, posted: true };
      const cleared = clearChangeSessionIfCurrent(config, opId);
      if (cleared) {
        forgetTerminalSent(opId);
        return { done: true };
      }
      recordChangeSessionError(config, opId, clearErrorMessage);
      return { done: false };
    }

    const errorText = String(result.error || 'unknown');
    recordChangeSessionError(config, opId, errorText);
    if (isInvalidEventPayloadError(errorText)) {
      console.error(
        `[changeip-http] terminal payload invalid for op_id=${opId}, clearing session: ${errorText}`
      );
      const cleared = clearChangeSessionIfCurrent(config, opId);
      if (cleared) {
        forgetTerminalSent(opId);
        return { done: true, unrecoverable: true };
      }
      recordChangeSessionError(config, opId, 'failed to clear pending after unrecoverable invalid payload');
      return { done: false, unrecoverable: true };
    }
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

function shouldPersistTerminalIpState(pending) {
  const event = String(pending?.terminal_event || '').trim();
  if (!event) return false;
  const ipv4 = String(pending?.terminal_ipv4 || '').trim();
  return isValidIpv4(ipv4);
}

function shouldUpdateNotifiedIpv4ForTerminal(pending) {
  return String(pending?.terminal_event || '').trim() === 'change_succeeded';
}

module.exports = {
  extractTerminalObservedIpv4,
  forgetTerminalSent,
  isInvalidEventPayloadError,
  isTerminalSentRemembered,
  maybeReportPendingTimeoutStuck,
  postTerminalEventAndHandleSession,
  rememberTerminalSent,
  shouldPersistTerminalIpState,
  shouldUpdateNotifiedIpv4ForTerminal
};
