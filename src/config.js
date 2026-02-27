const crypto = require('crypto');
const fs = require('fs');

const CHANGEIP_PROVIDERS = new Set(['script', 'exec', 'http_flow']);

function parseBool(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function parseStrictRebootDelayMinutes(value, fallback) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (raw === '-1') return -1;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error('REBOOT_DELAY_MINUTES must be -1 or 1..15');
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

function resolveShutdownBin() {
  const candidates = ['/usr/sbin/shutdown', '/sbin/shutdown'];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return 'shutdown';
}

function requireNonEmpty(label, value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is not set`);
  return text;
}

function loadConfigFromEnv(env = process.env) {
  const port = parsePositiveInt(env.PORT, 8787, { min: 1, max: 65535 });
  const authToken = requireNonEmpty('AUTH_TOKEN', env.AUTH_TOKEN);

  const serverLabel = String(env.SERVER_LABEL || '').trim() || 'SERVER';
  const reportChannel = String(env.REPORT_CHANNEL || '').trim();

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

  const shutdownBin = resolveShutdownBin();

  const ipMonitorEnabled = parseBool(env.IP_MONITOR_ENABLED ?? '0');
  const ipMonitorIntervalSeconds = parsePositiveInt(env.IP_MONITOR_INTERVAL_SECONDS, 60, { min: 10, max: 24 * 60 * 60 });
  const ipStateFile = String(env.IP_STATE_FILE || '/var/lib/changeip-http/ip_state.json').trim();
  const pendingChangeFile = String(env.PENDING_CHANGE_FILE || '/var/lib/changeip-http/pending_change.json').trim();

  const ipEventsEnabled = parseBool(env.IP_EVENTS_ENABLED ?? '0');
  const ipEventsEndpoint = String(env.IP_EVENTS_ENDPOINT || '').trim();
  const ipEventsToken = String(env.IP_EVENTS_TOKEN || '').trim();
  const ipEventsActive = ipEventsEnabled && !!ipEventsEndpoint && !!ipEventsToken;

  const changeMonitorStartDelaySeconds = parsePositiveInt(env.CHANGE_MONITOR_START_DELAY_SECONDS, 30, { min: 0, max: 3600 });
  const changeMonitorIntervalSeconds = parsePositiveInt(env.CHANGE_MONITOR_INTERVAL_SECONDS, 10, { min: 1, max: 3600 });
  const changeMonitorTimeoutSeconds = parsePositiveInt(env.CHANGE_MONITOR_TIMEOUT_SECONDS, 600, { min: 10, max: 24 * 60 * 60 });

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
    ipStateFile,
    pendingChangeFile,
    ipEventsEnabled,
    ipEventsEndpoint,
    ipEventsToken,
    ipEventsActive,
    changeMonitorStartDelaySeconds,
    changeMonitorIntervalSeconds,
    changeMonitorTimeoutSeconds
  };
}

module.exports = {
  loadConfigFromEnv,
  parseBool,
  parsePositiveInt,
  safeTokenEquals
};
