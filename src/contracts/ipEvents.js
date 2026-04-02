const { isValidOpId } = require('../opId');

const IP_EVENTS_CONTRACT_VERSION = '2026-04-03.v1';
const SUPPORTED_IP_EVENTS_CONTRACT_VERSIONS = Object.freeze([IP_EVENTS_CONTRACT_VERSION]);

const IP_EVENT_TYPES = Object.freeze({
  IPV4_CHANGED: 'ipv4_changed',
  IPV6_CHANGED: 'ipv6_changed',
  CHANGE_STARTED: 'change_started',
  CHANGE_SUCCEEDED: 'change_succeeded',
  CHANGE_NO_CHANGE: 'change_no_change',
  CHANGE_FAILED: 'change_failed'
});

const ALLOWED_IP_EVENTS = Object.freeze(Object.values(IP_EVENT_TYPES));
const ALLOWED_IP_EVENT_SET = new Set(ALLOWED_IP_EVENTS);
const COMMON_REQUIRED_FIELDS = Object.freeze(['server_label', 'op_id', 'ts', 'contract_version']);
const COMMON_REQUIRED_PRESENCE_FIELDS = Object.freeze(['channel']);

const REQUIRED_FIELDS_BY_EVENT = Object.freeze({
  [IP_EVENT_TYPES.IPV4_CHANGED]: Object.freeze(['old_ipv4', 'new_ipv4']),
  [IP_EVENT_TYPES.IPV6_CHANGED]: Object.freeze(['old_ipv6', 'new_ipv6']),
  [IP_EVENT_TYPES.CHANGE_STARTED]: Object.freeze([]),
  [IP_EVENT_TYPES.CHANGE_SUCCEEDED]: Object.freeze(['new_ipv4']),
  [IP_EVENT_TYPES.CHANGE_NO_CHANGE]: Object.freeze(['old_ipv4']),
  [IP_EVENT_TYPES.CHANGE_FAILED]: Object.freeze(['reason'])
});

function listMissingFields(fields, payload) {
  const missing = [];
  for (const field of fields) {
    const value = payload ? payload[field] : undefined;
    if (String(value ?? '').trim() === '') missing.push(field);
  }
  return missing;
}

function isValidTimestamp(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const ms = Date.parse(text);
  return Number.isFinite(ms);
}

function isValidChannel(value) {
  const text = String(value ?? '').trim();
  if (text === '') return true;
  if (text.startsWith('@')) {
    const username = text.slice(1);
    return /^[A-Za-z0-9_]{5,64}$/.test(username);
  }
  return /^-\d{5,20}$/.test(text);
}

function listMissingRequiredFields(event, payload) {
  const required = REQUIRED_FIELDS_BY_EVENT[event];
  if (!required) return ['event'];
  return listMissingFields(required, payload);
}

function listMissingCommonFields(payload) {
  return listMissingFields(COMMON_REQUIRED_FIELDS, payload);
}

function normalizeEventChannel(value) {
  return String(value ?? '').trim();
}

function isValidEventChannel(value) {
  return isValidChannel(normalizeEventChannel(value));
}

function validateEventPayload(payload) {
  const event = String(payload?.event || '').trim();
  if (!ALLOWED_IP_EVENT_SET.has(event)) {
    return { ok: false, error: `unknown event: ${event || '<empty>'}` };
  }
  const missingCommon = listMissingCommonFields(payload);
  if (missingCommon.length > 0) {
    return { ok: false, error: `missing required field(s): ${missingCommon.join(',')}` };
  }
  if (!isValidOpId(payload.op_id)) {
    return { ok: false, error: 'invalid op_id format' };
  }
  if (!isValidTimestamp(payload.ts)) {
    return { ok: false, error: 'invalid ts format' };
  }
  const contractVersion = String(payload.contract_version || '').trim();
  if (!SUPPORTED_IP_EVENTS_CONTRACT_VERSIONS.includes(contractVersion)) {
    return { ok: false, error: `unsupported contract_version: ${contractVersion || '<empty>'}` };
  }
  const missingPresence = COMMON_REQUIRED_PRESENCE_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(payload || {}, field));
  if (missingPresence.length > 0) {
    return { ok: false, error: `missing required field(s): ${missingPresence.join(',')}` };
  }
  if (!isValidEventChannel(payload?.channel)) {
    return { ok: false, error: 'invalid channel' };
  }

  const missing = listMissingRequiredFields(event, payload);
  if (missing.length > 0) {
    return { ok: false, error: `missing required field(s) for ${event}: ${missing.join(',')}` };
  }
  return { ok: true, event };
}

module.exports = {
  ALLOWED_IP_EVENTS,
  COMMON_REQUIRED_PRESENCE_FIELDS,
  IP_EVENTS_CONTRACT_VERSION,
  IP_EVENT_TYPES,
  REQUIRED_FIELDS_BY_EVENT,
  SUPPORTED_IP_EVENTS_CONTRACT_VERSIONS,
  isValidEventChannel,
  normalizeEventChannel,
  validateEventPayload
};
