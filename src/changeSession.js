const { isValidIpv4 } = require('./ipv4');
const { postIpEvent } = require('./events');
const { loadPendingChange, savePendingChange, clearPendingChange } = require('./state');

function nowIso() {
  return new Date().toISOString();
}

function isSameOp(pending, opId) {
  return !!pending?.op_id && String(pending.op_id) === String(opId);
}

function loadChangeSession(config) {
  return loadPendingChange(config);
}

function hasInFlightChangeSession(config) {
  return !!loadPendingChange(config)?.op_id;
}

function computeMonitorWindow(config, startedAtMs) {
  const rebootDelayMs = config.rebootDelayMinutes === -1
    ? 0
    : Math.max(config.rebootDelayMinutes, 1) * 60 * 1000;
  const monitorAfterMs = startedAtMs + rebootDelayMs + config.changeMonitorStartDelaySeconds * 1000;
  const timeoutAtMs = monitorAfterMs + config.changeMonitorTimeoutSeconds * 1000;
  return { monitorAfterMs, timeoutAtMs };
}

function createPendingChangeSession(config, { opId, oldIpv4, startedAt = new Date() }) {
  const startedAtObj = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const startedAtIso = startedAtObj.toISOString();
  const { monitorAfterMs, timeoutAtMs } = computeMonitorWindow(config, startedAtObj.getTime());
  return {
    op_id: String(opId),
    server_label: config.serverLabel,
    channel: config.reportChannel,
    old_ipv4: isValidIpv4(oldIpv4) ? oldIpv4 : null,
    started_at: startedAtIso,
    reboot_delay_minutes: config.rebootDelayMinutes,
    started_sent: false,
    monitor_after_ms: monitorAfterMs,
    timeout_at_ms: timeoutAtMs,
    last_error: ''
  };
}

function persistNewChangeSession(config, pending) {
  savePendingChange(config, pending);
  return isSameOp(loadPendingChange(config), pending?.op_id);
}

function updateChangeSessionIfCurrent(config, opId, mutate) {
  const current = loadPendingChange(config);
  if (!isSameOp(current, opId)) return false;
  const next = { ...current };
  mutate(next);
  savePendingChange(config, next);
  return true;
}

function clearChangeSession(config) {
  clearPendingChange(config);
}

function setChangeSessionLastError(config, opId, errorText) {
  return updateChangeSessionIfCurrent(config, opId, (next) => {
    next.last_error = String(errorText || next.last_error || '');
  });
}

function markChangeSessionStarted(config, opId) {
  return updateChangeSessionIfCurrent(config, opId, (next) => {
    next.started_sent = true;
    next.last_error = '';
  });
}

function resolvePendingSessionContext(config, pending) {
  const opId = String(pending?.op_id || '').trim();
  const serverLabel = String(pending?.server_label || '').trim() || config.serverLabel;
  const channel = String(pending?.channel || '').trim() || config.reportChannel;
  const startedAt = String(pending?.started_at || '').trim();
  const startedAtMs = startedAt ? Date.parse(startedAt) : NaN;
  const rebootDelayMinutes =
    pending?.reboot_delay_minutes === -1 || pending?.reboot_delay_minutes >= 1
      ? pending.reboot_delay_minutes
      : config.rebootDelayMinutes;

  let monitorAfterMs = Number(pending?.monitor_after_ms || 0);
  let timeoutAtMs = Number(pending?.timeout_at_ms || 0);
  if (Number.isFinite(startedAtMs) && rebootDelayMinutes !== -1) {
    const rebootDelayMs = Math.max(Number(rebootDelayMinutes) || 1, 1) * 60 * 1000;
    const minMonitorAfterMs = startedAtMs + rebootDelayMs + config.changeMonitorStartDelaySeconds * 1000;
    if (!monitorAfterMs || monitorAfterMs < minMonitorAfterMs) {
      monitorAfterMs = minMonitorAfterMs;
      timeoutAtMs = monitorAfterMs + config.changeMonitorTimeoutSeconds * 1000;
      updateChangeSessionIfCurrent(config, opId, (next) => {
        next.monitor_after_ms = monitorAfterMs;
        next.timeout_at_ms = timeoutAtMs;
      });
    }
  }

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
  const current = loadPendingChange(config);
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
    setChangeSessionLastError(config, opId, result.error);
  }
  return result;
}

async function sendChangeFailedEvent(config, { opId, oldIpv4, reason }) {
  try {
    await postIpEvent(config, buildChangeTerminalPayload({
      opId,
      serverLabel: config.serverLabel,
      channel: config.reportChannel,
      oldIpv4,
      event: 'change_failed',
      reason
    }));
  } catch (err) {
    console.error('[changeip-http] change_failed report error:', String(err));
  }
}

module.exports = {
  buildChangeStartedPayload,
  buildChangeTerminalPayload,
  clearChangeSession,
  createPendingChangeSession,
  hasInFlightChangeSession,
  isSameOp,
  loadChangeSession,
  markChangeSessionStarted,
  nowIso,
  persistNewChangeSession,
  resolvePendingSessionContext,
  sendChangeFailedEvent,
  sendChangeStartedEvent,
  setChangeSessionLastError,
  updateChangeSessionIfCurrent
};
