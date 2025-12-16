// Minimal HTTP server on VPS to trigger changeip + reboot
// Usage:
//   AUTH_TOKEN=your-secret PORT=8787 node changeip_http_server.js
//
// Then POST to:
//   http://<vps-ip>:8787/changeip  with JSON body: { "token": "your-secret" }

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const httpClient = require('http');
const httpsClient = require('https');
const { URL } = require('url');
const { spawn } = require('child_process');

const PORT = parsePositiveInt(process.env.PORT, 8787, { min: 1, max: 65535 });
const AUTH_TOKEN = (process.env.AUTH_TOKEN || '').trim();
const CHANGEIP_SCRIPT = process.env.CHANGEIP_SCRIPT || '/root/changeip.sh';
const REBOOT_DELAY_MINUTES = parsePositiveInt(process.env.REBOOT_DELAY_MINUTES, 16, { min: 1, max: 60 * 24 * 7 });

const CHANGEIP_ENABLED = parseBool(process.env.CHANGEIP_ENABLED ?? '1');

const IP_MONITOR_ENABLED = parseBool(process.env.IP_MONITOR_ENABLED ?? '0');
const IP_MONITOR_INTERVAL_SECONDS = parsePositiveInt(process.env.IP_MONITOR_INTERVAL_SECONDS, 60, { min: 10, max: 24 * 60 * 60 });
const IP_STATE_FILE = process.env.IP_STATE_FILE || '/var/lib/changeip-http/ip_state.json';
const IP_REPORT_ENDPOINT = (process.env.IP_REPORT_ENDPOINT || '').trim();
const IP_REPORT_TOKEN = (process.env.IP_REPORT_TOKEN || '').trim();
const SERVER_LABEL = (process.env.SERVER_LABEL || '').trim() || 'SERVER';
const REPORT_CHANNEL = (process.env.REPORT_CHANNEL || '').trim();
const IP_MONITOR_ACTIVE = IP_MONITOR_ENABLED && !!IP_REPORT_ENDPOINT && !!IP_REPORT_TOKEN;

if (!AUTH_TOKEN) {
  console.error('[changeip-http] AUTH_TOKEN is not set. Refusing to start.');
  process.exit(1);
}

const SHUTDOWN_BIN = resolveShutdownBin();

function parseBool(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
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

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req, res, { maxBytes = 1024 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let responded = false;

    req.on('data', (chunk) => {
      if (responded) return;
      total += chunk.length;
      if (total > maxBytes) {
        responded = true;
        jsonResponse(res, 413, { ok: false, error: 'payload too large' });
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (responded) return resolve(null);
      const body = Buffer.concat(chunks, total).toString('utf8');
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch (_err) {
        jsonResponse(res, 400, { ok: false, error: 'invalid json' });
        return resolve(null);
      }
      resolve(parsed && typeof parsed === 'object' ? parsed : {});
    });

    req.on('error', () => resolve(null));
  });
}

function scheduleReboot() {
  const delayMinutes = Math.max(REBOOT_DELAY_MINUTES, 1);
  console.log(`[changeip-http] scheduling reboot in ${delayMinutes} minutes...`);

  const proc = spawn(SHUTDOWN_BIN, ['-r', `+${delayMinutes}`], {
    stdio: 'ignore',
    detached: true
  });
  proc.on('error', (err) => {
    console.error('[changeip-http] failed to schedule reboot:', String(err));
  });
  proc.unref();
}

function runChangeIp(res) {
  if (!CHANGEIP_ENABLED) {
    return jsonResponse(res, 403, { ok: false, error: 'changeip disabled' });
  }
  if (!fs.existsSync(CHANGEIP_SCRIPT)) {
    return jsonResponse(res, 500, { ok: false, error: 'changeip script not found' });
  }
  try {
    // We execute via /bin/bash, so readability is enough; executable bit is optional.
    fs.accessSync(CHANGEIP_SCRIPT, fs.constants.R_OK);
  } catch (err) {
    return jsonResponse(res, 500, { ok: false, error: 'changeip script not readable' });
  }

  console.log(`[changeip-http] starting changeip script: ${CHANGEIP_SCRIPT} ...`);

  let proc;
  try {
    proc = spawn('/bin/bash', [CHANGEIP_SCRIPT], {
      stdio: 'ignore',
      detached: true
    });
  } catch (err) {
    console.error('[changeip-http] failed to spawn changeip script:', err);
    return jsonResponse(res, 500, { ok: false, error: 'failed to spawn changeip script' });
  }

  proc.on('error', (err) => {
    console.error('[changeip-http] failed to start changeip script:', err);
  });

  proc.unref();

  scheduleReboot();

  jsonResponse(res, 200, {
    ok: true,
    message: `changeip started, reboot scheduled in ${REBOOT_DELAY_MINUTES} minutes`,
    server_label: SERVER_LABEL,
    channel: REPORT_CHANNEL,
    old_ipv4: loadState().notified_ipv4 || null
  });
}

