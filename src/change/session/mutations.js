const { isValidIpv4 } = require('../../ip/ipv4');
const { nowIso } = require('./shared');
const { mutateChangeSessionIfCurrent } = require('./store');

const DEFAULT_TIMEOUT_STUCK_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

function recordChangeSessionError(config, opId, errorText) {
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.last_error = String(errorText || next.last_error || '');
  });
}

function markChangeSessionStarted(config, opId) {
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.started_sent = true;
    next.last_error = '';
  });
}

function markChangeSessionProviderStarted(config, opId) {
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.provider_started = true;
  });
}

function markChangeSessionProviderStartAttempted(config, opId, { attemptedAtIso = '' } = {}) {
  const at = attemptedAtIso ? String(attemptedAtIso) : nowIso();
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.provider_start_attempted = true;
    next.provider_start_attempted_at = at;
  });
}

function markChangeSessionProviderFailed(config, opId, { reason, reportError } = {}) {
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.provider_started = false;
    next.provider_failed_reason = String(reason || 'provider_start_failed').slice(0, 300);
    if (reportError) {
      next.last_error = String(reportError).slice(0, 500);
    }
  });
}

function markChangeSessionProviderRuntimeFailed(config, opId, { reason, reportError } = {}) {
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    // Runtime failure means the provider started but later errored; do not flip provider_started=false
    // or pending monitor may treat it as a provider-start failure and emit change_failed immediately.
    next.provider_started = true;
    next.provider_failed_reason = String(reason || 'provider_runtime_failed').slice(0, 300);
    if (reportError) {
      next.last_error = String(reportError).slice(0, 500);
    }
  });
}

function markChangeSessionTerminalSent(config, opId, {
  event,
  reason = '',
  ipv4 = '',
  sentAtIso = ''
} = {}) {
  const eventText = String(event || '').trim();
  const reasonText = String(reason || '').trim();
  const ipv4Text = isValidIpv4(ipv4) ? ipv4 : '';
  const at = sentAtIso ? String(sentAtIso) : nowIso();
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.terminal_sent = true;
    next.terminal_event = eventText;
    next.terminal_reason = reasonText.slice(0, 300);
    next.terminal_ipv4 = ipv4Text;
    next.terminal_sent_at = at;
  });
}

function markChangeSessionRebootScheduleAttempted(config, opId, {
  attemptedAtIso = '',
  scheduled = false,
  scheduledAtIso = '',
  error = ''
} = {}) {
  const attemptedAt = attemptedAtIso ? String(attemptedAtIso) : nowIso();
  const scheduledAt = scheduledAtIso ? String(scheduledAtIso) : (scheduled ? attemptedAt : '');
  const errorText = String(error || '').trim();
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.reboot_schedule_attempted = true;
    next.reboot_scheduled = !!scheduled;
    next.reboot_schedule_error = errorText.slice(0, 300);
    next.reboot_scheduled_at = scheduledAt;
    if (!scheduled && errorText) {
      next.last_error = `reboot schedule failed: ${errorText}`.slice(0, 500);
    }
  });
}

function markChangeSessionOfflineObserved(config, opId) {
  return !!mutateChangeSessionIfCurrent(config, opId, (next) => {
    next.offline_observed = true;
  });
}

function markChangeSessionTimeoutStuckAlert(config, opId, {
  nowMs = Date.now(),
  reason = '',
  cooldownMs = DEFAULT_TIMEOUT_STUCK_ALERT_COOLDOWN_MS
} = {}) {
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const safeCooldownMs = Math.max(1000, Number(cooldownMs) || DEFAULT_TIMEOUT_STUCK_ALERT_COOLDOWN_MS);
  let shouldAlert = false;

  const updated = mutateChangeSessionIfCurrent(config, opId, (next) => {
    const nextAllowedAtMs = Number(next.timeout_stuck_alert_next_at_ms || 0);
    if (Number.isFinite(nextAllowedAtMs) && nextAllowedAtMs > safeNowMs) return false;

    shouldAlert = true;
    next.timeout_stuck_alert_next_at_ms = safeNowMs + safeCooldownMs;
    next.timeout_stuck_alert_count = Math.max(0, Number(next.timeout_stuck_alert_count) || 0) + 1;
    next.timeout_stuck_alert_last_at = new Date(safeNowMs).toISOString();
    next.timeout_stuck_alert_last_reason = String(reason || '').slice(0, 300);
  });

  return shouldAlert && !!updated;
}

module.exports = {
  markChangeSessionOfflineObserved,
  markChangeSessionProviderFailed,
  markChangeSessionProviderRuntimeFailed,
  markChangeSessionProviderStarted,
  markChangeSessionProviderStartAttempted,
  markChangeSessionRebootScheduleAttempted,
  markChangeSessionStarted,
  markChangeSessionTerminalSent,
  markChangeSessionTimeoutStuckAlert,
  recordChangeSessionError,
};
