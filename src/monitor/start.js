const { fetchPublicIpv6 } = require('../ip/ipv6');
const { loadChangeSession } = require('../change/session');
const { recordMonitorTick, recordMonitorTickError } = require('../runtime/metrics');
const { handlePendingChange } = require('./pending');
const {
  NEVER,
  MONITOR_ERROR_LOG_THROTTLE_MS,
  IPV6_STARTUP_PROBE_TIMEOUT_MS,
  createMonitorLogState,
  createIpv6LogState,
  markMonitorFailure,
  markIpv6MonitorFailure,
  markMonitorSuccess,
  markIpv6MonitorSuccess,
  normalizeDueMs,
  reconcileNaturalDueMs
} = require('./helpers');
const { handleNaturalIpv4Monitor, handleNaturalIpv6Monitor } = require('./natural');

async function runIpv6StartupProbe(config, logState) {
  if (!config.ipv6MonitorEnabled) return;
  try {
    await fetchPublicIpv6({ userAgent: 'ip-changer', timeoutMs: IPV6_STARTUP_PROBE_TIMEOUT_MS });
    console.log('[changeip-http] ipv6 probe ok: public ipv6 reachable');
  } catch (err) {
    console.warn(
      `[changeip-http] ipv6 probe failed at startup: ${String(err)}; ` +
      'monitor will keep retrying (error logs throttled)'
    );
    logState.nextErrorLogAtMs = Date.now() + MONITOR_ERROR_LOG_THROTTLE_MS;
    logState.suppressedErrorCount = 0;
    logState.failing = true;
  }
}

function startMonitor(config) {
  if (!config.ipEventsActive) return;

  const initialPending = loadChangeSession(config);
  const changeScannerEnabled = config.changeipEnabled || !!initialPending;
  if (!config.ipMonitorEnabled && !config.ipv6MonitorEnabled && !changeScannerEnabled) return;

  const naturalIpv4IntervalMs = Math.max(config.ipMonitorIntervalSeconds, 1) * 1000;
  const naturalIpv6IntervalMs = Math.max(config.ipMonitorIntervalSeconds, 1) * 1000;
  const changeIntervalMs = Math.max(config.changeMonitorIntervalSeconds, 1) * 1000;
  const ipv4LogState = createMonitorLogState();
  const ipv6LogState = createIpv6LogState();

  console.log(
    `[changeip-http] monitor enabled: natural_ipv4=${config.ipMonitorEnabled ? `${config.ipMonitorIntervalSeconds}s` : 'off'}, ` +
    `natural_ipv6=${config.ipv6MonitorEnabled ? `${config.ipMonitorIntervalSeconds}s(shared)` : 'off'}, ` +
    `change=${changeScannerEnabled ? `${config.changeMonitorIntervalSeconds}s` : 'off'}`
  );

  let running = false;
  let timer = null;

  let naturalIpv4DueMs = config.ipMonitorEnabled ? Date.now() : NEVER;
  let naturalIpv6DueMs = config.ipv6MonitorEnabled ? Date.now() : NEVER;
  let changeDueMs = changeScannerEnabled ? Date.now() : NEVER;

  const scheduleNextTick = () => {
    if (timer) clearTimeout(timer);
    const nextDueMs = Math.min(naturalIpv4DueMs, naturalIpv6DueMs, changeDueMs);
    if (!Number.isFinite(nextDueMs)) return;
    const delayMs = Math.max(nextDueMs - Date.now(), 0);
    timer = setTimeout(tick, delayMs);
    timer.unref();
  };

  const tick = async () => {
    if (running) {
      scheduleNextTick();
      return;
    }

    running = true;
    recordMonitorTick();
    try {
      let nowMs = Date.now();

      if (nowMs >= changeDueMs) {
        const pendingResult = await handlePendingChange(config);
        nowMs = Date.now();

        if (pendingResult.handled) {
          if (pendingResult.done) {
            changeDueMs = config.changeipEnabled ? nowMs + changeIntervalMs : NEVER;
          } else {
            changeDueMs = normalizeDueMs(pendingResult.nextDueMs, nowMs + changeIntervalMs, nowMs);
          }
        } else {
          changeDueMs = config.changeipEnabled ? nowMs + changeIntervalMs : NEVER;
        }
      }

      const hasPending = !!loadChangeSession(config)?.op_id;
      nowMs = Date.now();
      naturalIpv4DueMs = reconcileNaturalDueMs({
        ipMonitorEnabled: config.ipMonitorEnabled,
        hasPending,
        naturalDueMs: naturalIpv4DueMs,
        nowMs
      });
      naturalIpv6DueMs = reconcileNaturalDueMs({
        ipMonitorEnabled: config.ipv6MonitorEnabled,
        hasPending,
        naturalDueMs: naturalIpv6DueMs,
        nowMs
      });

      if (Number.isFinite(naturalIpv4DueMs) && nowMs >= naturalIpv4DueMs) {
        const ipv4Result = await handleNaturalIpv4Monitor(config);
        if (!ipv4Result.ok) {
          markMonitorFailure(ipv4LogState, 'ipv4', ipv4Result.error, nowMs);
        } else {
          markMonitorSuccess(ipv4LogState, 'ipv4');
        }
        naturalIpv4DueMs = Date.now() + naturalIpv4IntervalMs;
      }

      nowMs = Date.now();
      if (Number.isFinite(naturalIpv6DueMs) && nowMs >= naturalIpv6DueMs) {
        const ipv6Result = await handleNaturalIpv6Monitor(config);
        if (!ipv6Result.ok) {
          markIpv6MonitorFailure(ipv6LogState, ipv6Result.error, nowMs);
        } else {
          markIpv6MonitorSuccess(ipv6LogState);
        }
        naturalIpv6DueMs = Date.now() + naturalIpv6IntervalMs;
      }
    } catch (err) {
      console.error('[changeip-http] monitor tick error:', String(err));
      recordMonitorTickError(err);
    } finally {
      running = false;
      scheduleNextTick();
    }
  };

  if (config.ipv6MonitorEnabled) {
    void runIpv6StartupProbe(config, ipv6LogState);
  }
  void tick();
}

module.exports = {
  startMonitor
};
