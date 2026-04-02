const {
  buildChangeTerminalPayload,
  clearChangeSession,
  clearChangeSessionIfCurrent,
  recordChangeSessionError
} = require('../../change/session');
const { postTerminalEventAndHandleSession, isTerminalSentRemembered, forgetTerminalSent } = require('./terminal');

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

  if (pending.terminal_sent === true || isTerminalSentRemembered(opId)) {
    const cleared = clearChangeSessionIfCurrent(config, opId);
    if (cleared) {
      forgetTerminalSent(opId);
      return { handled: true, done: true };
    }
    recordChangeSessionError(config, opId, 'failed to clear invalid pending after terminal already sent');
    return { handled: true, nextDueMs: fallbackNextDueMs };
  }

  const terminal = buildChangeTerminalPayload({
    opId,
    serverLabel: String(pending?.server_label || '').trim() || config.serverLabel,
    channel: String(pending?.channel || '').trim(),
    oldIpv4: pending?.old_ipv4,
    event: 'change_failed',
    reason
  });

  const posted = await postTerminalEventAndHandleSession({
    config,
    opId,
    terminal,
    timeoutAtMs,
    nowMs,
    clearErrorMessage: 'failed to clear pending after invalid pending terminal report',
    rejectedReasonPrefix: 'invalid_pending_terminal_rejected',
    exceptionReasonPrefix: 'invalid_pending_terminal_exception'
  });
  if (posted.done) return { handled: true, done: true };

  return { handled: true, nextDueMs: fallbackNextDueMs };
}

module.exports = {
  handleInvalidPendingSession
};
