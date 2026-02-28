const { isValidIpv4 } = require('../ip/ipv4');
const { postIpEvent } = require('../network/ipEvents');
const { loadPendingChange, savePendingChange, clearPendingChange } = require('../state');

const DEFAULT_TIMEOUT_STUCK_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function isSameOp(pending, opId) {
  const currentOpId = String(pending?.op_id || '').trim();
  const targetOpId = String(opId || '').trim();
  if (!currentOpId || !targetOpId) return false;
  return currentOpId === targetOpId;
}

function loadChangeSession(config) {
  const pending = loadPendingChange(config);
  return pending && typeof pending === 'object' ? pending : null;
}

function hasInFlightChangeSession(config) {
  const pending = loadChangeSession(config);
  return !!String(pending?.op_id || '').trim();
}

function computeMonitorWindow(config, startedAtMs) {
  const rebootDelayMs = config.rebootDelayMinutes === -1
    ? 0
    : Math.max(config.rebootDelayMinutes, 1) * 60 * 1000;
  const monitorAfterMs = startedAtMs + rebootDelayMs + config.changeMonitorStartDelaySeconds * 1000;
  const timeoutAtMs = monitorAfterMs + config.changeMonitorTimeoutSeconds * 1000;
  return { monitorAfterMs, timeoutAtMs };
}

function normalizeSessionSeed(config, { opId, oldIpv4, startedAt = new Date() }) {
  const startedAtObj = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const startedAtIso = startedAtObj.toISOString();
  const { monitorAfterMs, timeoutAtMs } = computeMonitorWindow(config, startedAtObj.getTime());
  return {
    opId: String(opId),
    oldIpv4: isValidIpv4(oldIpv4) ? oldIpv4 : null,
    startedAtIso,
    rebootDelayMinutes: config.rebootDelayMinutes,
    monitorAfterMs,
    timeoutAtMs
  };
}

function buildPendingChangeSession(config, sessionSeed) {
  const normalized = normalizeSessionSeed(config, sessionSeed);
  return {
    op_id: normalized.opId,
    server_label: config.serverLabel,
    channel: config.reportChannel,
    old_ipv4: normalized.oldIpv4,
    provider_started: false,
    provider_failed_reason: '',
    started_at: normalized.startedAtIso,
    reboot_delay_minutes: normalized.rebootDelayMinutes,
    started_sent: false,
    monitor_after_ms: normalized.monitorAfterMs,
    timeout_at_ms: normalized.timeoutAtMs,
    timeout_stuck_alert_next_at_ms: 0,
    timeout_stuck_alert_count: 0,
    timeout_stuck_alert_last_at: '',
    timeout_stuck_alert_last_reason: '',
    last_error: ''
  };
}

function mutateChangeSessionIfCurrent(config, opId, mutate) {
  const current = loadChangeSession(config);
  if (!isSameOp(current, opId)) return null;
  const next = { ...current };
  const mutateResult = mutate(next);
  if (mutateResult === false) return current;
  if (JSON.stringify(next) === JSON.stringify(current)) return current;
  const saved = savePendingChange(config, next);
  if (!saved.ok) return null;
  return loadChangeSession(config);
}

function startChangeSession(config, sessionSeed) {
  const inFlight = loadChangeSession(config);
  const inFlightOpId = String(inFlight?.op_id || '').trim();
  if (inFlightOpId) {
    return { ok: false, conflict: true, inFlight: { ...inFlight, op_id: inFlightOpId } };
  }

  const pending = buildPendingChangeSession(config, sessionSeed);
  const saved = savePendingChange(config, pending);
  if (!saved.ok) {
    return { ok: false, conflict: false, error: 'failed to persist change session' };
  }
  const persisted = loadChangeSession(config);
  if (!isSameOp(persisted, pending.op_id)) {
    return { ok: false, conflict: false, error: 'failed to persist change session' };
  }

  return { ok: true, pending: persisted };
}

function clearChangeSession(config) {
  const cleared = clearPendingChange(config);
  return !!cleared.ok;
}

function clearChangeSessionIfCurrent(config, opId) {
  const current = loadChangeSession(config);
  if (!isSameOp(current, opId)) return false;
  const cleared = clearPendingChange(config);
  return !!cleared.ok;
}

function recordChangeSessionError(config, opId, errorText) {
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.last_error = String(errorText || next.last_error || '');
  });
}

function markChangeSessionStarted(config, opId) {
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.started_sent = true;
    next.last_error = '';
  });
}

function markChangeSessionProviderStarted(config, opId) {
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.provider_started = true;
    next.provider_failed_reason = '';
  });
}

function markChangeSessionProviderFailed(config, opId, { reason, reportError } = {}) {
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.provider_started = false;
    next.provider_failed_reason = String(reason || 'provider_start_failed').slice(0, 300);
    if (reportError) {
      next.last_error = String(reportError).slice(0, 500);
    }
  });
}

function setChangeSessionOldIpv4(config, opId, oldIpv4) {
  if (!isValidIpv4(oldIpv4)) return false;
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.old_ipv4 = oldIpv4;
  });
}

function markChangeSessionOfflineObserved(config, opId) {
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.offline_observed = true;
  });
}

