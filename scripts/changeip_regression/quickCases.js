'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const { _test: monitorTestHelpers } = require('../../src/monitor');
const { _test: naturalTestHelpers } = require('../../src/monitor/natural');
const { _test: configTestHelpers, loadConfigFromEnv } = require('../../src/config');
const { isValidIpv4, _test: ipv4TestHelpers } = require('../../src/ip/ipv4');
const { makeIpQualityRunId, makeIpv4OpId, makeIpv6OpId } = require('../../src/opId');
const { _test: ipqualityRunnerTestHelpers } = require('../../src/ipquality/runner');
const {
  loadChangeSession,
  markChangeSessionTimeoutStuckAlert,
  startChangeSession
} = require('../../src/change/session');
const {
  IP_EVENT_TYPES,
  IP_EVENTS_CONTRACT_VERSION,
  validateEventPayload
} = require('../../src/contracts/ipEvents');
const { postIpEvent } = require('../../src/network/ipEvents');
const { requestText, postJson } = require('../../src/network/http');
const { compileFlowFromFile } = require('../../src/providers/httpFlow/compile');
const { runCompiledFlow } = require('../../src/providers/httpFlow/runtime');
const { assert } = require('./harness');

async function startMockServer(onRequest) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      try {
        await onRequest({ req, res, bodyText });
      } catch (err) {
        res.statusCode = 500;
        res.end(`mock server error: ${String(err)}`);
      }
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
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function startTruncatedHttpServer() {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write(
        'HTTP/1.1 200 OK\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        'Content-Length: 20\r\n' +
        'Connection: close\r\n' +
        '\r\n' +
        'short'
      );
      socket.end();
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
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function runFlowFromObject(tmpRoot, name, flowObject, env = process.env) {
  const filePath = path.join(tmpRoot, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(flowObject), 'utf8');

  const compiled = compileFlowFromFile(filePath, env);
  assert(compiled.ok, `flow compile failed for ${name}: ${compiled.error}`);
  await runCompiledFlow(compiled.flow, env);
}

async function testWaitUntilHardTimeout(tmpRoot) {
  const mock = await startMockServer(async ({ req, res }) => {
    if (req.method === 'GET' && req.url === '/slow-ready') {
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end('{"state":"ready"}');
      }, 900);
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  const flow = {
    base_url: `http://127.0.0.1:${mock.port}`,
    timeout_ms: 5000,
    steps: [
      {
        type: 'wait_until',
        name: 'ready_check',
        timeout_ms: 250,
        interval_ms: 50,
        request: {
          method: 'GET',
          url: '/slow-ready',
          expect_status: 200
        },
        assert: {
          from: 'body',
          includes: '"state":"ready"'
        }
      }
    ]
  };

  const startedAtMs = Date.now();
  let failed = false;
  let message = '';
  try {
    await runFlowFromObject(tmpRoot, 'quick.wait_until_hard_timeout', flow);
  } catch (err) {
    failed = true;
    message = String(err && err.message ? err.message : err);
  } finally {
    await mock.close();
  }

  assert(failed, 'wait_until hard-timeout case should fail');
  assert(
    message.includes('wait_until timeout after 250ms'),
    `expected wait_until timeout message, got: ${message}`
  );
  const elapsedMs = Date.now() - startedAtMs;
  assert(elapsedMs < 900, `wait_until should stop before slow response completes, elapsed=${elapsedMs}ms`);
}

async function testRequestRetriesConverge(tmpRoot) {
  let calls = 0;
  const mock = await startMockServer(async ({ req, res }) => {
    if (req.method === 'POST' && req.url === '/retry') {
      calls += 1;
      if (calls <= 2) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end('{"ok":false}');
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

  const flow = {
    base_url: `http://127.0.0.1:${mock.port}`,
    timeout_ms: 2000,
    steps: [
      {
        type: 'request',
        name: 'retry_to_success',
        method: 'POST',
        url: '/retry',
        json: {},
        retries: 2,
        retry_delay_ms: 20,
        expect_status: 200
      }
    ]
  };

  try {
    await runFlowFromObject(tmpRoot, 'quick.request_retries', flow);
  } finally {
    await mock.close();
  }

  assert(calls === 3, `expected 3 retry attempts, got ${calls}`);
}

async function testRetryAfterHonored(tmpRoot) {
  const calls = {
    total: 0,
    firstLimitedAt: 0n,
    firstSuccessAt: 0n
  };

  const mock = await startMockServer(async ({ req, res }) => {
    if (req.method === 'POST' && req.url === '/retry-after') {
      calls.total += 1;
      if (calls.total === 1) {
        // Use monotonic clock to avoid flakes when wall clock adjusts.
        calls.firstLimitedAt = process.hrtime.bigint();
        res.statusCode = 429;
        res.setHeader('retry-after', '1');
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end('{"ok":false,"reason":"rate_limited"}');
        return;
      }

      calls.firstSuccessAt = process.hrtime.bigint();
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end('{"ok":true}');
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  const flow = {
    base_url: `http://127.0.0.1:${mock.port}`,
    timeout_ms: 3000,
    steps: [
      {
        type: 'request',
        name: 'retry_after_path',
        method: 'POST',
        url: '/retry-after',
        json: {},
        retries: 1,
        retry_delay_ms: 20,
        expect_status: 200
      }
    ]
  };

  try {
    await runFlowFromObject(tmpRoot, 'quick.retry_after', flow);
  } finally {
    await mock.close();
  }

  assert(calls.total === 2, `expected 2 calls for retry-after flow, got ${calls.total}`);
  const diffMs = Number(calls.firstSuccessAt - calls.firstLimitedAt) / 1e6;
  assert(
    diffMs >= 800,
    `expected retry-after delay >= 800ms, got ${diffMs.toFixed(1)}ms`
  );
}

async function testHttpFlowResponseSizeGuard(tmpRoot) {
  const hugeBody = 'x'.repeat((5 * 1024 * 1024) + 512);
  const mock = await startMockServer(async ({ req, res }) => {
    if (req.method === 'GET' && req.url === '/huge') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(hugeBody);
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  const flow = {
    base_url: `http://127.0.0.1:${mock.port}`,
    timeout_ms: 4000,
    steps: [
      {
        type: 'request',
        name: 'huge_response',
        method: 'GET',
        url: '/huge',
        expect_status: 200
      }
    ]
  };

  let failed = false;
  let message = '';
  try {
    await runFlowFromObject(tmpRoot, 'quick.http_flow_response_too_large', flow);
  } catch (err) {
    failed = true;
    message = String(err && err.message ? err.message : err);
  } finally {
    await mock.close();
  }

  assert(failed, 'expected flow to fail when response body exceeds guard size');
  assert(
    message.includes('response too large'),
    `expected response-too-large error, got: ${message}`
  );
}

async function testNetworkHttpResponseSizeGuard() {
  const hugeBody = 'x'.repeat(2 * 1024);
  const mock = await startMockServer(async ({ req, res }) => {
    if (req.method === 'GET' && req.url === '/text') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(hugeBody);
      return;
    }

    if (req.method === 'POST' && req.url === '/json') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(hugeBody);
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  let getFailed = false;
  let getErr = '';
  try {
    await requestText(`http://127.0.0.1:${mock.port}/text`, {
      timeoutMs: 2000,
      maxResponseBytes: 1024
    });
  } catch (err) {
    getFailed = true;
    getErr = String(err && err.message ? err.message : err);
  }
  assert(getFailed, 'expected requestText to fail when response exceeds maxResponseBytes');
  assert(
    getErr.includes('response too large'),
    `expected requestText response-too-large error, got: ${getErr}`
  );

  let postFailed = false;
  let postErr = '';
  try {
    await postJson(`http://127.0.0.1:${mock.port}/json`, {
      body: { hello: 'world' },
      timeoutMs: 2000,
      maxResponseBytes: 1024
    });
  } catch (err) {
    postFailed = true;
    postErr = String(err && err.message ? err.message : err);
  } finally {
    await mock.close();
  }
  assert(postFailed, 'expected postJson to fail when response exceeds maxResponseBytes');
  assert(
    postErr.includes('response too large'),
    `expected postJson response-too-large error, got: ${postErr}`
  );
}

async function testNetworkHttpEarlyClose() {
  const mock = await startTruncatedHttpServer();
  let failed = false;
  let message = '';
  try {
    await requestText(`http://127.0.0.1:${mock.port}/truncated`, {
      timeoutMs: 2000,
      userAgent: 'ip-changer-test'
    });
  } catch (err) {
    failed = true;
    message = String(err && err.message ? err.message : err);
  } finally {
    await mock.close();
  }

  assert(failed, 'expected requestText to fail when upstream closes before full body');
  const lower = message.toLowerCase();
  assert(
    lower.includes('aborted') || lower.includes('closed before end') || lower.includes('socket hang up'),
    `expected early-close style error, got: ${message}`
  );
}

async function testHttpFlowEarlyClose(tmpRoot) {
  const mock = await startTruncatedHttpServer();
  const flow = {
    base_url: `http://127.0.0.1:${mock.port}`,
    timeout_ms: 4000,
    steps: [
      {
        type: 'request',
        name: 'early_close',
        method: 'GET',
        url: '/truncated',
        expect_status: 200
      }
    ]
  };

  let failed = false;
  let message = '';
  try {
    await runFlowFromObject(tmpRoot, 'quick.http_flow_early_close', flow);
  } catch (err) {
    failed = true;
    message = String(err && err.message ? err.message : err);
  } finally {
    await mock.close();
  }

  assert(failed, 'expected http_flow request to fail when upstream closes before full body');
  const lower = message.toLowerCase();
  assert(
    lower.includes('aborted') || lower.includes('closed before end') || lower.includes('socket hang up'),
    `expected early-close style error, got: ${message}`
  );
}

async function testIpEventsTerminalShortRetry() {
  const calls = {
    changeFailed: 0,
    ipv4Changed: 0
  };

  const mock = await startMockServer(async ({ req, res, bodyText }) => {
    if (req.method !== 'POST' || req.url !== '/internal/ip-events') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = {};
    }

    if (body.event === 'change_failed') {
      calls.changeFailed += 1;
      if (calls.changeFailed < 3) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end('{"ok":false}');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end('{"ok":true}');
      return;
    }

    if (body.event === 'ipv4_changed') {
      calls.ipv4Changed += 1;
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end('{"ok":false}');
      return;
    }

    res.statusCode = 400;
    res.end('unexpected event');
  });

  const config = loadConfigFromEnv({
    AUTH_TOKEN: 'token',
    CHANGEIP_ENABLED: '0',
    IP_EVENTS_ENABLED: '1',
    IP_EVENTS_ENDPOINT: `http://127.0.0.1:${mock.port}/internal/ip-events`,
    IP_EVENTS_TOKEN: 'events-token',
    SERVER_LABEL: 'HKT',
    REPORT_CHANNEL: '-1001234567890'
  });

  try {
    const terminal = await postIpEvent(config, {
      server_label: 'HKT',
      channel: '-1001234567890',
      op_id: '20260301T010203Z_hkt_ipv4_ab12cd',
      ts: '2026-03-01T01:02:03.000Z',
      event: 'change_failed',
      reason: 'unit_test'
    });
    assert(terminal.ok, 'expected change_failed to succeed after short retries');
    assert(calls.changeFailed === 3, `expected 3 attempts for terminal event, got ${calls.changeFailed}`);

    const natural = await postIpEvent(config, {
      server_label: 'HKT',
      channel: '-1001234567890',
      op_id: '20260301T010203Z_hkt_ipv4_bc23de',
      ts: '2026-03-01T01:02:03.000Z',
      event: 'ipv4_changed',
      old_ipv4: '1.2.3.4',
      new_ipv4: '5.6.7.8'
    });
    assert(!natural.ok, 'expected ipv4_changed not to use terminal retry policy');
    assert(calls.ipv4Changed === 1, `expected non-terminal event to post once, got ${calls.ipv4Changed}`);
  } finally {
    await mock.close();
  }
}

async function testNaturalIpv4RetriesReuseOpId(tmpRoot) {
  const events = [];
  let callCount = 0;
  const mock = await startMockServer(async ({ req, res, bodyText }) => {
    if (req.method !== 'POST' || req.url !== '/internal/ip-events') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = {};
    }
    events.push(body);
    callCount += 1;

    res.statusCode = callCount === 1 ? 500 : 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(callCount === 1 ? '{"ok":false}' : '{"ok":true}');
  });

  const stateFile = path.join(tmpRoot, 'quick.natural_ipv4_reuse_op_id.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    notified_ipv4: '1.2.3.4',
    observed_ipv4: '1.2.3.4',
    updated_at: '2026-03-01T00:00:00.000Z'
  }), 'utf8');

  const config = loadConfigFromEnv({
    AUTH_TOKEN: 'token',
    CHANGEIP_ENABLED: '0',
    IP_EVENTS_ENABLED: '1',
    IP_EVENTS_ENDPOINT: `http://127.0.0.1:${mock.port}/internal/ip-events`,
    IP_EVENTS_TOKEN: 'events-token',
    SERVER_LABEL: 'HKT',
    REPORT_CHANNEL: '-1001234567890',
    IP_STATE_FILE: stateFile
  });

  try {
    const first = await naturalTestHelpers.handleNaturalMonitor({
      config,
      enabled: true,
      fetchIp: async () => '5.6.7.8',
      isValidIp: isValidIpv4,
      makeOpId: makeIpv4OpId,
      event: 'ipv4_changed',
      notifiedField: 'notified_ipv4',
      observedField: 'observed_ipv4',
      oldField: 'old_ipv4',
      newField: 'new_ipv4',
      lastReportAtField: 'last_report_at',
      lastReportErrorField: 'last_report_error',
      pendingOpIdField: 'pending_ipv4_op_id',
      pendingOldField: 'pending_ipv4_old_ipv4',
      pendingNewField: 'pending_ipv4_new_ipv4'
    });
    assert(!first.ok, 'expected first ipv4_changed report to fail (mock 500)');
    assert(events.length === 1, `expected 1 ipv4_changed post, got ${events.length}`);
    const opId1 = String(events[0]?.op_id || '').trim();
    assert(opId1, 'expected first ipv4_changed to include op_id');

    const state1 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(
      String(state1.pending_ipv4_op_id || '').trim() === opId1,
      'expected pending_ipv4_op_id to be persisted after failed report'
    );

    const second = await naturalTestHelpers.handleNaturalMonitor({
      config,
      enabled: true,
      fetchIp: async () => '5.6.7.8',
      isValidIp: isValidIpv4,
      makeOpId: makeIpv4OpId,
      event: 'ipv4_changed',
      notifiedField: 'notified_ipv4',
      observedField: 'observed_ipv4',
      oldField: 'old_ipv4',
      newField: 'new_ipv4',
      lastReportAtField: 'last_report_at',
      lastReportErrorField: 'last_report_error',
      pendingOpIdField: 'pending_ipv4_op_id',
      pendingOldField: 'pending_ipv4_old_ipv4',
      pendingNewField: 'pending_ipv4_new_ipv4'
    });
    assert(second.ok, 'expected second ipv4_changed report to succeed (mock 200)');
    assert(events.length === 2, `expected 2 ipv4_changed posts, got ${events.length}`);
    const opId2 = String(events[1]?.op_id || '').trim();
    assert(opId2 === opId1, `expected retry to reuse same op_id, got ${opId1} then ${opId2}`);

    const state2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(
      String(state2.notified_ipv4 || '').trim() === '5.6.7.8',
      `expected notified_ipv4 updated after success, got: ${String(state2.notified_ipv4 || '')}`
    );
    assert(!String(state2.pending_ipv4_op_id || '').trim(), 'expected pending_ipv4_op_id cleared after success');
  } finally {
    await mock.close();
  }
}

async function testStartChangeSessionReportsPersistFailure(tmpRoot) {
  const caseDir = path.join(tmpRoot, 'quick.start_change_session_persist_failure');
  fs.mkdirSync(caseDir, { recursive: true });
  const parentFile = path.join(caseDir, 'pending_parent_file');
  fs.writeFileSync(parentFile, 'blocked', 'utf8');

  const config = loadConfigFromEnv({
    AUTH_TOKEN: 'token',
    CHANGEIP_ENABLED: '1',
    CHANGEIP_PROVIDER: 'exec',
    CHANGEIP_EXEC_COMMAND: '/bin/true',
    REBOOT_DELAY_MINUTES: '-1',
    IP_EVENTS_ENABLED: '1',
    IP_EVENTS_ENDPOINT: 'http://127.0.0.1/internal/ip-events',
    IP_EVENTS_TOKEN: 'events-token',
    PENDING_CHANGE_FILE: path.join(parentFile, 'pending_change.json'),
    SERVER_LABEL: 'HKT',
    REPORT_CHANNEL: '-1001234567890'
  });

  const originalError = console.error;
  console.error = () => {};
  let started;
  try {
    started = startChangeSession(config, {
      opId: '20260301T010203Z_hkt_ipv4_cc34ef',
      oldIpv4: '1.2.3.4',
      startedAt: new Date('2026-03-01T01:02:03.000Z')
    });
  } finally {
    console.error = originalError;
  }
  assert(!started.ok, 'expected startChangeSession to fail when pending file is not writable');
  assert(
    String(started.error || '').includes('failed to persist change session'),
    `expected persist failure error, got: ${started.error}`
  );
}

async function testPendingTimeoutRetryBackoffHelper() {
  const nextAfterTimeout = monitorTestHelpers.computePendingNextDueMs({
    nowMs: 5000,
    timeoutAtMs: 4500,
    fallbackNextDueMs: 9000
  });
  assert(nextAfterTimeout === 9000, `expected fallback due when already timed out, got ${nextAfterTimeout}`);

  const nextBeforeTimeout = monitorTestHelpers.computePendingNextDueMs({
    nowMs: 5000,
    timeoutAtMs: 5200,
    fallbackNextDueMs: 9000
  });
  assert(nextBeforeTimeout === 5200, `expected timeout boundary due before fallback, got ${nextBeforeTimeout}`);
}

async function testPendingTimeoutStuckAlertThrottleHelper(tmpRoot) {
  const pendingFile = path.join(tmpRoot, 'quick.pending_timeout_stuck_alert.json');
  const config = loadConfigFromEnv({
    AUTH_TOKEN: 'token',
    CHANGEIP_ENABLED: '1',
    CHANGEIP_PROVIDER: 'exec',
    CHANGEIP_EXEC_COMMAND: '/bin/true',
    REBOOT_DELAY_MINUTES: '-1',
    IP_EVENTS_ENABLED: '1',
    IP_EVENTS_ENDPOINT: 'http://127.0.0.1/internal/ip-events',
    IP_EVENTS_TOKEN: 'events-token',
    PENDING_CHANGE_FILE: pendingFile,
    SERVER_LABEL: 'HKT',
    REPORT_CHANNEL: '-1001234567890'
  });

  const started = startChangeSession(config, {
    opId: '20260228T101500Z_hkt_ipv4_ab12cd',
    oldIpv4: '1.2.3.4',
    startedAt: new Date('2026-02-28T10:15:00.000Z')
  });
  assert(started.ok, 'expected startChangeSession to persist pending session');

  const first = markChangeSessionTimeoutStuckAlert(config, started.pending.op_id, {
    nowMs: 1000,
    reason: 'first',
    cooldownMs: 10_000
  });
  const statAfterFirst = fs.statSync(pendingFile);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = markChangeSessionTimeoutStuckAlert(config, started.pending.op_id, {
    nowMs: 1500,
    reason: 'suppressed',
    cooldownMs: 10_000
  });
  const statAfterSecond = fs.statSync(pendingFile);
  const third = markChangeSessionTimeoutStuckAlert(config, started.pending.op_id, {
    nowMs: 11_001,
    reason: 'third',
    cooldownMs: 10_000
  });

  assert(first === true, 'expected first timeout-stuck alert to emit');
  assert(second === false, 'expected second timeout-stuck alert to be throttled');
  assert(
    statAfterSecond.mtimeMs === statAfterFirst.mtimeMs,
    'expected throttled timeout-stuck alert not to rewrite pending_change.json'
  );
  assert(third === true, 'expected timeout-stuck alert to re-emit after cooldown');

  const pending = loadChangeSession(config);
  assert(!!pending?.op_id, 'expected pending session still persisted');
  assert(
    pending.timeout_stuck_alert_count === 2,
    `expected timeout_stuck_alert_count=2, got ${pending.timeout_stuck_alert_count}`
  );
  assert(
    pending.timeout_stuck_alert_last_reason === 'third',
    `expected timeout_stuck_alert_last_reason=third, got ${pending.timeout_stuck_alert_last_reason}`
  );
}

async function testShutdownBinaryConfigFailsFast() {
  let message = '';
  const originalExistsSync = fs.existsSync;
  fs.existsSync = () => false;
  try {
    loadConfigFromEnv({
      AUTH_TOKEN: 'token',
      CHANGEIP_ENABLED: '1',
      CHANGEIP_PROVIDER: 'exec',
      CHANGEIP_EXEC_COMMAND: '/bin/true',
      REBOOT_DELAY_MINUTES: '1'
    });
  } catch (err) {
    message = String(err && err.message ? err.message : err);
  } finally {
    fs.existsSync = originalExistsSync;
  }

  assert(
    message.includes('shutdown binary not found'),
    `expected missing shutdown binary to fail fast, got: ${message || '<no error>'}`
  );

  const requiredMissing = (() => {
    try {
      configTestHelpers.resolveShutdownBin({ required: true, existsSync: () => false });
      return '';
    } catch (err) {
      return String(err && err.message ? err.message : err);
    }
  })();
  assert(
    requiredMissing.includes('shutdown binary not found'),
    `expected required shutdown resolution to fail fast, got: ${requiredMissing || '<no error>'}`
  );

  const skipped = configTestHelpers.resolveShutdownBin({ existsSync: () => false });
  assert(skipped === '', `expected optional shutdown resolution to return empty string, got: ${skipped}`);
}

async function testShutdownBinaryConfigFailsFastStable() {
  let requiredMissing = '';
  const originalExistsSync = fs.existsSync;
  fs.existsSync = () => false;
  try {
    loadConfigFromEnv({
      AUTH_TOKEN: 'token',
      CHANGEIP_ENABLED: '1',
      CHANGEIP_PROVIDER: 'exec',
      CHANGEIP_EXEC_COMMAND: '/bin/true',
      REBOOT_DELAY_MINUTES: '1'
    });
  } catch (err) {
    requiredMissing = String(err && err.message ? err.message : err);
  } finally {
    fs.existsSync = originalExistsSync;
  }

  assert(
    requiredMissing.includes('shutdown binary not found'),
    `expected missing shutdown binary to fail fast, got: ${requiredMissing || '<no error>'}`
  );

  fs.existsSync = () => false;
  let skipped = '';
  try {
    skipped = configTestHelpers.resolveShutdownBin();
  } finally {
    fs.existsSync = originalExistsSync;
  }
  assert(skipped === '', `expected optional shutdown resolution to return empty string, got: ${skipped}`);
}

async function testNaturalMonitorPausedWhilePendingHelper() {
  const pausedDue = monitorTestHelpers.reconcileNaturalDueMs({
    ipMonitorEnabled: true,
    hasPending: true,
    naturalDueMs: 1000,
    nowMs: 5000
  });
  assert(
    pausedDue === monitorTestHelpers.NEVER,
    `expected natural monitor to pause while pending, got ${pausedDue}`
  );

  const resumeDue = monitorTestHelpers.reconcileNaturalDueMs({
    ipMonitorEnabled: true,
    hasPending: false,
    naturalDueMs: monitorTestHelpers.NEVER,
    nowMs: 5000
  });
  assert(resumeDue === 5000, `expected natural monitor to resume immediately after pending clears, got ${resumeDue}`);
}

async function testIpv6MonitorErrorThrottleHelper() {
  const state = monitorTestHelpers.createIpv6LogState();
  const errors = [];
  const logs = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => errors.push(args.join(' '));
  console.log = (...args) => logs.push(args.join(' '));
  try {
    monitorTestHelpers.markIpv6MonitorFailure(state, 'probe-failed', 1000);
    monitorTestHelpers.markIpv6MonitorFailure(state, 'probe-failed', 2000);
    assert(errors.length === 1, `expected first ipv6 failure to log once, got ${errors.length}`);
    assert(state.suppressedErrorCount === 1, `expected one suppressed ipv6 error, got ${state.suppressedErrorCount}`);

    monitorTestHelpers.markIpv6MonitorFailure(state, 'probe-failed', 1000 + (5 * 60 * 1000) + 1);
    assert(errors.length === 2, `expected throttled ipv6 error to re-log after window, got ${errors.length}`);
    assert(errors[1].includes('suppressed 1 repeats'), `expected suppressed count in second log, got: ${errors[1]}`);

    monitorTestHelpers.markIpv6MonitorSuccess(state);
    assert(logs.some((line) => line.includes('ipv6 monitor recovered')), 'expected ipv6 recovery log');
    assert(state.failing === false, 'expected ipv6 failing state reset after recovery');
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

async function testIpv4MonitorErrorThrottleHelper() {
  const state = monitorTestHelpers.createMonitorLogState();
  const errors = [];
  const logs = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => errors.push(args.join(' '));
  console.log = (...args) => logs.push(args.join(' '));
  try {
    monitorTestHelpers.markMonitorFailure(state, 'ipv4', 'probe-failed', 1000);
    monitorTestHelpers.markMonitorFailure(state, 'ipv4', 'probe-failed', 2000);
    assert(errors.length === 1, `expected first ipv4 failure to log once, got ${errors.length}`);
    assert(state.suppressedErrorCount === 1, `expected one suppressed ipv4 error, got ${state.suppressedErrorCount}`);

    monitorTestHelpers.markMonitorFailure(
      state,
      'ipv4',
      'probe-failed',
      1000 + monitorTestHelpers.MONITOR_ERROR_LOG_THROTTLE_MS + 1
    );
    assert(errors.length === 2, `expected throttled ipv4 error to re-log after window, got ${errors.length}`);
    assert(errors[1].includes('suppressed 1 repeats'), `expected suppressed count in second log, got: ${errors[1]}`);

    monitorTestHelpers.markMonitorSuccess(state, 'ipv4');
    assert(logs.some((line) => line.includes('ipv4 monitor recovered')), 'expected ipv4 recovery log');
    assert(state.failing === false, 'expected ipv4 failing state reset after recovery');
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

async function testIpv6ConfigAndOpId() {
  const cfg = loadConfigFromEnv({
    AUTH_TOKEN: 'token',
    CHANGEIP_ENABLED: '0',
    IP_EVENTS_ENABLED: '1',
    IP_EVENTS_ENDPOINT: 'http://127.0.0.1/internal/ip-events',
    IP_EVENTS_TOKEN: 'events-token',
    IPV6_MONITOR_ENABLED: '1',
    IP_MONITOR_INTERVAL_SECONDS: '120'
  });
  assert(cfg.ipv6MonitorEnabled === true, 'expected IPV6_MONITOR_ENABLED=1 to enable ipv6 monitor');
  assert(cfg.ipMonitorIntervalSeconds === 120, `unexpected shared monitor interval: ${cfg.ipMonitorIntervalSeconds}`);
  assert(!Object.prototype.hasOwnProperty.call(cfg, 'ipv6MonitorIntervalSeconds'), 'ipv6 interval should reuse shared monitor interval');

  let invalidMessage = '';
  try {
    loadConfigFromEnv({
      AUTH_TOKEN: 'token',
      CHANGEIP_ENABLED: '0',
      IP_EVENTS_ENABLED: '1',
      IP_EVENTS_ENDPOINT: 'http://127.0.0.1/internal/ip-events',
      IP_EVENTS_TOKEN: 'events-token',
      IPV6_MONITOR_ENABLED: '1',
      IP_MONITOR_INTERVAL_SECONDS: '1'
    });
  } catch (err) {
    invalidMessage = String(err && err.message ? err.message : err);
  }
  assert(
    invalidMessage.includes('IP_MONITOR_INTERVAL_SECONDS'),
    `expected out-of-range shared interval to fail fast, got: ${invalidMessage || '<no error>'}`
  );

  const opId = makeIpv6OpId('HKT');
  assert(/_ipv6_[0-9a-f]{6}$/.test(opId), `unexpected ipv6 op_id format: ${opId}`);
}

async function testIpEventsContractValidation() {
  const okIpv4 = validateEventPayload({
    server_label: 'HKT',
    channel: '-1001234567890',
    op_id: '20260228T101500Z_hkt_ipv4_ab12cd',
    ts: '2026-02-28T10:15:00.000Z',
    contract_version: IP_EVENTS_CONTRACT_VERSION,
    event: IP_EVENT_TYPES.IPV4_CHANGED,
    old_ipv4: '1.2.3.4',
    new_ipv4: '5.6.7.8'
  });
  assert(okIpv4.ok, `expected ipv4_changed payload valid, got: ${okIpv4.error}`);

  const okWithDisabledChannel = validateEventPayload({
    server_label: 'HKT',
    channel: '',
    op_id: '20260228T101500Z_hkt_ipv4_bc23de',
    ts: '2026-02-28T10:15:00.000Z',
    contract_version: IP_EVENTS_CONTRACT_VERSION,
    event: IP_EVENT_TYPES.CHANGE_STARTED
  });
  assert(okWithDisabledChannel.ok, `expected empty channel to remain valid, got: ${okWithDisabledChannel.error}`);

  const missingChannel = validateEventPayload({
    server_label: 'HKT',
    op_id: '20260228T101500Z_hkt_ipv4_cd34ef',
    ts: '2026-02-28T10:15:00.000Z',
    contract_version: IP_EVENTS_CONTRACT_VERSION,
    event: IP_EVENT_TYPES.CHANGE_STARTED
  });
  assert(!missingChannel.ok, 'expected missing channel to be rejected');
  assert(
    String(missingChannel.error || '').includes('channel'),
    `expected missing channel error, got: ${missingChannel.error}`
  );

  const badChannel = validateEventPayload({
    server_label: 'HKT',
    channel: 'invalid-channel',
    op_id: '20260228T101500Z_hkt_ipv4_de45fa',
    ts: '2026-02-28T10:15:00.000Z',
    contract_version: IP_EVENTS_CONTRACT_VERSION,
    event: IP_EVENT_TYPES.CHANGE_STARTED
  });
  assert(!badChannel.ok, 'expected invalid channel to be rejected');
  assert(
    String(badChannel.error || '').includes('invalid channel'),
    `expected invalid channel error, got: ${badChannel.error}`
  );

  const missingIpv6 = validateEventPayload({
    server_label: 'HKT',
    channel: '-1001234567890',
    op_id: '20260228T101500Z_hkt_ipv6_ab12cd',
    ts: '2026-02-28T10:15:00.000Z',
    contract_version: IP_EVENTS_CONTRACT_VERSION,
    event: IP_EVENT_TYPES.IPV6_CHANGED,
    old_ipv6: '240e:3a1:1000::10'
  });
  assert(!missingIpv6.ok, 'expected ipv6_changed missing new_ipv6 to be invalid');
  assert(
    String(missingIpv6.error || '').includes('new_ipv6'),
    `expected missing field error to mention new_ipv6, got: ${missingIpv6.error}`
  );

  const missingCommon = validateEventPayload({
    channel: '-1001234567890',
    event: IP_EVENT_TYPES.CHANGE_STARTED
  });
  assert(!missingCommon.ok, 'expected missing server_label/op_id/ts/contract_version to be invalid');
  assert(
    String(missingCommon.error || '').includes('server_label'),
    `expected missing common field error, got: ${missingCommon.error}`
  );

  const badOpId = validateEventPayload({
    server_label: 'HKT',
    channel: '-1001234567890',
    op_id: 'bad op id',
    ts: '2026-02-28T10:15:00.000Z',
    contract_version: IP_EVENTS_CONTRACT_VERSION,
    event: IP_EVENT_TYPES.CHANGE_STARTED
  });
  assert(!badOpId.ok, 'expected invalid op_id format to be rejected');

  const badTs = validateEventPayload({
    server_label: 'HKT',
    channel: '-1001234567890',
    op_id: '20260228T101500Z_hkt_ipv4_ab12cd',
    ts: 'not-a-time',
    contract_version: IP_EVENTS_CONTRACT_VERSION,
    event: IP_EVENT_TYPES.CHANGE_STARTED
  });
  assert(!badTs.ok, 'expected invalid ts format to be rejected');

  const badContractVersion = validateEventPayload({
    server_label: 'HKT',
    channel: '-1001234567890',
    op_id: '20260228T101500Z_hkt_ipv4_ab12cd',
    ts: '2026-02-28T10:15:00.000Z',
    contract_version: '2025-01-01.v0',
    event: IP_EVENT_TYPES.CHANGE_STARTED
  });
  assert(!badContractVersion.ok, 'expected unsupported contract_version to be rejected');

  const unknown = validateEventPayload({
    server_label: 'HKT',
    channel: '-1001234567890',
    op_id: '20260228T101500Z_hkt_ipv4_ab12cd',
    ts: '2026-02-28T10:15:00.000Z',
    contract_version: IP_EVENTS_CONTRACT_VERSION,
    event: 'something_else'
  });
  assert(!unknown.ok, 'expected unknown event to be invalid');
}

async function testReportChannelConfigValidation() {
  const emptyChannel = loadConfigFromEnv({
    AUTH_TOKEN: 'token',
    REPORT_CHANNEL: ''
  });
  assert(emptyChannel.reportChannel === '', 'expected empty REPORT_CHANNEL to remain valid');

  const usernameChannel = loadConfigFromEnv({
    AUTH_TOKEN: 'token',
    REPORT_CHANNEL: ' @abcde '
  });
  assert(usernameChannel.reportChannel === '@abcde', `expected trimmed REPORT_CHANNEL, got ${usernameChannel.reportChannel}`);

  let message = '';
  try {
    loadConfigFromEnv({
      AUTH_TOKEN: 'token',
      REPORT_CHANNEL: 'invalid-channel'
    });
  } catch (err) {
    message = String(err && err.message ? err.message : err);
  }
  assert(message.includes('REPORT_CHANNEL'), `expected invalid REPORT_CHANNEL to fail fast, got: ${message || '<no error>'}`);
}

async function testIpqualityConfigValidation() {
  let missingPathMessage = '';
  try {
    loadConfigFromEnv({
      AUTH_TOKEN: 'token',
      IPQUALITY_ENABLED: '1'
    });
  } catch (err) {
    missingPathMessage = String(err && err.message ? err.message : err);
  }
  assert(
    missingPathMessage.includes('IPQUALITY_SCRIPT_PATH'),
    `expected missing IPQUALITY_SCRIPT_PATH to fail fast, got: ${missingPathMessage || '<no error>'}`
  );

  const cfg = loadConfigFromEnv({
    AUTH_TOKEN: 'token',
    IPQUALITY_ENABLED: '1',
    IPQUALITY_SCRIPT_PATH: '/root/IPQuality/ip.sh',
    IPQUALITY_TIMEOUT_SECONDS: '900'
  });
  assert(cfg.ipqualityEnabled === true, 'expected IPQUALITY_ENABLED=1 to enable ipquality');
  assert(cfg.ipqualityScriptPath === '/root/IPQuality/ip.sh', `unexpected ipquality script path: ${cfg.ipqualityScriptPath}`);
  assert(cfg.ipqualityTimeoutSeconds === 900, `unexpected ipquality timeout: ${cfg.ipqualityTimeoutSeconds}`);
}

async function testIpqualityRunnerHelpers() {
  const runId = makeIpQualityRunId('HKT');
  assert(/_ipquality_[0-9a-f]{6}$/.test(runId), `unexpected ipquality run_id format: ${runId}`);

  const noisyOutput = '\u001b[32m报告链接: https://Report.Check.Place/ip/ABC123.svg\u001b[0m\r\n';
  const reportUrl = ipqualityRunnerTestHelpers.extractReportUrl(noisyOutput);
  assert(
    reportUrl === 'https://Report.Check.Place/ip/ABC123.svg',
    `expected report url extracted from ANSI output, got: ${reportUrl}`
  );
  assert(
    ipqualityRunnerTestHelpers.extractReportUrl('报告链接: http://Report.Check.Place/ip/NOT_ALLOWED.svg') === '',
    'expected non-HTTPS ipquality report url to be ignored'
  );

  const excerpt = ipqualityRunnerTestHelpers.buildOutputExcerpt(`${'x'.repeat(2000)}\n${noisyOutput}`);
  assert(excerpt.includes('https://Report.Check.Place/ip/ABC123.svg'), 'expected output excerpt to preserve report url');

  const nonZeroWithReport = ipqualityRunnerTestHelpers.interpretIpqualityScriptResult({
    code: 1,
    signal: null,
    timedOut: false,
    outputText: noisyOutput,
    timeoutSeconds: 600
  });
  assert(
    nonZeroWithReport.ok && nonZeroWithReport.reportUrl === 'https://Report.Check.Place/ip/ABC123.svg',
    `expected report url to win over non-zero exit code, got: ${JSON.stringify(nonZeroWithReport)}`
  );

  const nonZeroWithoutReport = ipqualityRunnerTestHelpers.interpretIpqualityScriptResult({
    code: 1,
    signal: null,
    timedOut: false,
    outputText: 'no report',
    timeoutSeconds: 600
  });
  assert(
    !nonZeroWithoutReport.ok && nonZeroWithoutReport.error === 'ipquality script exited with exit code 1',
    `expected non-zero exit code failure when report url is absent, got: ${JSON.stringify(nonZeroWithoutReport)}`
  );
}

async function testCompileRejectsNonIntegerSuffix(tmpRoot) {
  const flow = {
    base_url: 'https://example.com',
    timeout_ms: '1000ms',
    steps: [
      {
        type: 'request',
        method: 'GET',
        url: '/status'
      }
    ]
  };

  const filePath = path.join(tmpRoot, 'quick.strict_int_rejects_suffix.json');
  fs.writeFileSync(filePath, JSON.stringify(flow), 'utf8');
  const compiled = compileFlowFromFile(filePath, process.env);
  assert(!compiled.ok, 'expected compile to fail when timeout_ms is not a strict integer');
  assert(
    String(compiled.error || '').includes('timeout_ms must be an integer'),
    `expected strict integer error, got: ${compiled.error}`
  );
}

async function testCompileRejectsNonBooleanFields(tmpRoot) {
  function compileWith(name, flow) {
    const filePath = path.join(tmpRoot, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(flow), 'utf8');
    return compileFlowFromFile(filePath, process.env);
  }

  const topLevel = compileWith('quick.strict_bool_top_level', {
    follow_redirects: 'false',
    steps: [
      {
        type: 'request',
        method: 'GET',
        url: 'https://example.com'
      }
    ]
  });
  assert(!topLevel.ok, 'expected compile to fail when top-level follow_redirects is not a boolean');
  assert(
    String(topLevel.error || '').includes('follow_redirects must be a boolean'),
    `expected top-level boolean error, got: ${topLevel.error}`
  );

  const requestStep = compileWith('quick.strict_bool_request_step', {
    steps: [
      {
        type: 'request',
        method: 'GET',
        url: 'https://example.com',
        allow_network_error: 'true'
      }
    ]
  });
  assert(!requestStep.ok, 'expected compile to fail when allow_network_error is not a boolean');
  assert(
    String(requestStep.error || '').includes('allow_network_error must be a boolean'),
    `expected request-step boolean error, got: ${requestStep.error}`
  );

  const assertStep = compileWith('quick.strict_bool_assert_step', {
    steps: [
      {
        type: 'request',
        method: 'GET',
        url: 'https://example.com'
      },
      {
        type: 'assert',
        from: 'status',
        exists: 'true'
      }
    ]
  });
  assert(!assertStep.ok, 'expected compile to fail when assert.exists is not a boolean');
  assert(
    String(assertStep.error || '').includes('exists must be a boolean'),
    `expected assert-step boolean error, got: ${assertStep.error}`
  );
}

async function testPublicIpv4OverrideGuardHelper() {
  const disallowed = ipv4TestHelpers.resolveIpv4Override({
    env: { PUBLIC_IPV4_OVERRIDE: '198.51.100.20' }
  });
  assert(disallowed === '', `expected override ignored when ALLOW_PUBLIC_IPV4_OVERRIDE is not enabled, got ${disallowed}`);

  const allowed = ipv4TestHelpers.resolveIpv4Override({
    env: {
      ALLOW_PUBLIC_IPV4_OVERRIDE: '1',
      PUBLIC_IPV4_OVERRIDE: '198.51.100.20'
    }
  });
  assert(allowed === '198.51.100.20', `expected allowed override to pass through, got ${allowed}`);

  let invalidThrown = false;
  try {
    ipv4TestHelpers.resolveIpv4Override({
      env: {
        ALLOW_PUBLIC_IPV4_OVERRIDE: '1',
        PUBLIC_IPV4_OVERRIDE: 'not-an-ip'
      }
    });
  } catch (err) {
    invalidThrown = String(err || '').includes('public_ipv4_override_invalid');
  }
  assert(invalidThrown, 'expected invalid PUBLIC_IPV4_OVERRIDE to throw when override is enabled');
}

const QUICK_CASES = [
  {
    title: 'monitor computes pending retry due with interval backoff after timeout',
    run: testPendingTimeoutRetryBackoffHelper
  },
  {
    title: 'pending timeout-stuck alert is throttled per session',
    run: testPendingTimeoutStuckAlertThrottleHelper
  },
  {
    title: 'monitor pauses natural scheduling while pending session exists',
    run: testNaturalMonitorPausedWhilePendingHelper
  },
  {
    title: 'ipv6 monitor errors are throttled and recovery is logged once',
    run: testIpv6MonitorErrorThrottleHelper
  },
  {
    title: 'ipv4 monitor errors are throttled and recovery is logged once',
    run: testIpv4MonitorErrorThrottleHelper
  },
  {
    title: 'ipv6 monitor reuses shared interval, but invalid interval config fails fast',
    run: testIpv6ConfigAndOpId
  },
  {
    title: 'ip events contract validates required fields by event type',
    run: testIpEventsContractValidation
  },
  {
    title: 'REPORT_CHANNEL is validated at config load time',
    run: testReportChannelConfigValidation
  },
  {
    title: 'ipquality config requires script path and respects timeout overrides',
    run: testIpqualityConfigValidation
  },
  {
    title: 'ipquality helper logic extracts report url from sanitized output',
    run: testIpqualityRunnerHelpers
  },
  {
    title: 'reboot-enabled config fails fast when shutdown binary is unavailable',
    run: testShutdownBinaryConfigFailsFastStable
  },
  {
    title: 'http_flow compile rejects integer fields with non-numeric suffix',
    run: testCompileRejectsNonIntegerSuffix
  },
  {
    title: 'http_flow compile rejects non-boolean fields for boolean options',
    run: testCompileRejectsNonBooleanFields
  },
  {
    title: 'PUBLIC_IPV4_OVERRIDE requires explicit allow flag',
    run: testPublicIpv4OverrideGuardHelper
  },
  {
    title: 'wait_until enforces hard timeout when request exceeds deadline',
    run: testWaitUntilHardTimeout
  },
  {
    title: 'request retries eventually succeed within configured retries',
    run: testRequestRetriesConverge
  },
  {
    title: 'request retries honor Retry-After header on 429',
    run: testRetryAfterHonored
  },
  {
    title: 'http_flow request enforces response body size guard',
    run: testHttpFlowResponseSizeGuard
  },
  {
    title: 'network http client enforces response body size guard',
    run: testNetworkHttpResponseSizeGuard
  },
  {
    title: 'network http client fails fast on truncated early-close response',
    run: testNetworkHttpEarlyClose
  },
  {
    title: 'http_flow request fails fast on truncated early-close response',
    run: testHttpFlowEarlyClose
  },
  {
    title: 'ip-events terminal events use short retry while natural events remain single-attempt',
    run: testIpEventsTerminalShortRetry
  },
  {
    title: 'natural ipv4 change retries reuse op_id for idempotency',
    run: testNaturalIpv4RetriesReuseOpId
  },
  {
    title: 'change session creation surfaces pending state persist failure',
    run: testStartChangeSessionReportsPersistFailure
  }
];

module.exports = {
  QUICK_CASES
};
