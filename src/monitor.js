const { startMonitor } = require('./monitor/start');
const {
  MONITOR_ERROR_LOG_THROTTLE_MS,
  NEVER,
  computePendingNextDueMs,
  createMonitorLogState,
  createIpv6LogState,
  markMonitorFailure,
  markIpv6MonitorFailure,
  markMonitorSuccess,
  markIpv6MonitorSuccess,
  reconcileNaturalDueMs
} = require('./monitor/helpers');

module.exports = {
  startMonitor,
  _test: {
    MONITOR_ERROR_LOG_THROTTLE_MS,
    NEVER,
    computePendingNextDueMs,
    reconcileNaturalDueMs,
    createMonitorLogState,
    createIpv6LogState,
    markMonitorFailure,
    markIpv6MonitorFailure,
    markMonitorSuccess,
    markIpv6MonitorSuccess
  }
};