function markChangeSessionTimeoutStuckAlert(config, opId, {
  nowMs = Date.now(),
  reason = '',
  cooldownMs = DEFAULT_TIMEOUT_STUCK_ALERT_COOLDOWN_MS
} = {}) {
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const safeCooldownMs = Math.max(1000, Number(cooldownMs) || DEFAULT_TIMEOUT_STUCK_ALERT_COOLDOWN_MS);
  let shouldAlert = false;

  const updated = mutateChangeSessionIfCurrent(config, opId, (next) => {
    const nextAllowedAtMs = Number(next.timeout_stuck_alert_next_at_ms || 0);
    if (Number.isFinite(nextAllowedAtMs) && nextAllowedAtMs > safeNowMs) return false;

    shouldAlert = true;
    next.timeout_stuck_alert_next_at_ms = safeNowMs + safeCooldownMs;
    next.timeout_stuck_alert_count = Math.max(0, Number(next.timeout_stuck_alert_count) || 0) + 1;
    next.timeout_stuck_alert_last_at = new Date(safeNowMs).toISOString();
    next.timeout_stuck_alert_last_reason = String(reason || '').slice(0, 300);
  });

  return shouldAlert && !!updated;
}

function isValidRebootDelayMinutes(value) {
  return value === -1 || (Number.isInteger(value) && value >= 1 && value <= 15);
}

function resolvePendingSessionContext(config, pending) {
  const opId = String(pending?.op_id || '').trim();
  const serverLabel = String(pending?.server_label || '').trim();
  const channel = String(pending?.channel || '').trim();
  const startedAt = String(pending?.started_at || '').trim();
  const startedAtMs = Date.parse(startedAt);
  const rebootDelayMinutes = Number(pending?.reboot_delay_minutes);
  const monitorAfterMs = Number(pending?.monitor_after_ms);
  const timeoutAtMs = Number(pending?.timeout_at_ms);

  if (!opId) return null;
  if (!serverLabel) return null;
  if (!Number.isFinite(startedAtMs)) return null;
  if (!isValidRebootDelayMinutes(rebootDelayMinutes)) return null;
  if (!Number.isFinite(monitorAfterMs) || monitorAfterMs <= 0) return null;
  if (!Number.isFinite(timeoutAtMs) || timeoutAtMs < monitorAfterMs) return null;

  return {
    opId,
    serverLabel,
    channel,
    startedAt,
    startedAtMs,
    rebootDelayMinutes,
    monitorAfterMs,
    timeoutAtMs
  };
}

function buildChangeStartedPayload(config, pending) {
  const payload = {
    server_label: String(pending?.server_label || '').trim() || config.serverLabel,
    channel: String(pending?.channel || '').trim() || config.reportChannel,
    op_id: pending.op_id,
    ts: pending.started_at,
    event: 'change_started'
  };
  if (isValidIpv4(pending.old_ipv4)) payload.old_ipv4 = pending.old_ipv4;
  return payload;
}

function buildChangeTerminalPayload({
  opId,
  serverLabel,
  channel,
  oldIpv4,
  newIpv4,
  event,
  reason,
  ts
}) {
  const payload = {
    server_label: serverLabel,
    channel,
    op_id: opId,
    ts: ts || nowIso(),
    event
  };
  if (isValidIpv4(oldIpv4)) payload.old_ipv4 = oldIpv4;
  if (isValidIpv4(newIpv4)) payload.new_ipv4 = newIpv4;
  if (reason) payload.reason = reason;
  return payload;
}

async function sendChangeStartedEvent(config, opId) {
  const current = loadChangeSession(config);
  if (!isSameOp(current, opId)) return { ok: false, skipped: true };

  let result;
  try {
    result = await postIpEvent(config, buildChangeStartedPayload(config, current));
  } catch (err) {
    result = { ok: false, error: String(err) };
  }

  if (result.ok) {
    markChangeSessionStarted(config, opId);
  } else {
    recordChangeSessionError(config, opId, result.error);
  }
  return result;
}

async function sendChangeFailedEvent(config, { opId, oldIpv4, reason }) {
  try {
    return await postIpEvent(config, buildChangeTerminalPayload({
      opId,
      serverLabel: config.serverLabel,
      channel: config.reportChannel,
      oldIpv4,
      event: 'change_failed',
      reason
    }));
  } catch (err) {
    const error = String(err);
    console.error('[changeip-http] change_failed report error:', error);
    return { ok: false, error };
  }
}

module.exports = {
  buildChangeStartedPayload,
  buildChangeTerminalPayload,
  clearChangeSession,
  clearChangeSessionIfCurrent,
  hasInFlightChangeSession,
  isSameOp,
  loadChangeSession,
  markChangeSessionOfflineObserved,
  markChangeSessionProviderFailed,
  markChangeSessionProviderStarted,
  markChangeSessionTimeoutStuckAlert,
  markChangeSessionStarted,
  nowIso,
  recordChangeSessionError,
  resolvePendingSessionContext,
  sendChangeFailedEvent,
  sendChangeStartedEvent,
  setChangeSessionOldIpv4,
  startChangeSession
};
