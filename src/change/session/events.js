const { postIpEvent } = require('../../network/ipEvents');
const { loadChangeSession } = require('./store');
const { isSameOp, resolveChangeSessionChannel } = require('./shared');
const { recordChangeSessionError, markChangeSessionStarted } = require('./mutations');
const { buildChangeStartedPayload, buildChangeTerminalPayload } = require('./payloads');

const CHANGE_STARTED_IN_FLIGHT = new Set();

async function sendChangeStartedEvent(config, opId) {
  const current = loadChangeSession(config);
  if (!isSameOp(current, opId)) return { ok: false, skipped: true };
  // SPEC: provider_started=false means provider has not passed its start probe yet; never emit change_started early.
  if (current.provider_started !== true) return { ok: false, skipped: true, provider_not_started: true };
  if (current.started_sent) return { ok: true, skipped: true, already: true };
  if (CHANGE_STARTED_IN_FLIGHT.has(opId)) return { ok: true, skipped: true, in_flight: true };
  CHANGE_STARTED_IN_FLIGHT.add(opId);

  try {
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
  } finally {
    CHANGE_STARTED_IN_FLIGHT.delete(opId);
  }
}

async function sendChangeFailedEvent(config, { opId, oldIpv4, reason }) {
  const current = loadChangeSession(config);
  const channel = isSameOp(current, opId) ? resolveChangeSessionChannel(config, current) : String(config.reportChannel || '').trim();
  try {
    return await postIpEvent(config, buildChangeTerminalPayload({
      opId,
      serverLabel: config.serverLabel,
      channel,
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
  sendChangeFailedEvent,
  sendChangeStartedEvent
};
