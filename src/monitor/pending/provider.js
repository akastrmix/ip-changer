const { startProvider } = require('../../providers');
const {
  markChangeSessionProviderFailed,
  markChangeSessionProviderStarted,
  markChangeSessionProviderStartAttempted,
  markChangeSessionRebootScheduleAttempted,
  recordChangeSessionError
} = require('../../change/session');
const { scheduleReboot } = require('./reboot');

async function startProviderAndMaybeScheduleReboot({
  config,
  pending,
  opId,
  rebootDelayMinutes,
  nowMs,
  intervalMs,
  fallbackNextDueMs
}) {
  const attemptedAtIso = new Date(nowMs).toISOString();
  const markedAttempted = markChangeSessionProviderStartAttempted(config, opId, { attemptedAtIso });
  if (!markedAttempted) {
    recordChangeSessionError(config, opId, 'failed to persist provider_start_attempted');
    return { earlyReturn: { handled: true, nextDueMs: fallbackNextDueMs } };
  }

  console.log(`[changeip-http] starting changeip provider: ${config.changeipProvider} ...`);
  let result;
  try {
    result = await startProvider(config, { opId });
  } catch (err) {
    const errorText = String(err || 'unknown');
    console.error(`[changeip-http] provider ${config.changeipProvider} threw during start: ${errorText}`);
    result = {
      ok: false,
      code: 'provider.runtime_failed',
      reason: 'provider_start_exception',
      error: errorText
    };
  }
  const providerStartMeta = result;
  nowMs = Date.now();
  fallbackNextDueMs = nowMs + intervalMs;

  let rebootMeta = null;
  if (!result.ok) {
    const failureReason = result.reason || 'provider_start_failed';
    const detail = result.detail ? ` (${result.detail})` : '';
    console.error(`[changeip-http] failed to start provider ${config.changeipProvider}: ${result.error}${detail}`);
    const marked = markChangeSessionProviderFailed(config, opId, {
      reason: failureReason,
      reportError: String(result.error || '').slice(0, 300)
    });
    if (!marked) {
      recordChangeSessionError(config, opId, 'failed to persist provider_failed_reason after provider start failure');
    }
  } else {
    if (result.exitedEarly) {
      console.log(`[changeip-http] provider ${config.changeipProvider} exited quickly with code 0`);
    }
    const marked = markChangeSessionProviderStarted(config, opId);
    if (!marked) {
      recordChangeSessionError(config, opId, 'failed to persist provider_started after provider start ok');
    }

    const rebootAttempted = pending.reboot_schedule_attempted === true;
    if (!rebootAttempted && rebootDelayMinutes !== -1) {
      const reboot = await scheduleReboot(config, rebootDelayMinutes);
      rebootMeta = reboot;
      const saved = markChangeSessionRebootScheduleAttempted(config, opId, {
        attemptedAtIso: new Date(Date.now()).toISOString(),
        scheduled: reboot.scheduled,
        scheduledAtIso: reboot.scheduled ? new Date().toISOString() : '',
        error: reboot.error || ''
      });
      if (!saved) {
        recordChangeSessionError(config, opId, 'failed to persist reboot schedule result');
      }
    }
  }

  return {
    providerStartMeta,
    rebootMeta,
    nowMs,
    fallbackNextDueMs
  };
}

module.exports = {
  startProviderAndMaybeScheduleReboot
};
