const { isValidIpv4 } = require('../../ip/ipv4');
const { loadPendingChange, savePendingChange, clearPendingChange } = require('../../state');
const { isSameOp } = require('./shared');

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
    provider_start_attempted: false,
    provider_start_attempted_at: '',
    provider_started: false,
    provider_failed_reason: '',
    started_at: normalized.startedAtIso,
    reboot_delay_minutes: normalized.rebootDelayMinutes,
    reboot_schedule_attempted: false,
    reboot_scheduled: false,
    reboot_schedule_error: '',
    reboot_scheduled_at: '',
    started_sent: false,
    monitor_after_ms: normalized.monitorAfterMs,
    timeout_at_ms: normalized.timeoutAtMs,
    timeout_stuck_alert_next_at_ms: 0,
    timeout_stuck_alert_count: 0,
    timeout_stuck_alert_last_at: '',
    timeout_stuck_alert_last_reason: '',
    last_error: '',
    terminal_sent: false,
    terminal_event: '',
    terminal_reason: '',
    terminal_ipv4: '',
    terminal_sent_at: ''
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

module.exports = {
  clearChangeSession,
  clearChangeSessionIfCurrent,
  hasInFlightChangeSession,
  loadChangeSession,
  mutateChangeSessionIfCurrent,
  startChangeSession
};
