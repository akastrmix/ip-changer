const {
  isSameOp,
  nowIso,
  resolvePendingSessionContext
} = require('./session/shared');
const {
  clearChangeSession,
  clearChangeSessionIfCurrent,
  hasInFlightChangeSession,
  loadChangeSession,
  startChangeSession
} = require('./session/store');
const {
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
  setChangeSessionOldIpv4
} = require('./session/mutations');
const { buildChangeStartedPayload, buildChangeTerminalPayload } = require('./session/payloads');
const { sendChangeFailedEvent, sendChangeStartedEvent } = require('./session/events');

module.exports = {
  buildChangeStartedPayload,
  buildChangeTerminalPayload,
  clearChangeSession,
  clearChangeSessionIfCurrent,
  hasInFlightChangeSession,
  isSameOp,
  loadChangeSession,
  markChangeSessionOfflineObserved,
  markChangeSessionProviderFailed,
  markChangeSessionProviderStarted,
  markChangeSessionProviderStartAttempted,
  markChangeSessionProviderRuntimeFailed,
  markChangeSessionTimeoutStuckAlert,
  markChangeSessionStarted,
  markChangeSessionTerminalSent,
  markChangeSessionRebootScheduleAttempted,
  nowIso,
  recordChangeSessionError,
  resolvePendingSessionContext,
  sendChangeFailedEvent,
  sendChangeStartedEvent,
  setChangeSessionOldIpv4,
  startChangeSession
};
