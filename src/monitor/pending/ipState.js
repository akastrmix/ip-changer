const { isValidIpv4 } = require('../../ip/ipv4');
const { loadIpState, saveIpState } = require('../../state');
const { nowIso } = require('../../change/session');

function persistObservedIpv4State(config, {
  ipv4,
  updateNotified = false
} = {}) {
  const ip = String(ipv4 || '').trim();
  if (!isValidIpv4(ip)) return { ok: false, error: 'invalid ipv4 format' };

  const ipState = loadIpState(config);
  ipState.observed_ipv4 = ip;
  ipState.updated_at = nowIso();
  if (updateNotified) {
    ipState.notified_ipv4 = ip;
    ipState.last_report_at = ipState.updated_at;
    ipState.last_report_error = '';
  }
  return saveIpState(config, ipState);
}

module.exports = {
  persistObservedIpv4State
};
