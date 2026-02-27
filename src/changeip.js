const { spawn } = require('child_process');

const { fetchPublicIpv4, isValidIpv4 } = require('./ipv4');
const { loadIpState, saveIpState } = require('./state');
const { makeChangeOpId } = require('./opId');
const { startProvider } = require('./providers');
const {
  clearChangeSession,
  createPendingChangeSession,
  hasInFlightChangeSession,
  loadChangeSession,
  persistNewChangeSession,
  updateChangeSessionIfCurrent,
  sendChangeFailedEvent,
  sendChangeStartedEvent
} = require('./changeSession');

function scheduleReboot(config) {
  if (config.rebootDelayMinutes === -1) {
    console.log('[changeip-http] reboot disabled (REBOOT_DELAY_MINUTES=-1)');
    return { scheduled: false, delayMinutes: -1 };
  }

  const delayMinutes = Math.max(config.rebootDelayMinutes, 1);
  console.log(`[changeip-http] scheduling reboot in ${delayMinutes} minutes...`);

  const proc = spawn(config.shutdownBin, ['-r', `+${delayMinutes}`], {
    stdio: 'ignore',
    detached: true
  });
  proc.on('error', (err) => {
    console.error('[changeip-http] failed to schedule reboot:', String(err));
  });
  proc.unref();
  return { scheduled: true, delayMinutes };
}

async function triggerChangeIp(config) {
  if (!config.changeipEnabled) {
    return { status: 403, body: { ok: false, error: 'changeip disabled' } };
  }
  if (!config.ipEventsActive) {
    return { status: 500, body: { ok: false, error: 'ip events not configured' } };
  }

  if (hasInFlightChangeSession(config)) {
    const inFlight = loadChangeSession(config);
    return {
      status: 409,
      body: { ok: false, error: 'change already in progress', op_id: String(inFlight.op_id) }
    };
  }

  const startedAt = new Date();
  const opId = makeChangeOpId(config.serverLabel, startedAt);

  const state = loadIpState(config);
  let oldIpv4 = isValidIpv4(state.notified_ipv4) ? state.notified_ipv4 : null;

  const pending = createPendingChangeSession(config, {
    opId,
    oldIpv4,
    startedAt
  });
  if (!persistNewChangeSession(config, pending)) {
    return { status: 500, body: { ok: false, error: 'failed to persist change session' } };
  }

  if (!oldIpv4) {
    try {
      const observed = await fetchPublicIpv4({ userAgent: 'ip-changer', timeoutMs: 2000 });
      if (isValidIpv4(observed)) {
        const updated = updateChangeSessionIfCurrent(config, opId, (next) => {
          next.old_ipv4 = observed;
        });
        if (updated) {
          oldIpv4 = observed;
          state.notified_ipv4 = observed;
          state.observed_ipv4 = observed;
          state.updated_at = startedAt.toISOString();
          saveIpState(config, state);
        }
      }
    } catch {
      // ignore: if lookup fails, monitor will handle unknown baseline later.
    }
  }

  console.log(`[changeip-http] starting changeip provider: ${config.changeipProvider} ...`);
  const providerResult = await startProvider(config);
  if (!providerResult.ok) {
    const detail = providerResult.detail ? ` (${providerResult.detail})` : '';
    console.error(`[changeip-http] failed to start provider ${config.changeipProvider}: ${providerResult.error}${detail}`);
    await sendChangeFailedEvent(config, {
      opId,
      oldIpv4,
      reason: providerResult.reason || 'provider_start_failed'
    });
    clearChangeSession(config);
    return {
      status: 500,
      body: {
        ok: false,
        error: providerResult.error || 'failed to start changeip provider',
        provider_error_code: providerResult.code || ''
      }
    };
  }

  if (providerResult.exitedEarly) {
    console.log(`[changeip-http] provider ${config.changeipProvider} exited quickly with code 0`);
  }

  void sendChangeStartedEvent(config, opId).catch((err) => {
    console.error('[changeip-http] change_started report error:', String(err));
  });

  const reboot = scheduleReboot(config);

  return {
    status: 200,
    body: {
      ok: true,
      op_id: opId,
      message: reboot.scheduled
        ? `changeip started, reboot scheduled in ${reboot.delayMinutes} minutes`
        : 'changeip started, reboot disabled',
      changeip_provider: config.changeipProvider,
      server_label: config.serverLabel,
      channel: config.reportChannel,
      old_ipv4: oldIpv4,
      reboot_scheduled: reboot.scheduled,
      reboot_delay_minutes: reboot.scheduled ? reboot.delayMinutes : -1
    }
  };
}

module.exports = {
  triggerChangeIp
};
