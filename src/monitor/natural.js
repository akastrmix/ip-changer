const { fetchPublicIpv4, isValidIpv4 } = require('../ip/ipv4');
const { fetchPublicIpv6, isValidIpv6 } = require('../ip/ipv6');
const { loadIpState, saveIpState } = require('../state');
const { isValidOpId, makeIpv4OpId, makeIpv6OpId } = require('../opId');
const { postIpEvent } = require('../network/ipEvents');
const { nowIso } = require('../change/session');

function clearPendingNaturalChange(state, {
  pendingOpIdField,
  pendingOldField,
  pendingNewField
}) {
  if (!state || typeof state !== 'object') return;
  const fields = [pendingOpIdField, pendingOldField, pendingNewField].filter(Boolean);
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(state, field)) {
      delete state[field];
    }
  }
}

async function handleNaturalMonitor({
  config,
  enabled,
  fetchIp,
  isValidIp,
  makeOpId,
  event,
  notifiedField,
  observedField,
  oldField,
  newField,
  lastReportAtField,
  lastReportErrorField,
  pendingOpIdField,
  pendingOldField,
  pendingNewField
}) {
  if (!enabled) return { ok: true, skipped: true };
  if (!config.ipEventsActive) return { ok: false, error: 'ip events not configured' };

  let ip;
  try {
    ip = await fetchIp({ userAgent: 'ip-changer' });
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const state = loadIpState(config);
  const notified = String(state[notifiedField] || '').trim();
  if (!isValidIp(notified)) {
    state[notifiedField] = ip;
    state[observedField] = ip;
    state.updated_at = nowIso();
    clearPendingNaturalChange(state, { pendingOpIdField, pendingOldField, pendingNewField });
    const saved = saveIpState(config, state);
    if (!saved.ok) {
      return { ok: false, error: `failed to persist ip state: ${saved.error}` };
    }
    return { ok: true, initialized: true };
  }

  if (ip === notified) {
    const hasPending = isValidOpId(state[pendingOpIdField]) ||
      String(state[pendingOldField] || '').trim() ||
      String(state[pendingNewField] || '').trim();
    if (!hasPending) return { ok: true, unchanged: true };

    clearPendingNaturalChange(state, { pendingOpIdField, pendingOldField, pendingNewField });
    state[observedField] = ip;
    state.updated_at = nowIso();
    const saved = saveIpState(config, state);
    if (!saved.ok) {
      return { ok: false, error: `failed to persist ip state: ${saved.error}` };
    }
    return { ok: true, unchanged: true, cleared_pending: true };
  }

  let opId = '';
  const pendingOpId = String(state[pendingOpIdField] || '').trim();
  const pendingOld = String(state[pendingOldField] || '').trim();
  const pendingNew = String(state[pendingNewField] || '').trim();
  const canReusePending = isValidOpId(pendingOpId) && pendingOld === notified && pendingNew === ip;
  if (canReusePending) {
    opId = pendingOpId;
  } else {
    opId = makeOpId(config.serverLabel, new Date());
    state[pendingOpIdField] = opId;
    state[pendingOldField] = notified;
    state[pendingNewField] = ip;
    state[observedField] = ip;
    state.updated_at = nowIso();
    const saved = saveIpState(config, state);
    if (!saved.ok) {
      return { ok: false, error: `failed to persist ip state: ${saved.error}` };
    }
  }

  const payload = {
    server_label: config.serverLabel,
    channel: config.reportChannel,
    op_id: opId,
    ts: nowIso(),
    event
  };
  payload[oldField] = notified;
  payload[newField] = ip;

  let result;
  try {
    result = await postIpEvent(config, payload);
  } catch (err) {
    result = { ok: false, error: String(err) };
  }

  state[observedField] = ip;
  state.updated_at = nowIso();
  if (result.ok) {
    state[notifiedField] = ip;
    clearPendingNaturalChange(state, { pendingOpIdField, pendingOldField, pendingNewField });
    state[lastReportAtField] = state.updated_at;
    state[lastReportErrorField] = '';
  } else {
    state[lastReportErrorField] = result.error || state.updated_at;
  }
  const saved = saveIpState(config, state);
  if (!saved.ok) {
    return { ok: false, error: `failed to persist ip state: ${saved.error}` };
  }
  return { ok: result.ok };
}

async function handleNaturalIpv4Monitor(config) {
  return handleNaturalMonitor({
    config,
    enabled: config.ipMonitorEnabled,
    fetchIp: fetchPublicIpv4,
    isValidIp: isValidIpv4,
    makeOpId: makeIpv4OpId,
    event: 'ipv4_changed',
    notifiedField: 'notified_ipv4',
    observedField: 'observed_ipv4',
    oldField: 'old_ipv4',
    newField: 'new_ipv4',
    lastReportAtField: 'last_report_at',
    lastReportErrorField: 'last_report_error',
    pendingOpIdField: 'pending_ipv4_op_id',
    pendingOldField: 'pending_ipv4_old_ipv4',
    pendingNewField: 'pending_ipv4_new_ipv4'
  });
}

async function handleNaturalIpv6Monitor(config) {
  return handleNaturalMonitor({
    config,
    enabled: config.ipv6MonitorEnabled,
    fetchIp: fetchPublicIpv6,
    isValidIp: isValidIpv6,
    makeOpId: makeIpv6OpId,
    event: 'ipv6_changed',
    notifiedField: 'notified_ipv6',
    observedField: 'observed_ipv6',
    oldField: 'old_ipv6',
    newField: 'new_ipv6',
    lastReportAtField: 'last_report_at_ipv6',
    lastReportErrorField: 'last_report_error_ipv6',
    pendingOpIdField: 'pending_ipv6_op_id',
    pendingOldField: 'pending_ipv6_old_ipv6',
    pendingNewField: 'pending_ipv6_new_ipv6'
  });
}

module.exports = {
  handleNaturalIpv4Monitor,
  handleNaturalIpv6Monitor,
  _test: {
    handleNaturalMonitor
  }
};
