const NEVER = Number.POSITIVE_INFINITY;
const MONITOR_ERROR_LOG_THROTTLE_MS = 5 * 60 * 1000;
const IPV6_ERROR_LOG_THROTTLE_MS = MONITOR_ERROR_LOG_THROTTLE_MS;
const IPV6_STARTUP_PROBE_TIMEOUT_MS = 5000;

function normalizeDueMs(nextDueMs, fallbackDueMs, nowMs) {
  if (Number.isFinite(nextDueMs)) {
    return Math.max(nextDueMs, nowMs);
  }
  return Math.max(fallbackDueMs, nowMs);
}

function computePendingNextDueMs({ nowMs, timeoutAtMs, fallbackNextDueMs }) {
  if (!timeoutAtMs || nowMs >= timeoutAtMs) return fallbackNextDueMs;
  return Math.min(fallbackNextDueMs, timeoutAtMs);
}

function reconcileNaturalDueMs({ ipMonitorEnabled, hasPending, naturalDueMs, nowMs }) {
  if (!ipMonitorEnabled) return NEVER;
  if (hasPending) return NEVER;
  if (!Number.isFinite(naturalDueMs)) return nowMs;
  return naturalDueMs;
}

function createMonitorLogState() {
  return {
    nextErrorLogAtMs: 0,
    suppressedErrorCount: 0,
    failing: false
  };
}

function markMonitorFailure(logState, scope, error, nowMs = Date.now()) {
  const scopeText = String(scope || 'unknown').trim() || 'unknown';
  const message = String(error || 'unknown error');
  if (nowMs >= logState.nextErrorLogAtMs) {
    const suppressedSuffix = logState.suppressedErrorCount > 0
      ? ` (suppressed ${logState.suppressedErrorCount} repeats)`
      : '';
    console.error(`[changeip-http] ${scopeText} monitor error: ${message}${suppressedSuffix}`);
    logState.nextErrorLogAtMs = nowMs + MONITOR_ERROR_LOG_THROTTLE_MS;
    logState.suppressedErrorCount = 0;
    logState.failing = true;
    return;
  }
  logState.suppressedErrorCount += 1;
  logState.failing = true;
}

function markMonitorSuccess(logState, scope) {
  const scopeText = String(scope || 'unknown').trim() || 'unknown';
  if (!logState.failing) return;
  console.log(`[changeip-http] ${scopeText} monitor recovered`);
  logState.nextErrorLogAtMs = 0;
  logState.suppressedErrorCount = 0;
  logState.failing = false;
}

function createIpv6LogState() {
  return createMonitorLogState();
}

function markIpv6MonitorFailure(logState, error, nowMs = Date.now()) {
  markMonitorFailure(logState, 'ipv6', error, nowMs);
}

function markIpv6MonitorSuccess(logState) {
  markMonitorSuccess(logState, 'ipv6');
}

module.exports = {
  NEVER,
  MONITOR_ERROR_LOG_THROTTLE_MS,
  IPV6_ERROR_LOG_THROTTLE_MS,
  IPV6_STARTUP_PROBE_TIMEOUT_MS,
  computePendingNextDueMs,
  createMonitorLogState,
  createIpv6LogState,
  markMonitorFailure,
  markIpv6MonitorFailure,
  markMonitorSuccess,
  markIpv6MonitorSuccess,
  normalizeDueMs,
  reconcileNaturalDueMs
};
