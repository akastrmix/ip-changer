const { fetchPublicIpv4, isValidIpv4 } = require('../ip/ipv4');
const { fetchPublicIpv6, isValidIpv6 } = require('../ip/ipv6');
const { loadIpState, saveIpState } = require('../state');
const { makeIpv4OpId, makeIpv6OpId } = require('../opId');
const { postIpEvent } = require('../network/ipEvents');
const { nowIso } = require('../change/session');

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
  lastReportErrorField
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
    const saved = saveIpState(config, state);
    if (!saved.ok) {
      return { ok: false, error: `failed to persist ip state: ${saved.error}` };
    }
    return { ok: true, initialized: true };
  }
  if (ip === notified) return { ok: true, unchanged: true };

  const payload = {
    server_label: config.serverLabel,
    channel: config.reportChannel,
    op_id: makeOpId(config.serverLabel, new Date()),
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
    lastReportErrorField: 'last_report_error'
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
    lastReportErrorField: 'last_report_error_ipv6'
  });
}

module.exports = {
  handleNaturalIpv4Monitor,
  handleNaturalIpv6Monitor
};
