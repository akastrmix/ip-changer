function nowIso() {
  return new Date().toISOString();
}

function isSameOp(pending, opId) {
  const currentOpId = String(pending?.op_id || '').trim();
  const targetOpId = String(opId || '').trim();
  if (!currentOpId || !targetOpId) return false;
  return currentOpId === targetOpId;
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

function resolveChangeSessionChannel(config, pending) {
  // Preserve explicit empty channel (channel broadcast disabled) for the lifetime of the session.
  if (pending && Object.prototype.hasOwnProperty.call(pending, 'channel')) {
    return String(pending.channel || '').trim();
  }
  return String(config.reportChannel || '').trim();
}

module.exports = {
  isSameOp,
  isValidRebootDelayMinutes,
  nowIso,
  resolveChangeSessionChannel,
  resolvePendingSessionContext
};

