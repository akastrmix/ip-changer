const crypto = require('crypto');
const fs = require('fs');
const { isValidEventChannel, normalizeEventChannel } = require('./contracts/ipEvents');

const CHANGEIP_PROVIDERS = new Set(['script', 'exec', 'http_flow']);

function parseBool(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function parsePositiveInt(label, value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${label} must be an integer`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${label} must be an integer`);
  }
  if (n < min || n > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return n;
}

function parseStrictRebootDelayMinutes(value, fallback) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (raw === '-1') return -1;
  if (!/^-?\d+$/.test(raw)) throw new Error('REBOOT_DELAY_MINUTES must be -1 or 1..15');
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error('REBOOT_DELAY_MINUTES must be -1 or 1..15');
  if (n === 0) throw new Error('REBOOT_DELAY_MINUTES=0 is forbidden');
  if (n < 1 || n > 15) throw new Error('REBOOT_DELAY_MINUTES must be -1 or 1..15');
  return n;
}

function safeTokenEquals(a, b) {
  const aBuf = Buffer.from(String(a ?? ''), 'utf8');
  const bBuf = Buffer.from(String(b ?? ''), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function resolveShutdownBin({ required = false, existsSync = fs.existsSync } = {}) {
  const candidates = ['/usr/sbin/shutdown', '/sbin/shutdown'];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  if (required) {
    throw new Error('shutdown binary not found (expected /usr/sbin/shutdown or /sbin/shutdown)');
  }
  return '';
}

function requireNonEmpty(label, value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is not set`);
  return text;
}

function requireValidReportChannel(value) {
  const channel = normalizeEventChannel(value);
  if (!isValidEventChannel(channel)) {
    throw new Error('REPORT_CHANNEL must be @channel_username, negative chat_id, or empty');
  }
  return channel;
}

function loadConfigFromEnv(env = process.env) {
  const port = parsePositiveInt('PORT', env.PORT, 8787, { min: 1, max: 65535 });
  const authToken = requireNonEmpty('AUTH_TOKEN', env.AUTH_TOKEN);

  const serverLabel = String(env.SERVER_LABEL || '').trim() || 'SERVER';
  const reportChannel = requireValidReportChannel(env.REPORT_CHANNEL);

  const changeipEnabled = parseBool(env.CHANGEIP_ENABLED ?? '0');
  const changeipProvider = String(env.CHANGEIP_PROVIDER || '').trim().toLowerCase();
  if (changeipEnabled && !changeipProvider) {
    throw new Error('CHANGEIP_PROVIDER is required when CHANGEIP_ENABLED=1');
  }
  if (changeipEnabled && !CHANGEIP_PROVIDERS.has(changeipProvider)) {
    throw new Error('CHANGEIP_PROVIDER must be one of: script, exec, http_flow');
  }
  const changeipScript = String(env.CHANGEIP_SCRIPT || '').trim();
  const changeipExecCommand = String(env.CHANGEIP_EXEC_COMMAND || '').trim();
  const changeipHttpFlowFile = String(env.CHANGEIP_HTTP_FLOW_FILE || '').trim();
  if (changeipEnabled && changeipProvider === 'script' && !changeipScript) {
    throw new Error('CHANGEIP_SCRIPT is required when CHANGEIP_PROVIDER=script');
  }
  if (changeipEnabled && changeipProvider === 'exec' && !changeipExecCommand) {
    throw new Error('CHANGEIP_EXEC_COMMAND is required when CHANGEIP_PROVIDER=exec');
  }
  if (changeipEnabled && changeipProvider === 'http_flow' && !changeipHttpFlowFile) {
    throw new Error('CHANGEIP_HTTP_FLOW_FILE is required when CHANGEIP_PROVIDER=http_flow');
  }
  const rebootDelayMinutes = changeipEnabled ? parseStrictRebootDelayMinutes(env.REBOOT_DELAY_MINUTES, 1) : 1;

  const shutdownBin = changeipEnabled && rebootDelayMinutes !== -1
    ? resolveShutdownBin({ required: true })
    : '';

  const ipMonitorEnabled = parseBool(env.IP_MONITOR_ENABLED ?? '0');
  const ipMonitorIntervalSeconds = parsePositiveInt(
    'IP_MONITOR_INTERVAL_SECONDS',
    env.IP_MONITOR_INTERVAL_SECONDS,
    60,
    { min: 10, max: 24 * 60 * 60 }
  );
  const ipv6MonitorEnabled = parseBool(env.IPV6_MONITOR_ENABLED ?? '0');
  const ipStateFile = String(env.IP_STATE_FILE || '/var/lib/changeip-http/ip_state.json').trim();
  const pendingChangeFile = String(env.PENDING_CHANGE_FILE || '/var/lib/changeip-http/pending_change.json').trim();

  const ipEventsEnabled = parseBool(env.IP_EVENTS_ENABLED ?? '0');
  const ipEventsEndpoint = String(env.IP_EVENTS_ENDPOINT || '').trim();
  const ipEventsToken = String(env.IP_EVENTS_TOKEN || '').trim();
  const ipEventsActive = ipEventsEnabled && !!ipEventsEndpoint && !!ipEventsToken;

  const ipqualityEnabled = parseBool(env.IPQUALITY_ENABLED ?? '0');
  const ipqualityScriptPath = String(env.IPQUALITY_SCRIPT_PATH || '').trim();
  if (ipqualityEnabled && !ipqualityScriptPath) {
    throw new Error('IPQUALITY_SCRIPT_PATH is required when IPQUALITY_ENABLED=1');
  }
  const ipqualityStateFile = String(env.IPQUALITY_STATE_FILE || '/var/lib/changeip-http/ipquality_state.json').trim();
  const ipqualityTimeoutSeconds = parsePositiveInt(
    'IPQUALITY_TIMEOUT_SECONDS',
    env.IPQUALITY_TIMEOUT_SECONDS,
    600,
    { min: 30, max: 3600 }
  );

  const changeMonitorStartDelaySeconds = parsePositiveInt(
    'CHANGE_MONITOR_START_DELAY_SECONDS',
    env.CHANGE_MONITOR_START_DELAY_SECONDS,
    30,
    { min: 0, max: 3600 }
  );
  const changeMonitorIntervalSeconds = parsePositiveInt(
    'CHANGE_MONITOR_INTERVAL_SECONDS',
    env.CHANGE_MONITOR_INTERVAL_SECONDS,
    10,
    { min: 1, max: 3600 }
  );
  const changeMonitorTimeoutSeconds = parsePositiveInt(
    'CHANGE_MONITOR_TIMEOUT_SECONDS',
    env.CHANGE_MONITOR_TIMEOUT_SECONDS,
    1800,
    { min: 10, max: 24 * 60 * 60 }
  );

  return {
    port,
    authToken,
    serverLabel,
    reportChannel,
    changeipEnabled,
    changeipProvider: changeipEnabled ? changeipProvider : '',
    changeipScript,
    changeipExecCommand,
    changeipHttpFlowFile,
    rebootDelayMinutes,
    shutdownBin,
    ipMonitorEnabled,
    ipMonitorIntervalSeconds,
    ipv6MonitorEnabled,
    ipStateFile,
    pendingChangeFile,
    ipEventsEnabled,
    ipEventsEndpoint,
    ipEventsToken,
    ipEventsActive,
    ipqualityEnabled,
    ipqualityScriptPath,
    ipqualityStateFile,
    ipqualityTimeoutSeconds,
    changeMonitorStartDelaySeconds,
    changeMonitorIntervalSeconds,
    changeMonitorTimeoutSeconds
  };
}

module.exports = {
  _test: {
    resolveShutdownBin
  },
  loadConfigFromEnv,
  parseBool,
  parsePositiveInt,
  safeTokenEquals
};
