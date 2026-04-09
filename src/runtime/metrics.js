const STARTED_AT_MS = Date.now();
const STARTED_AT_ISO = new Date(STARTED_AT_MS).toISOString();
const MAX_RECENT_ERRORS = 20;

const counters = Object.create(null);
const ipEventByType = Object.create(null);
const recentErrors = [];

function incrementCounter(name, delta = 1) {
  if (!name) return;
  counters[name] = (Number(counters[name]) || 0) + delta;
}

function safeEventName(event) {
  const name = String(event || '').trim().toLowerCase();
  return name || 'unknown';
}

function ensureEventBucket(event) {
  const key = safeEventName(event);
  if (!Object.prototype.hasOwnProperty.call(ipEventByType, key)) {
    ipEventByType[key] = {
      attempts: 0,
      ok: 0,
      fail: 0
    };
  }
  return ipEventByType[key];
}

function recordError(scope, error) {
  const text = String(error || 'unknown_error').slice(0, 300);
  recentErrors.push({
    ts: new Date().toISOString(),
    scope: String(scope || 'unknown'),
    error: text
  });
  if (recentErrors.length > MAX_RECENT_ERRORS) {
    recentErrors.splice(0, recentErrors.length - MAX_RECENT_ERRORS);
  }
}

function recordIpEventPostAttempt(event) {
  incrementCounter('ip_event_post_attempts_total', 1);
  ensureEventBucket(event).attempts += 1;
}

function recordIpEventPostSuccess(event) {
  incrementCounter('ip_event_post_ok_total', 1);
  ensureEventBucket(event).ok += 1;
}

function recordIpEventPostFailure(event, error) {
  incrementCounter('ip_event_post_fail_total', 1);
  ensureEventBucket(event).fail += 1;
  recordError('ip_event_post', error);
}

function recordChangeipRequest(outcome) {
  incrementCounter('changeip_requests_total', 1);
  const key = String(outcome || '').trim().toLowerCase();
  if (key) incrementCounter(`changeip_requests_${key}_total`, 1);
}

function recordIpqualityRequest(outcome) {
  incrementCounter('ipquality_requests_total', 1);
  const key = String(outcome || '').trim().toLowerCase();
  if (key) incrementCounter(`ipquality_requests_${key}_total`, 1);
}

function recordIpqualityRunStarted() {
  incrementCounter('ipquality_runs_started_total', 1);
}

function recordIpqualityRunSucceeded() {
  incrementCounter('ipquality_runs_succeeded_total', 1);
}

function recordIpqualityRunFailed(error) {
  incrementCounter('ipquality_runs_failed_total', 1);
  recordError('ipquality_run', error);
}

function recordMonitorTick() {
  incrementCounter('monitor_ticks_total', 1);
}

function recordMonitorTickError(error) {
  incrementCounter('monitor_tick_errors_total', 1);
  recordError('monitor_tick', error);
}

function recordPendingTimeoutStuckAlert(reason) {
  incrementCounter('pending_timeout_stuck_alerts_total', 1);
  recordError('pending_timeout_stuck', reason || 'unknown');
}

function cloneIpEventBuckets() {
  const out = Object.create(null);
  for (const [event, bucket] of Object.entries(ipEventByType)) {
    out[event] = {
      attempts: Number(bucket?.attempts || 0),
      ok: Number(bucket?.ok || 0),
      fail: Number(bucket?.fail || 0)
    };
  }
  return out;
}

function cloneRecentErrors() {
  return recentErrors.map((item) => ({
    ts: String(item?.ts || ''),
    scope: String(item?.scope || ''),
    error: String(item?.error || '')
  }));
}

function getRuntimeMetricsSnapshot() {
  return {
    started_at: STARTED_AT_ISO,
    uptime_seconds: Math.max(Math.floor((Date.now() - STARTED_AT_MS) / 1000), 0),
    counters: { ...counters },
    ip_event_post_by_type: cloneIpEventBuckets(),
    recent_errors: cloneRecentErrors()
  };
}

module.exports = {
  getRuntimeMetricsSnapshot,
  recordChangeipRequest,
  recordIpqualityRequest,
  recordIpqualityRunFailed,
  recordIpqualityRunStarted,
  recordIpqualityRunSucceeded,
  recordIpEventPostAttempt,
  recordIpEventPostFailure,
  recordIpEventPostSuccess,
  recordMonitorTick,
  recordMonitorTickError,
  recordPendingTimeoutStuckAlert
};
