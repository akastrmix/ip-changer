const { spawn } = require('child_process');

const { fetchPublicIpv4, isValidIpv4 } = require('../ip/ipv4');
const { loadIpState, saveIpState } = require('../state');
const { makeChangeOpId } = require('../opId');
const { startProvider } = require('../providers');
const {
  clearChangeSessionIfCurrent,
  loadChangeSession,
  markChangeSessionProviderFailed,
  markChangeSessionProviderStarted,
  sendChangeFailedEvent,
  sendChangeStartedEvent,
  setChangeSessionOldIpv4,
  startChangeSession
} = require('./session');
const { recordChangeipRequest } = require('../runtime/metrics');

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
  const respond = (status, body, outcome) => {
    recordChangeipRequest(outcome);
    return { status, body };
  };

  if (!config.changeipEnabled) {
    return respond(403, { ok: false, error: 'changeip disabled' }, 'disabled');
  }
  if (!config.ipEventsActive) {
    return respond(500, { ok: false, error: 'ip events not configured' }, 'events_not_configured');
  }

  const startedAt = new Date();
  const opId = makeChangeOpId(config.serverLabel, startedAt);

  const state = loadIpState(config);
  let oldIpv4 = isValidIpv4(state.notified_ipv4) ? state.notified_ipv4 : null;

  const sessionStart = startChangeSession(config, {
    opId,
    oldIpv4,
    startedAt
  });
  if (!sessionStart.ok) {
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

  if (!oldIpv4) {
    try {
      const observed = await fetchPublicIpv4({ userAgent: 'ip-changer', timeoutMs: 2000 });
      if (isValidIpv4(observed)) {
        const updated = setChangeSessionOldIpv4(config, opId, observed);
        if (updated) {
          oldIpv4 = observed;
          state.notified_ipv4 = observed;
          state.observed_ipv4 = observed;
          state.updated_at = startedAt.toISOString();
          const saved = saveIpState(config, state);
          if (!saved.ok) {
            console.error('[changeip-http] failed to persist baseline ipv4 state:', String(saved.error));
          }
        }
      }
    } catch {
      // ignore: if lookup fails, monitor will handle unknown baseline later.
    }
  }

  console.log(`[changeip-http] starting changeip provider: ${config.changeipProvider} ...`);
  const providerResult = await startProvider(config);
  if (!providerResult.ok) {
    const failureReason = providerResult.reason || 'provider_start_failed';
    const detail = providerResult.detail ? ` (${providerResult.detail})` : '';
    console.error(`[changeip-http] failed to start provider ${config.changeipProvider}: ${providerResult.error}${detail}`);
    const report = await sendChangeFailedEvent(config, {
      opId,
      oldIpv4,
      reason: failureReason
    });
    if (report.ok) {
      const cleared = clearChangeSessionIfCurrent(config, opId);
      if (!cleared) {
        markChangeSessionProviderFailed(config, opId, {
          reason: failureReason,
          reportError: 'failed to clear pending after provider_start_failed report'
        });
      }
    } else {
      markChangeSessionProviderFailed(config, opId, {
        reason: failureReason,
        reportError: report.error
      });
    }
    return respond(
      500,
      {
        ok: false,
        error: providerResult.error || 'failed to start changeip provider',
        provider_error_code: providerResult.code || ''
      },
      'provider_failed'
    );
  }

  if (providerResult.exitedEarly) {
    console.log(`[changeip-http] provider ${config.changeipProvider} exited quickly with code 0`);
  }

  markChangeSessionProviderStarted(config, opId);
  void sendChangeStartedEvent(config, opId).catch((err) => {
    console.error('[changeip-http] change_started report error:', String(err));
  });

  const reboot = scheduleReboot(config);

  return respond(
    200,
    {
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
    },
    'started'
  );
}

module.exports = {
  triggerChangeIp
};