function handleRequest(req, res) {
  const { method, url } = req;

  if (method === 'GET' && url === '/') {
    return jsonResponse(res, 200, { ok: true, service: 'changeip-http' });
  }

  if (method === 'POST' && url === '/info') {
    readJsonBody(req, res).then((parsed) => {
      if (!parsed) return;
      const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
      if (!token || !safeTokenEquals(token, AUTH_TOKEN)) {
        jsonResponse(res, 403, { ok: false, error: 'forbidden' });
        return;
      }

      const state = loadState();
      jsonResponse(res, 200, {
        ok: true,
        server_label: SERVER_LABEL,
        channel: REPORT_CHANNEL,
        changeip_enabled: CHANGEIP_ENABLED,
        ip_monitor_enabled: IP_MONITOR_ACTIVE,
        notified_ipv4: state.notified_ipv4 || null
      });
    });
    return;
  }

  if (method === 'POST' && url === '/changeip') {
    readJsonBody(req, res).then((parsed) => {
      if (!parsed) return;
      const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
      if (!token || !safeTokenEquals(token, AUTH_TOKEN)) {
        jsonResponse(res, 403, { ok: false, error: 'forbidden' });
        return;
      }

      runChangeIp(res);
    });
    return;
  }

  jsonResponse(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[changeip-http] listening on 0.0.0.0:${PORT}`);
});
server.on('error', (err) => {
  console.error('[changeip-http] server error:', String(err));
  process.exit(1);
});

function isValidIpv4(value) {
  const ip = String(value || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const parts = ip.split('.').map((n) => parseInt(n, 10));
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
}

function ensureDirFor(filePath) {
  const dir = require('path').dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  try {
    const raw = fs.readFileSync(IP_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    ensureDirFor(IP_STATE_FILE);
    const tmp = `${IP_STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, IP_STATE_FILE);
  } catch (err) {
    console.error('[changeip-http] failed to save state:', String(err));
  }
}

function requestText(urlString, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'https:' ? httpsClient : httpClient;
    const req = lib.request(url, {
      method: 'GET',
      timeout: timeoutMs,
      family: 4,
      headers: { 'user-agent': 'ip-changer/1.0' }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
          return;
        }
        reject(new Error(`status ${res.statusCode || 0}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchPublicIpv4() {
  const sources = [
    async () => (await requestText('https://api.ipify.org')).trim(),
    async () => (await requestText('https://ipv4.icanhazip.com')).trim(),
    async () => {
      const text = await requestText('https://1.1.1.1/cdn-cgi/trace');
      const line = text.split('\n').find((l) => l.startsWith('ip='));
      return (line ? line.slice(3) : '').trim();
    }
  ];

  for (const get of sources) {
    try {
      const ip = await get();
      if (isValidIpv4(ip)) return ip;
    } catch {
      // try next
    }
  }
  throw new Error('failed to fetch public ipv4');
}

function postJson(urlString, { token, body, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'https:' ? httpsClient : httpClient;
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');

    const req = lib.request(url, {
      method: 'POST',
      timeout: timeoutMs,
      family: 4,
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, status: res.statusCode, text });
          return;
        }
        resolve({ ok: false, status: res.statusCode || 0, text });
      });
    });

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function reportIpChange(oldIpv4, newIpv4) {
  if (!IP_REPORT_ENDPOINT || !IP_REPORT_TOKEN) {
    return { ok: false, error: 'missing report endpoint/token' };
  }
  const detectedAt = new Date().toISOString();
  const resp = await postJson(IP_REPORT_ENDPOINT, {
    token: IP_REPORT_TOKEN,
    body: {
      server_label: SERVER_LABEL,
      channel: REPORT_CHANNEL,
      old_ipv4: oldIpv4 || null,
      new_ipv4: newIpv4,
      detected_at: detectedAt
    }
  });
  if (!resp.ok) {
    const msg = `${resp.status} ${resp.text || ''}`.trim().slice(0, 300);
    console.error('[changeip-http] ip report failed:', msg);
    return { ok: false, error: msg || `status ${resp.status}` };
  }
  return { ok: true, error: '' };
}

let monitorRunning = false;
async function monitorOnce() {
  if (monitorRunning) return;
  monitorRunning = true;
  try {
    const ip = await fetchPublicIpv4();
    const state = loadState();
    const notified = String(state.notified_ipv4 || '').trim();

    // First run: initialize baseline without reporting.
    if (!isValidIpv4(notified)) {
      state.notified_ipv4 = ip;
      state.observed_ipv4 = ip;
      state.updated_at = new Date().toISOString();
      saveState(state);
      return;
    }

    if (ip === notified) return;

    const result = await reportIpChange(notified, ip);
    state.observed_ipv4 = ip;
    state.updated_at = new Date().toISOString();
    if (result.ok) {
      state.notified_ipv4 = ip;
      state.last_report_at = state.updated_at;
      state.last_report_error = '';
    } else {
      state.last_report_error = result.error || state.updated_at;
    }
    saveState(state);
  } catch (err) {
    console.error('[changeip-http] monitor error:', String(err));
  } finally {
    monitorRunning = false;
  }
}

function startMonitor() {
  if (!IP_MONITOR_ENABLED) return;
  if (!IP_REPORT_ENDPOINT || !IP_REPORT_TOKEN) {
    console.error('[changeip-http] IP monitor enabled but IP_REPORT_ENDPOINT/IP_REPORT_TOKEN is missing; monitor disabled.');
    return;
  }
  const intervalMs = Math.max(IP_MONITOR_INTERVAL_SECONDS, 10) * 1000;
  console.log(`[changeip-http] ipv4 monitor enabled: every ${Math.round(intervalMs / 1000)}s, reporting to ${IP_REPORT_ENDPOINT}`);
  monitorOnce();
  setInterval(monitorOnce, intervalMs).unref();
}

startMonitor();
