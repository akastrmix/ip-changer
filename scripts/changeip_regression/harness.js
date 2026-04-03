'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_ENTRY = path.join(ROOT, 'changeip_http_server.js');

const AUTH_TOKEN = 'regression-auth-token';
const EVENTS_TOKEN = 'regression-events-token';

function log(msg) {
  process.stdout.write(`[regression] ${msg}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function writeShellScript(filePath, body) {
  const content = `#!/bin/bash
set -e
${body}
`;
  fs.writeFileSync(filePath, content, { mode: 0o700 });
}

function httpRequest({ port, method = 'GET', pathname = '/', body, rawBody, headers }) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined
      ? String(rawBody)
      : (body === undefined ? null : JSON.stringify(body));
    const requestHeaders = payload
      ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(headers || {})
        }
      : headers;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: requestHeaders
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode || 0, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitUntil(checkFn, { timeoutMs = 10000, intervalMs = 150, label = 'wait timeout' } = {}) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await checkFn();
      if (ok) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  if (lastErr) {
    throw new Error(`${label}: ${String(lastErr)}`);
  }
  throw new Error(label);
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function startEventSink({ delayMs = 0 } = {}) {
  const events = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { _raw: text };
      }
      events.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsed
      });
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end('{"ok":true}');
      }, Math.max(delayMs, 0));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return {
    port,
    events,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function startHttpFlowMockPanel({
  username = 'demo-user',
  password = 'demo-pass',
  dropOnChange = false
} = {}) {
  const calls = [];
  const csrfToken = 'csrf-token-123';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body
      });

      if (req.method === 'GET' && req.url === '/login') {
        res.statusCode = 200;
        res.setHeader('set-cookie', ['session=abc123; Path=/; HttpOnly']);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(`<input type="hidden" name="_token" value="${csrfToken}">`);
        return;
      }

      if (req.method === 'POST' && req.url === '/login') {
        const form = new URLSearchParams(body);
        const cookie = String(req.headers.cookie || '');
        const tokenOk = form.get('_token') === csrfToken;
        const userOk = form.get('username') === username;
        const passOk = form.get('password') === password;
        const cookieOk = cookie.includes('session=abc123');
        if (!tokenOk || !userOk || !passOk || !cookieOk) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
        res.statusCode = 302;
        res.setHeader('location', '/panel');
        res.setHeader('set-cookie', ['auth=1; Path=/; HttpOnly']);
        res.end('');
        return;
      }

      if (req.method === 'GET' && req.url === '/panel') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('panel ready');
        return;
      }

      if (req.method === 'POST' && req.url === '/api/change-ip') {
        const cookie = String(req.headers.cookie || '');
        const form = new URLSearchParams(body);
        const cookieOk = cookie.includes('session=abc123') && cookie.includes('auth=1');
        const actionOk = form.get('action') === 'change';
        if (!cookieOk || !actionOk) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
        if (dropOnChange) {
          req.socket.destroy();
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end('{"ok":true}');
        return;
      }

      res.statusCode = 404;
      res.end('not found');
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return {
    port,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function startHttpFlowResilienceMock({
  retryFailCount = 2,
  progressReadyAfter = 3
} = {}) {
  const calls = {
    retryReady: 0,
    progress: 0
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/retry-ready') {
        calls.retryReady += 1;
        if (calls.retryReady <= retryFailCount) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end('{"ok":false,"stage":"retry"}');
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end('{"ok":true,"stage":"retry"}');
        return;
      }

      if (req.method === 'POST' && req.url === '/progress') {
        calls.progress += 1;
        const ready = calls.progress >= progressReadyAfter;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ state: ready ? 'ready' : 'pending', n: calls.progress }));
        return;
      }

      res.statusCode = 404;
      res.end('not found');
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return {
    port,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function startHttpFlowRetryAfterMock({
  retryAfterSeconds = 1,
  failCount = 1
} = {}) {
  const calls = {
    total: 0,
    firstLimitedAt: 0,
    firstSuccessAt: 0
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/retry-after') {
        calls.total += 1;
        if (calls.total <= failCount) {
          if (!calls.firstLimitedAt) calls.firstLimitedAt = Date.now();
          res.statusCode = 429;
          res.setHeader('retry-after', String(retryAfterSeconds));
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end('{"ok":false,"reason":"rate_limited"}');
          return;
        }

        if (!calls.firstSuccessAt) calls.firstSuccessAt = Date.now();
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end('{"ok":true}');
        return;
      }

      res.statusCode = 404;
      res.end('not found');
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return {
    port,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function startIpChanger(env) {
  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let logs = '';
  proc.stdout.on('data', (d) => {
    logs += d.toString('utf8');
  });
  proc.stderr.on('data', (d) => {
    logs += d.toString('utf8');
  });

  await waitUntil(async () => {
    if (proc.exitCode !== null) {
      throw new Error(`process exited early with code ${proc.exitCode}`);
    }
    try {
      const resp = await httpRequest({ port: Number(env.PORT), method: 'GET', pathname: '/' });
      return resp.status === 200 && !!resp.json?.ok;
    } catch {
      return false;
    }
  }, { label: 'ip-changer did not become ready' });

  return {
    proc,
    logs: () => logs
  };
}

async function startIpChangerExpectConfigError(env, expectedText) {
  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  proc.stdout.on('data', (d) => {
    logs += d.toString('utf8');
  });
  proc.stderr.on('data', (d) => {
    logs += d.toString('utf8');
  });

  await waitUntil(async () => proc.exitCode !== null, {
    timeoutMs: 5000,
    label: 'expected ip-changer to exit with config error'
  });

  assert(proc.exitCode !== 0, `expected non-zero exit code, got ${proc.exitCode}`);
  assert(logs.includes(expectedText), `expected logs to include "${expectedText}", got: ${logs}`);
}

async function stopIpChanger(proc) {
  if (proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => proc.once('exit', resolve)),
    sleep(2000).then(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    })
  ]);
}

function buildEnv({
  port,
  endpoint,
  provider = 'script',
  scriptPath = '',
  execCommand = '',
  httpFlowFile = '',
  stateFile,
  pendingFile
}) {
  const env = {
    AUTH_TOKEN,
    PORT: String(port),
    CHANGEIP_ENABLED: '1',
    CHANGEIP_PROVIDER: provider,
    REBOOT_DELAY_MINUTES: '-1',
    IP_EVENTS_ENABLED: '1',
    IP_EVENTS_ENDPOINT: endpoint,
    IP_EVENTS_TOKEN: EVENTS_TOKEN,
    IP_MONITOR_ENABLED: '0',
    SERVER_LABEL: 'REGRESSION',
    REPORT_CHANNEL: '',
    ALLOW_PUBLIC_IPV4_OVERRIDE: '1',
    PUBLIC_IPV4_OVERRIDE: '198.51.100.10',
    IP_STATE_FILE: stateFile,
    PENDING_CHANGE_FILE: pendingFile,
    CHANGE_MONITOR_START_DELAY_SECONDS: '3600',
    CHANGE_MONITOR_INTERVAL_SECONDS: '2',
    CHANGE_MONITOR_TIMEOUT_SECONDS: '600'
  };
  if (provider === 'script') env.CHANGEIP_SCRIPT = scriptPath;
  if (provider === 'exec') env.CHANGEIP_EXEC_COMMAND = execCommand;
  if (provider === 'http_flow') env.CHANGEIP_HTTP_FLOW_FILE = httpFlowFile;
  return env;
}

function makeCaseFiles(tmpRoot, name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    stateFile: path.join(dir, 'ip_state.json'),
    pendingFile: path.join(dir, 'pending_change.json')
  };
}

async function postChangeIp(port, extraBody = null) {
  const extra = extraBody && typeof extraBody === 'object' ? extraBody : {};
  return httpRequest({
    port,
    method: 'POST',
    pathname: '/changeip',
    body: { token: AUTH_TOKEN, ...extra }
  });
}

async function postInfo(port) {
  return httpRequest({
    port,
    method: 'POST',
    pathname: '/info',
    body: { token: AUTH_TOKEN }
  });
}

async function postRawJson(port, pathname, rawBody) {
  return httpRequest({
    port,
    method: 'POST',
    pathname,
    rawBody,
    headers: {
      'content-type': 'application/json'
    }
  });
}

async function runWithServer(env, fn) {
  const { proc, logs } = await startIpChanger(env);
  try {
    await fn();
  } catch (err) {
    err.message = `${err.message}\n--- ip-changer logs ---\n${logs()}`;
    throw err;
  } finally {
    await stopIpChanger(proc);
  }
}

module.exports = {
  assert,
  buildEnv,
  getFreePort,
  log,
  makeCaseFiles,
  postChangeIp,
  postInfo,
  postRawJson,
  runWithServer,
  sleep,
  startEventSink,
  startIpChanger,
  stopIpChanger,
  startHttpFlowMockPanel,
  startHttpFlowResilienceMock,
  startHttpFlowRetryAfterMock,
  startIpChangerExpectConfigError,
  waitUntil,
  writeShellScript
};
