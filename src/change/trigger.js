const { isValidIpv4 } = require('../ip/ipv4');
const { isStateFileError, loadIpState } = require('../state');
const { makeChangeOpId } = require('../opId');
const { getProvider } = require('../providers');
const { compileFlowFromFile } = require('../providers/httpFlow/compile');
const {
  clearChangeSession,
  loadChangeSession,
  resolvePendingSessionContext,
  startChangeSession
} = require('./session');
const { handlePendingChange } = require('../monitor/pending');
const { recordChangeipRequest } = require('../runtime/metrics');

let FATAL_TRIGGER_EXIT_SCHEDULED = false;

function scheduleFatalTriggerExit(reason, err) {
  console.error(`[changeip-http] fatal pending trigger error: ${reason}: ${String(err || 'unknown')}`);
  if (FATAL_TRIGGER_EXIT_SCHEDULED) return;
  FATAL_TRIGGER_EXIT_SCHEDULED = true;
  setImmediate(() => process.exit(1));
}

function validateProviderConfig(config) {
  const resolved = getProvider(config);
  if (!resolved.ok) return resolved;

  const provider = resolved.provider;
  const check = provider.validate(config);
  if (!check.ok) {
    return {
      ok: false,
      code: 'provider.config_invalid',
      reason: 'provider_config_invalid',
      error: String(check.error || 'provider config invalid')
    };
  }

  if (provider.name === 'http_flow') {
    const compiled = compileFlowFromFile(check.value, process.env);
    if (!compiled.ok) {
      return {
        ok: false,
        code: 'provider.config_invalid',
        reason: 'provider_config_invalid',
        error: String(compiled.error || 'provider config invalid')
      };
    }
  }

  return { ok: true };
}

function createResponder() {
  return (status, body, outcome) => {
    recordChangeipRequest(outcome);
    return { status, body };
  };
}

function checkTriggerEligibility(config, respond) {
  if (!config.changeipEnabled) {
    return respond(403, { ok: false, error: 'changeip disabled' }, 'disabled');
  }
  if (!config.ipEventsActive) {
    return respond(500, { ok: false, error: 'ip events not configured' }, 'events_not_configured');
  }
  return null;
}

function maybeForceClearInFlightSession(config, {
  force,
  respond
}) {
  const inFlight = loadChangeSession(config);
  const inFlightOpId = String(inFlight?.op_id || '').trim();
  if (!inFlightOpId) return null;

  if (!force) {
    return respond(
      409,
      { ok: false, error: 'change already in progress', op_id: inFlightOpId },
      'conflict'
    );
  }

  const nowMs = Date.now();
  const terminalSent = inFlight?.terminal_sent === true;
  const context = resolvePendingSessionContext(config, inFlight);
  const knownTimeoutAtMs = context ? context.timeoutAtMs : null;
  const canForceClear = terminalSent ||
    (Number.isFinite(knownTimeoutAtMs) && nowMs >= knownTimeoutAtMs);
  if (!canForceClear) {
    return respond(
      409,
      { ok: false, error: 'change already in progress', op_id: inFlightOpId },
      'conflict'
    );
  }

  const why = terminalSent
    ? 'terminal_sent'
    : 'timed_out';
  console.warn(`[changeip-http] forcing pending session clear: op_id=${inFlightOpId} reason=${why}`);
  const cleared = clearChangeSession(config);
  if (!cleared) {
    return respond(
      409,
      { ok: false, error: 'change already in progress (force clear failed)', op_id: inFlightOpId },
      'conflict'
    );
  }

  return null;
}

function maybeRejectInvalidProviderConfig(config, respond) {
  const providerCheck = validateProviderConfig(config);
  if (providerCheck.ok) return null;
  return respond(
    500,
    {
      ok: false,
      error: providerCheck.error || 'failed to validate provider config',
      provider_error_code: providerCheck.code || ''
    },
    'provider_failed'
  );
}

function resolveOldIpv4FromState(state) {
  return isValidIpv4(state?.notified_ipv4)
    ? state.notified_ipv4
    : (isValidIpv4(state?.observed_ipv4) ? state.observed_ipv4 : null);
}

function maybeStartChangeSession(config, {
  opId,
  oldIpv4,
  startedAt,
  respond
}) {
  const sessionStart = startChangeSession(config, {
    opId,
    oldIpv4,
    startedAt
  });
  if (sessionStart.ok) return null;

  if (sessionStart.conflict) {
    const inFlight = sessionStart.inFlight || loadChangeSession(config);
    return respond(
      409,
      { ok: false, error: 'change already in progress', op_id: String(inFlight?.op_id || '') },
      'conflict'
    );
  }
  return respond(
    500,
    { ok: false, error: sessionStart.error || 'failed to persist change session' },
    'session_error'
  );
}

function schedulePendingRunner(config, opId) {
  // Single-runner: provider start + reboot scheduling is executed by the pending session runner.
  try {
    const schedule = () => handlePendingChange(config, { mode: 'trigger', opId }).catch((err) => {
      console.error('[changeip-http] async pending trigger failed:', String(err || 'unknown'));
      if (isStateFileError(err)) {
        scheduleFatalTriggerExit('state file became unreadable/corrupt during pending trigger', err);
      }
    });
    if (typeof setImmediate === 'function') {
      setImmediate(schedule);
    } else {
      schedule();
    }
  } catch (err) {
    console.error('[changeip-http] failed to schedule pending trigger:', String(err || 'unknown'));
  }
}

function buildAcceptedResponseBody(config, { opId, oldIpv4 }) {
  return {
    ok: true,
    op_id: opId,
    message: config.rebootDelayMinutes === -1
      ? 'changeip accepted, reboot disabled'
      : `changeip accepted, reboot scheduling requested (+${config.rebootDelayMinutes} minutes)`,
    changeip_provider: config.changeipProvider,
    server_label: config.serverLabel,
    channel: config.reportChannel,
    old_ipv4: oldIpv4,
    // Scheduling happens asynchronously in the pending runner; treat this as "requested".
    reboot_schedule_requested: config.rebootDelayMinutes !== -1,
    reboot_delay_minutes: config.rebootDelayMinutes === -1 ? -1 : config.rebootDelayMinutes
  };
}

async function triggerChangeIp(config, { force = false } = {}) {
  const respond = createResponder();

  const ineligible = checkTriggerEligibility(config, respond);
  if (ineligible) return ineligible;

  const conflictOrForceClearError = maybeForceClearInFlightSession(config, { force, respond });
  if (conflictOrForceClearError) return conflictOrForceClearError;

  const invalidProvider = maybeRejectInvalidProviderConfig(config, respond);
  if (invalidProvider) return invalidProvider;

  const startedAt = new Date();
  const opId = makeChangeOpId(config.serverLabel, startedAt);

  const state = loadIpState(config);
  const oldIpv4 = resolveOldIpv4FromState(state);

  const sessionStartError = maybeStartChangeSession(config, {
    opId,
    oldIpv4,
    startedAt,
    respond
  });
  if (sessionStartError) return sessionStartError;

  schedulePendingRunner(config, opId);

  return respond(
    200,
    buildAcceptedResponseBody(config, { opId, oldIpv4 }),
    'started'
  );
}

module.exports = {
  triggerChangeIp
};
