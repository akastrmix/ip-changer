const { fetchPublicIpv4, isValidIpv4 } = require('../../ip/ipv4');
const {
  buildChangeTerminalPayload,
  clearChangeSessionIfCurrent,
  loadChangeSession,
  markChangeSessionOfflineObserved,
  recordChangeSessionError,
  resolvePendingSessionContext,
  sendChangeStartedEvent
} = require('../../change/session');
const { computePendingNextDueMs } = require('../helpers');
const { persistObservedIpv4State } = require('./ipState');
const { handleInvalidPendingSession } = require('./invalid');
const { startProviderAndMaybeScheduleReboot } = require('./provider');
const {
  isTerminalSentRemembered,
  forgetTerminalSent,
  postTerminalEventAndHandleSession,
  shouldPersistTerminalIpState,
  shouldUpdateNotifiedIpv4ForTerminal
} = require('./terminal');
const { isStrictPendingSchema } = require('./validate');

let PENDING_RUNNER_IN_FLIGHT = null;

async function handlePendingChange(config) {
  const opts = arguments.length > 1 && arguments[1] && typeof arguments[1] === 'object' ? arguments[1] : {};
  const mode = String(opts.mode || '').trim() || 'monitor';
  const expectedOpId = String(opts.opId || '').trim();

  while (PENDING_RUNNER_IN_FLIGHT) {
    try {
      await PENDING_RUNNER_IN_FLIGHT;
    } catch {
      // ignore
    }
  }

  const run = (async () => {
    const pending = loadChangeSession(config);
    if (!pending) return { handled: false };

    const sessionOpId = String(pending.op_id || '').trim();
    if (!sessionOpId) {
      return handleInvalidPendingSession(config, pending, 'invalid_pending_op_id');
    }

    if (!isStrictPendingSchema(pending)) {
      return handleInvalidPendingSession(config, pending, 'invalid_pending_schema');
    }

    const session = resolvePendingSessionContext(config, pending);
    if (!session) {
      return handleInvalidPendingSession(config, pending, 'invalid_pending_timing');
    }

    const {
      opId,
      serverLabel,
      channel,
      startedAt,
      rebootDelayMinutes,
      monitorAfterMs,
      timeoutAtMs
    } = session;

    // trigger mode is used by /changeip to ensure we are operating on the session we just created.
    if (mode === 'trigger' && expectedOpId && expectedOpId !== opId) {
      return { handled: true, conflict: true, error: 'op_id_mismatch', op_id: opId };
    }

    let nowMs = Date.now();
    const intervalMs = Math.max(config.changeMonitorIntervalSeconds, 1) * 1000;
    let fallbackNextDueMs = nowMs + intervalMs;

    if (pending.terminal_sent === true || isTerminalSentRemembered(opId)) {
      if (shouldPersistTerminalIpState(pending)) {
        const ip = String(pending.terminal_ipv4 || '').trim();
        const saved = persistObservedIpv4State(config, {
          ipv4: ip,
          updateNotified: shouldUpdateNotifiedIpv4ForTerminal(pending)
        });
        if (!saved.ok) {
          recordChangeSessionError(config, opId, `failed to persist ip state: ${saved.error}`);
          return { handled: true, nextDueMs: fallbackNextDueMs };
        }
      }

      const cleared = clearChangeSessionIfCurrent(config, opId);
      if (!cleared) {
        recordChangeSessionError(config, opId, 'failed to clear pending after terminal already sent');
        return { handled: true, nextDueMs: fallbackNextDueMs };
      }
      forgetTerminalSent(opId);
      return { handled: true, done: true };
    }

    // Provider start (single-runner): ensure the provider is started exactly once for this session.
    // This keeps all session state transitions in one place and prevents handler/monitor races.
    let providerStartMeta = null;
    let rebootMeta = null;
    const providerFailedReason = String(pending.provider_failed_reason || '').trim();
    const providerStartAttempted = pending.provider_start_attempted === true;

    if (pending.provider_started !== true && !providerFailedReason && !providerStartAttempted) {
      const startResult = await startProviderAndMaybeScheduleReboot({
        config,
        pending,
        opId,
        rebootDelayMinutes,
        nowMs,
        intervalMs,
        fallbackNextDueMs
      });
      if (startResult.earlyReturn) return startResult.earlyReturn;
      providerStartMeta = startResult.providerStartMeta;
      rebootMeta = startResult.rebootMeta;
      nowMs = startResult.nowMs;
      fallbackNextDueMs = startResult.fallbackNextDueMs;
    }

    const current = loadChangeSession(config);
    const currentFailedReason = String(current?.provider_failed_reason || '').trim();
    const providerFailed = current && current.provider_started === false && !!currentFailedReason;
    if (providerFailed) {
      const terminal = buildChangeTerminalPayload({
        opId,
        serverLabel,
        channel,
        oldIpv4: current.old_ipv4,
        event: 'change_failed',
        reason: currentFailedReason.slice(0, 300)
      });
      const posted = await postTerminalEventAndHandleSession({
        config,
        opId,
        terminal,
        timeoutAtMs,
        nowMs,
        clearErrorMessage: 'failed to clear pending after provider_failed terminal report',
        rejectedReasonPrefix: 'provider_failed_terminal_rejected',
        exceptionReasonPrefix: 'provider_failed_terminal_exception'
      });
      if (posted.done) {
        return {
          handled: true,
          done: true,
          provider: {
            ok: false,
            reason: currentFailedReason,
            error: providerStartMeta?.error || '',
            code: providerStartMeta?.code || ''
          },
          reboot: rebootMeta
        };
      }

      const nextDueMs = computePendingNextDueMs({
        nowMs,
        timeoutAtMs,
        fallbackNextDueMs
      });
      return {
        handled: true,
        nextDueMs,
        provider: {
          ok: false,
          reason: currentFailedReason,
          error: providerStartMeta?.error || '',
          code: providerStartMeta?.code || ''
        },
        reboot: rebootMeta
      };
    }

    // trigger-mode stops after provider start/failure handling; never converge within /changeip.
    if (mode === 'trigger') {
      const ok = current && String(current.op_id || '').trim() === opId && current.provider_started === true;
      const reboot = rebootMeta || (current?.reboot_schedule_attempted === true ? {
        scheduled: current?.reboot_scheduled === true,
        delayMinutes: rebootDelayMinutes,
        error: String(current?.reboot_schedule_error || '')
      } : null);
      return {
        handled: true,
        provider: ok
          ? { ok: true }
          : {
              ok: false,
              reason: String(current?.provider_failed_reason || providerFailedReason || '').trim(),
              error: providerStartMeta?.error || '',
              code: providerStartMeta?.code || ''
            },
        reboot
      };
    }

    // SPEC: provider_started=false means provider has not passed its start probe yet, so we must not emit change_started.
    // Use the latest persisted session (not the stale `pending` snapshot) to avoid delaying change_started until monitor_after_ms.
    if (current && !current.started_sent && current.provider_started === true && startedAt) {
      await sendChangeStartedEvent(config, opId);
      nowMs = Date.now();
      fallbackNextDueMs = nowMs + intervalMs;
    }

    if (monitorAfterMs && nowMs < monitorAfterMs) {
      return { handled: true, nextDueMs: monitorAfterMs };
    }

    let ip;
    try {
      ip = await fetchPublicIpv4({ userAgent: 'ip-changer' });
    } catch (err) {
      if (rebootDelayMinutes === -1 && !pending.offline_observed) {
        markChangeSessionOfflineObserved(config, opId);
      }

      if (timeoutAtMs && nowMs >= timeoutAtMs) {
        const payload = buildChangeTerminalPayload({
          opId,
          serverLabel,
          channel,
          oldIpv4: pending.old_ipv4,
          event: 'change_failed',
          reason: 'no_ipv4_observed'
        });
        const posted = await postTerminalEventAndHandleSession({
          config,
          opId,
          terminal: payload,
          timeoutAtMs,
          nowMs,
          clearErrorMessage: 'failed to clear pending after no_ipv4_observed terminal report'
        });
        if (posted.done) return { handled: true, done: true };
      }

      const nextDueMs = computePendingNextDueMs({
        nowMs,
        timeoutAtMs,
        fallbackNextDueMs
      });
      return { handled: true, nextDueMs };
    }

    const oldIpv4 = isValidIpv4(pending?.old_ipv4) ? pending.old_ipv4 : null;
    const providerRuntimeFailedReason = pending.provider_started === true ? providerFailedReason : '';
    let terminal;
    if (!oldIpv4) {
      if (!providerRuntimeFailedReason && timeoutAtMs && nowMs < timeoutAtMs) {
        const nextDueMs = computePendingNextDueMs({
          nowMs,
          timeoutAtMs,
          fallbackNextDueMs
        });
        return { handled: true, nextDueMs };
      }

      terminal = buildChangeTerminalPayload({
        opId,
        serverLabel,
        channel,
        newIpv4: ip,
        event: 'change_failed',
        reason: (providerRuntimeFailedReason || 'old_ipv4_unknown').slice(0, 300)
      });
    } else if (ip === oldIpv4) {
      if (providerRuntimeFailedReason) {
        terminal = buildChangeTerminalPayload({
          opId,
          serverLabel,
          channel,
          oldIpv4,
          event: 'change_failed',
          reason: providerRuntimeFailedReason.slice(0, 300)
        });
      } else if (rebootDelayMinutes === -1 && !pending.offline_observed) {
        if (timeoutAtMs && nowMs >= timeoutAtMs) {
          terminal = buildChangeTerminalPayload({
            opId,
            serverLabel,
            channel,
            oldIpv4,
            event: 'change_no_change'
          });
        } else {
          const nextDueMs = computePendingNextDueMs({
            nowMs,
            timeoutAtMs,
            fallbackNextDueMs
          });
          return { handled: true, nextDueMs };
        }
      } else {
        terminal = buildChangeTerminalPayload({
          opId,
          serverLabel,
          channel,
          oldIpv4,
          event: 'change_no_change'
        });
      }
    } else {
      terminal = buildChangeTerminalPayload({
        opId,
        serverLabel,
        channel,
        oldIpv4,
        newIpv4: ip,
        event: 'change_succeeded'
      });
    }

    const posted = await postTerminalEventAndHandleSession({
      config,
      opId,
      terminal,
      timeoutAtMs,
      nowMs,
      clearErrorMessage: 'failed to clear pending after terminal report',
      clearOnSuccess: false
    });
    if (!posted.posted) {
      return { handled: true, nextDueMs: fallbackNextDueMs };
    }

    const saved = persistObservedIpv4State(config, {
      ipv4: ip,
      updateNotified: terminal.event === 'change_succeeded'
    });
    if (!saved.ok) {
      recordChangeSessionError(config, opId, `failed to persist ip state: ${saved.error}`);
      return { handled: true, nextDueMs: fallbackNextDueMs };
    }

    const cleared = clearChangeSessionIfCurrent(config, opId);
    if (!cleared) {
      recordChangeSessionError(config, opId, 'failed to clear pending after terminal report');
      return { handled: true, nextDueMs: fallbackNextDueMs };
    }
    return { handled: true, done: true };
  })();

  PENDING_RUNNER_IN_FLIGHT = run;
  try {
    return await run;
  } finally {
    if (PENDING_RUNNER_IN_FLIGHT === run) PENDING_RUNNER_IN_FLIGHT = null;
  }
}

module.exports = {
  handlePendingChange
};
