const { isValidIpv4 } = require('../../ip/ipv4');
const { isValidOpId } = require('../../opId');
const { isValidRebootDelayMinutes } = require('../../change/session/shared');

const TERMINAL_EVENTS = new Set(['', 'change_succeeded', 'change_no_change', 'change_failed']);
const REQUIRED_KEYS = Object.freeze([
  'op_id',
  'server_label',
  'channel',
  'old_ipv4',
  'provider_start_attempted',
  'provider_start_attempted_at',
  'provider_started',
  'provider_failed_reason',
  'started_at',
  'reboot_delay_minutes',
  'reboot_schedule_attempted',
  'reboot_scheduled',
  'reboot_schedule_error',
  'reboot_scheduled_at',
  'started_sent',
  'monitor_after_ms',
  'timeout_at_ms',
  'terminal_sent',
  'terminal_event',
  'terminal_reason',
  'terminal_ipv4',
  'terminal_sent_at'
]);

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isBoolean(value) {
  return typeof value === 'boolean';
}

function isString(value) {
  return typeof value === 'string';
}

function isIsoTimestamp(value, { allowEmpty = false } = {}) {
  const text = String(value || '').trim();
  if (!text) return !!allowEmpty;
  return Number.isFinite(Date.parse(text));
}

function isNonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

function isNonNegativeInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0;
}

const REQUIRED_FIELD_VALIDATORS = Object.freeze([
  (pending) => isValidOpId(pending.op_id),
  (pending) => !!String(pending.server_label || '').trim(),
  (pending) => isString(pending.channel),
  (pending) => (pending.old_ipv4 === null || isValidIpv4(pending.old_ipv4)),
  (pending) => isBoolean(pending.provider_start_attempted),
  (pending) => isString(pending.provider_start_attempted_at),
  (pending) => isIsoTimestamp(pending.provider_start_attempted_at, { allowEmpty: true }),
  (pending) => isBoolean(pending.provider_started),
  (pending) => isString(pending.provider_failed_reason),
  (pending) => isIsoTimestamp(pending.started_at),
  (pending) => isValidRebootDelayMinutes(Number(pending.reboot_delay_minutes)),
  (pending) => isBoolean(pending.reboot_schedule_attempted),
  (pending) => isBoolean(pending.reboot_scheduled),
  (pending) => isString(pending.reboot_schedule_error),
  (pending) => isString(pending.reboot_scheduled_at),
  (pending) => isIsoTimestamp(pending.reboot_scheduled_at, { allowEmpty: true }),
  (pending) => isBoolean(pending.started_sent),
  (pending) => isNonNegativeNumber(pending.monitor_after_ms),
  (pending) => isNonNegativeNumber(pending.timeout_at_ms),
  (pending) => isBoolean(pending.terminal_sent),
  (pending) => isString(pending.terminal_event),
  (pending) => TERMINAL_EVENTS.has(String(pending.terminal_event || '').trim()),
  (pending) => isString(pending.terminal_reason),
  (pending) => isString(pending.terminal_ipv4),
  (pending) => !String(pending.terminal_ipv4 || '').trim() || isValidIpv4(pending.terminal_ipv4),
  (pending) => isString(pending.terminal_sent_at),
  (pending) => isIsoTimestamp(pending.terminal_sent_at, { allowEmpty: true })
]);

const OPTIONAL_FIELD_VALIDATORS = Object.freeze([
  { key: 'offline_observed', check: (pending) => isBoolean(pending.offline_observed) },
  { key: 'timeout_stuck_alert_next_at_ms', check: (pending) => isNonNegativeNumber(pending.timeout_stuck_alert_next_at_ms) },
  { key: 'timeout_stuck_alert_count', check: (pending) => isNonNegativeInteger(pending.timeout_stuck_alert_count) },
  {
    key: 'timeout_stuck_alert_last_at',
    check: (pending) => isString(pending.timeout_stuck_alert_last_at) &&
      isIsoTimestamp(pending.timeout_stuck_alert_last_at, { allowEmpty: true })
  },
  { key: 'timeout_stuck_alert_last_reason', check: (pending) => isString(pending.timeout_stuck_alert_last_reason) },
  { key: 'last_error', check: (pending) => isString(pending.last_error) }
]);

const CONSISTENCY_VALIDATORS = Object.freeze([
  (pending) => !pending.provider_start_attempted || !!String(pending.provider_start_attempted_at || '').trim(),
  (pending) => !pending.terminal_sent || !!String(pending.terminal_event || '').trim(),
  (pending) => pending.terminal_sent || !String(pending.terminal_event || '').trim(),
  (pending) => !pending.terminal_sent || !!String(pending.terminal_sent_at || '').trim()
]);

function isStrictPendingSchema(pending) {
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return false;

  for (const key of REQUIRED_KEYS) {
    if (!hasOwn(pending, key)) return false;
  }

  for (const validate of REQUIRED_FIELD_VALIDATORS) {
    if (!validate(pending)) return false;
  }

  for (const { key, check } of OPTIONAL_FIELD_VALIDATORS) {
    if (hasOwn(pending, key) && !check(pending)) return false;
  }

  for (const validate of CONSISTENCY_VALIDATORS) {
    if (!validate(pending)) return false;
  }

  return true;
}

module.exports = {
  isStrictPendingSchema
};
