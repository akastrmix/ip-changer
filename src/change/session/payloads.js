const { isValidIpv4 } = require('../../ip/ipv4');
const { nowIso } = require('./shared');

function buildChangeStartedPayload(config, pending) {
  const payload = {
    server_label: String(pending?.server_label || '').trim() || config.serverLabel,
    channel: String(pending?.channel || '').trim(),
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

module.exports = {
  buildChangeStartedPayload,
  buildChangeTerminalPayload
};
