'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const {
  assert,
  buildEnv,
  getFreePort,
  makeCaseFiles,
  postChangeIp,
  postInfo,
  runWithServer,
  sleep,
  startEventSink,
  startHttpFlowMockPanel,
  startHttpFlowResilienceMock,
  startHttpFlowRetryAfterMock,
  startIpChangerExpectConfigError,
  waitUntil,
  writeShellScript
} = require('./harness');

const TERMINAL_EVENT_SET = new Set(['change_succeeded', 'change_no_change', 'change_failed']);

function writeTimedOutPendingSession(pendingFile, {
  opId = '20260228T101500Z_regression_ipv4_ab12cd',
  oldIpv4 = '1.2.3.4'
} = {}) {
  const nowMs = Date.now();
  const pending = {
    op_id: opId,
    server_label: 'REGRESSION',
    channel: '',
    old_ipv4: oldIpv4,
    provider_started: true,
    provider_failed_reason: '',
    started_at: new Date(nowMs - 120_000).toISOString(),
    reboot_delay_minutes: -1,
    started_sent: true,
    monitor_after_ms: nowMs - 90_000,
    timeout_at_ms: nowMs - 60_000,
    timeout_stuck_alert_next_at_ms: 0,
    timeout_stuck_alert_count: 0,
    timeout_stuck_alert_last_at: '',
    timeout_stuck_alert_last_reason: '',
    last_error: ''
  };
  fs.writeFileSync(pendingFile, JSON.stringify(pending), 'utf8');
}

async function startRejectingEventSink({ statusCode = 500 } = {}) {
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

      res.statusCode = statusCode;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end('{"ok":false}');
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

async function startFlakyEventSink({ failCount = 1, failStatusCode = 500 } = {}) {
  const events = [];
  let requestCount = 0;
  const normalizedFailCount = Math.max(0, Number(failCount) || 0);
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

      requestCount += 1;
      if (requestCount <= normalizedFailCount) {
        res.statusCode = failStatusCode;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end('{"ok":false}');
        return;
      }

      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end('{"ok":true}');
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

async function testConcurrentOnlyOneAccepted(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'concurrent');
  const scriptPath = path.join(files.dir, 'slow_success.sh');
  writeShellScript(scriptPath, 'sleep 3\nexit 0');

  const port = await getFreePort();
  const env = buildEnv({
    port,
    provider: 'script',
    endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
    scriptPath,
    stateFile: files.stateFile,
    pendingFile: files.pendingFile
  });

  await runWithServer(env, async () => {
    const reqs = Array.from({ length: 6 }, () => postChangeIp(port));
    const results = await Promise.all(reqs);
    const okCount = results.filter((r) => r.status === 200).length;
    const conflictCount = results.filter((r) => r.status === 409).length;
    assert(okCount === 1, `expected exactly one 200, got ${okCount}`);
    assert(conflictCount === 5, `expected five 409, got ${conflictCount}`);
  });
}

async function testRejectRelativeScriptPath(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'relative_path');
  const port = await getFreePort();
  const env = buildEnv({
    port,
    provider: 'script',
    endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
    scriptPath: 'relative.sh',
    stateFile: files.stateFile,
    pendingFile: files.pendingFile
  });

  await runWithServer(env, async () => {
    const resp = await postChangeIp(port);
    assert(resp.status === 500, `expected 500, got ${resp.status}`);
    assert(resp.json?.error === 'changeip script path must be absolute', `unexpected error: ${resp.text}`);
    assert(resp.json?.provider_error_code === 'provider.config_invalid', `unexpected error code: ${resp.text}`);
  });
}

async function testRejectNonRegularFile(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'not_regular_file');
  const notFilePath = path.join(files.dir, 'script_dir');
  fs.mkdirSync(notFilePath, { recursive: true });

  const port = await getFreePort();
  const env = buildEnv({
    port,
    provider: 'script',
    endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
    scriptPath: notFilePath,
    stateFile: files.stateFile,
    pendingFile: files.pendingFile
  });

  await runWithServer(env, async () => {
    const resp = await postChangeIp(port);
    assert(resp.status === 500, `expected 500, got ${resp.status}`);
    assert(resp.json?.error === 'changeip script is not a regular file', `unexpected error: ${resp.text}`);
    assert(resp.json?.provider_error_code === 'provider.config_invalid', `unexpected error code: ${resp.text}`);
  });
}

async function testFailFastScriptDoesNotLeavePending(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'fail_fast');
  const scriptPath = path.join(files.dir, 'fail_fast.sh');
  writeShellScript(scriptPath, 'exit 2');

  const port = await getFreePort();
  const env = buildEnv({
    port,
    provider: 'script',
    endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
    scriptPath,
    stateFile: files.stateFile,
    pendingFile: files.pendingFile
  });

  await runWithServer(env, async () => {
    const beforeEvents = sink.events.length;
    const resp = await postChangeIp(port);
    assert(resp.status === 500, `expected 500, got ${resp.status}`);
    assert(resp.json?.error === 'changeip script exited early', `unexpected error: ${resp.text}`);
    assert(resp.json?.provider_error_code === 'provider.exited_early', `unexpected error code: ${resp.text}`);

    await sleep(250);
    assert(!fs.existsSync(files.pendingFile), 'pending_change.json should be cleared after fail-fast');

    const next = await postChangeIp(port);
    assert(next.status === 500, `expected second call 500, got ${next.status}`);
    assert(next.json?.error === 'changeip script exited early', `unexpected second error: ${next.text}`);
    assert(next.json?.provider_error_code === 'provider.exited_early', `unexpected second error code: ${next.text}`);

    const newEvents = sink.events.slice(beforeEvents);
    const failed = newEvents.filter((e) => e.body?.event === 'change_failed' && e.body?.reason === 'script_exited_early');
    assert(failed.length >= 1, 'expected change_failed(script_exited_early) event');
    const failedOpIds = new Set(failed.map((e) => String(e.body?.op_id || '')).filter(Boolean));
    const started = newEvents.filter((e) => (
      e.body?.event === 'change_started' &&
      failedOpIds.has(String(e.body?.op_id || ''))
    ));
    assert(started.length === 0, 'fail-fast script should not emit change_started');
  });
}

async function testFailFastScriptRetriesFailedTerminalReport(tmpRoot, _sink) {
  const files = makeCaseFiles(tmpRoot, 'fail_fast_retry_terminal_report');
  const scriptPath = path.join(files.dir, 'fail_fast.sh');
  writeShellScript(scriptPath, 'exit 2');

  const flakySink = await startFlakyEventSink({ failCount: 10, failStatusCode: 500 });
  const port = await getFreePort();
  const env = {
    ...buildEnv({
      port,
      provider: 'script',
      endpoint: `http://127.0.0.1:${flakySink.port}/internal/ip-events`,
      scriptPath,
      stateFile: files.stateFile,
      pendingFile: files.pendingFile
    }),
    CHANGE_MONITOR_START_DELAY_SECONDS: '0',
    CHANGE_MONITOR_INTERVAL_SECONDS: '1'
  };

  try {
    await runWithServer(env, async () => {
      const resp = await postChangeIp(port);
      assert(resp.status === 500, `expected 500, got ${resp.status}`);
      assert(resp.json?.error === 'changeip script exited early', `unexpected error: ${resp.text}`);
      assert(resp.json?.provider_error_code === 'provider.exited_early', `unexpected error code: ${resp.text}`);

      await sleep(250);
      assert(
        fs.existsSync(files.pendingFile),
        'pending_change.json should remain when initial change_failed report is rejected'
      );

      const pending = JSON.parse(fs.readFileSync(files.pendingFile, 'utf8'));
      const opId = String(pending.op_id || '');
      assert(opId, 'expected pending session op_id');
      assert(pending.provider_started === false, 'expected provider_started=false for fail-fast session');
      assert(
        pending.provider_failed_reason === 'script_exited_early',
        `expected provider_failed_reason=script_exited_early, got ${pending.provider_failed_reason}`
      );

      const conflict = await postChangeIp(port);
      assert(conflict.status === 409, `expected 409 while failed terminal report is pending, got ${conflict.status}`);

      await waitUntil(() => {
        const failed = flakySink.events.filter((e) => (
          e.body?.event === 'change_failed' &&
          String(e.body?.op_id || '') === opId &&
          e.body?.reason === 'script_exited_early'
        ));
        return failed.length >= 2;
      }, {
        timeoutMs: 20000,
        intervalMs: 150,
        label: 'expected monitor to retry change_failed after initial rejection'
      });

      await waitUntil(() => !fs.existsSync(files.pendingFile), {
        timeoutMs: 20000,
        intervalMs: 150,
        label: 'expected pending session to clear after retrying change_failed'
      });
    });
  } finally {
    await flakySink.close();
  }
}

async function testInvalidPendingSchemaIsCleared(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'invalid_pending_schema_cleared');
  const nowMs = Date.now();
  const opId = '20260301T010203Z_regression_ipv4_deadbe';
  const invalidPending = {
    op_id: opId,
    server_label: 'REGRESSION',
    channel: '',
    old_ipv4: '1.2.3.4',
    started_at: new Date(nowMs - 20_000).toISOString(),
    reboot_delay_minutes: -1,
    started_sent: true,
    monitor_after_ms: nowMs - 10_000,
    timeout_at_ms: nowMs + 120_000,
    last_error: ''
  };
  fs.writeFileSync(files.pendingFile, JSON.stringify(invalidPending), 'utf8');
  const beforeEvents = sink.events.length;

  const port = await getFreePort();
  const env = {
    ...buildEnv({
      port,
      provider: 'exec',
      endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
      execCommand: 'sleep 1; exit 0',
      stateFile: files.stateFile,
      pendingFile: files.pendingFile
    }),
    CHANGE_MONITOR_INTERVAL_SECONDS: '1'
  };

  await runWithServer(env, async () => {
    await waitUntil(() => !fs.existsSync(files.pendingFile), {
      timeoutMs: 6000,
      intervalMs: 150,
      label: 'expected invalid pending schema to be cleared'
    });

    const newEvents = sink.events.slice(beforeEvents);
    const failed = newEvents.filter((e) => (
      e.body?.event === 'change_failed' &&
      String(e.body?.op_id || '') === opId &&
      e.body?.reason === 'invalid_pending_schema'
    ));
    assert(failed.length >= 1, 'expected invalid pending schema to emit change_failed before cleanup');

    const resp = await postChangeIp(port);
    assert(resp.status === 200, `expected 200 after invalid pending cleared, got ${resp.status}`);
  });
}

async function testInvalidPendingMissingOpIdIsClearedWhenChangeipDisabled(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'invalid_pending_missing_op_id_cleared');
  const nowMs = Date.now();
  const invalidPending = {
    server_label: 'REGRESSION',
    channel: '',
    old_ipv4: '1.2.3.4',
    provider_started: true,
    provider_failed_reason: '',
    started_at: new Date(nowMs - 20_000).toISOString(),
    reboot_delay_minutes: -1,
    started_sent: true,
    monitor_after_ms: nowMs - 10_000,
    timeout_at_ms: nowMs + 120_000,
    last_error: ''
  };
  fs.writeFileSync(files.pendingFile, JSON.stringify(invalidPending), 'utf8');
  const beforeEvents = sink.events.length;

  const port = await getFreePort();
  const env = {
    ...buildEnv({
      port,
      provider: 'exec',
      endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
      execCommand: 'sleep 1; exit 0',
      stateFile: files.stateFile,
      pendingFile: files.pendingFile
    }),
    CHANGEIP_ENABLED: '0',
    CHANGE_MONITOR_INTERVAL_SECONDS: '1'
  };

  await runWithServer(env, async () => {
    await waitUntil(() => !fs.existsSync(files.pendingFile), {
      timeoutMs: 6000,
      intervalMs: 150,
      label: 'expected invalid pending without op_id to be cleared'
    });

    const newEvents = sink.events.slice(beforeEvents);
    const terminal = newEvents.filter((e) => String(e.body?.event || '') === 'change_failed');
    assert(
      terminal.length === 0,
      'missing op_id pending session should clear directly without emitting invalid change_failed payload'
    );

    const info = await postInfo(port);
    assert(info.status === 200, `expected /info=200, got ${info.status}`);
    assert(info.json?.changeip_enabled === false, `expected changeip_enabled=false, got: ${info.text}`);
  });
}

async function testExecProviderOnlyOneAccepted(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'exec_concurrent');
  const port = await getFreePort();
  const env = buildEnv({
    port,
    provider: 'exec',
    endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
    execCommand: 'sleep 3; exit 0',
    stateFile: files.stateFile,
    pendingFile: files.pendingFile
  });

  await runWithServer(env, async () => {
    const reqs = Array.from({ length: 5 }, () => postChangeIp(port));
    const results = await Promise.all(reqs);
    const okCount = results.filter((r) => r.status === 200).length;
    const conflictCount = results.filter((r) => r.status === 409).length;
    assert(okCount === 1, `expected exactly one 200 for exec provider, got ${okCount}`);
    assert(conflictCount === 4, `expected four 409 for exec provider, got ${conflictCount}`);
  });
}

async function testFailFastExecDoesNotLeavePending(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'exec_fail_fast');
  const port = await getFreePort();
  const env = buildEnv({
    port,
    provider: 'exec',
    endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
    execCommand: 'exit 2',
    stateFile: files.stateFile,
    pendingFile: files.pendingFile
  });

  await runWithServer(env, async () => {
    const beforeEvents = sink.events.length;
    const resp = await postChangeIp(port);
    assert(resp.status === 500, `expected 500, got ${resp.status}`);
    assert(resp.json?.error === 'changeip exec command exited early', `unexpected error: ${resp.text}`);
    assert(resp.json?.provider_error_code === 'provider.exited_early', `unexpected error code: ${resp.text}`);

    await sleep(250);
    assert(!fs.existsSync(files.pendingFile), 'pending_change.json should be cleared after exec fail-fast');

    const next = await postChangeIp(port);
    assert(next.status === 500, `expected second call 500, got ${next.status}`);
    assert(next.json?.error === 'changeip exec command exited early', `unexpected second error: ${next.text}`);
    assert(next.json?.provider_error_code === 'provider.exited_early', `unexpected second error code: ${next.text}`);

    const newEvents = sink.events.slice(beforeEvents);
    const failed = newEvents.filter((e) => e.body?.event === 'change_failed' && e.body?.reason === 'exec_exited_early');
    assert(failed.length >= 1, 'expected change_failed(exec_exited_early) event');
    const failedOpIds = new Set(failed.map((e) => String(e.body?.op_id || '')).filter(Boolean));
    const started = newEvents.filter((e) => (
      e.body?.event === 'change_started' &&
      failedOpIds.has(String(e.body?.op_id || ''))
    ));
    assert(started.length === 0, 'fail-fast exec should not emit change_started');
  });
}

async function testHttpFlowProviderHappyPath(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'http_flow_success');
  const panel = await startHttpFlowMockPanel();
  const flowFile = path.join(files.dir, 'flow.json');
  const flow = {
    base_url: `http://127.0.0.1:${panel.port}`,
    timeout_ms: 4000,
    max_redirects: 5,
    vars: {
      username: '${ENV:FLOW_TEST_USER}',
      password: '${ENV:FLOW_TEST_PASS}'
    },
    steps: [
      {
        type: 'request',
        name: 'open_login',
        method: 'GET',
        url: '/login',
        expect_status: 200
      },
      {
        type: 'extract',
        name: 'csrf',
        from: 'body',
        regex: 'name="_token" value="([^"]+)"',
        to: 'csrf'
      },
      {
        type: 'request',
        name: 'submit_login',
        method: 'POST',
        url: '/login',
        form: {
          username: '${username}',
          password: '${password}',
          _token: '${csrf}'
        },
        expect_status: 200
      },
      {
        type: 'request',
        name: 'trigger_change',
        method: 'POST',
        url: '/api/change-ip',
        form: {
          action: 'change'
        },
        expect_status: 200
      },
      {
        type: 'assert',
        name: 'change_ack',
        from: 'body',
        includes: '"ok":true'
      }
    ]
  };
  fs.writeFileSync(flowFile, JSON.stringify(flow), 'utf8');

  const port = await getFreePort();
  const env = {
    ...buildEnv({
      port,
      provider: 'http_flow',
      endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
      httpFlowFile: flowFile,
      stateFile: files.stateFile,
      pendingFile: files.pendingFile
    }),
    FLOW_TEST_USER: 'demo-user',
    FLOW_TEST_PASS: 'demo-pass'
  };

  try {
    await runWithServer(env, async () => {
      const resp = await postChangeIp(port);
      assert(resp.status === 200, `expected 200, got ${resp.status}`);
      assert(resp.json?.changeip_provider === 'http_flow', `unexpected response: ${resp.text}`);

      await waitUntil(async () => {
        const sequence = panel.calls.map((c) => `${c.method} ${c.url}`).join('|');
        return sequence === 'GET /login|POST /login|GET /panel|POST /api/change-ip';
      }, {
        timeoutMs: 5000,
        intervalMs: 80,
        label: 'http_flow happy path did not finish in time'
      });

      const sequence = panel.calls.map((c) => `${c.method} ${c.url}`).join('|');
      assert(
        sequence === 'GET /login|POST /login|GET /panel|POST /api/change-ip',
        `unexpected panel call sequence: ${sequence}`
      );

      const changeCall = panel.calls.find((c) => c.method === 'POST' && c.url === '/api/change-ip');
      assert(!!changeCall, 'missing POST /api/change-ip call');
      assert(
        String(changeCall.headers.cookie || '').includes('auth=1'),
        'expected auth cookie on change-ip request'
      );
    });
  } finally {
    await panel.close();
  }
}

async function testHttpFlowProviderAllowsNetworkErrorOnFinalStep(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'http_flow_allow_network_error');
  const panel = await startHttpFlowMockPanel({ dropOnChange: true });
  const flowFile = path.join(files.dir, 'flow.allow-network-error.json');
  const flow = {
    base_url: `http://127.0.0.1:${panel.port}`,
    timeout_ms: 4000,
    max_redirects: 5,
    vars: {
      username: '${ENV:FLOW_TEST_USER}',
      password: '${ENV:FLOW_TEST_PASS}'
    },
    steps: [
      {
        type: 'request',
        name: 'open_login',
        method: 'GET',
        url: '/login',
        expect_status: 200
      },
      {
        type: 'extract',
        name: 'csrf',
        from: 'body',
        regex: 'name="_token" value="([^"]+)"',
        to: 'csrf'
      },
      {
        type: 'request',
        name: 'submit_login',
        method: 'POST',
        url: '/login',
        form: {
          username: '${username}',
          password: '${password}',
          _token: '${csrf}'
        },
        expect_status: 200
      },
      {
        type: 'request',
        name: 'trigger_change',
        method: 'POST',
        url: '/api/change-ip',
        form: {
          action: 'change'
        },
        allow_network_error: true,
        expect_status: 200
      }
    ]
  };
  fs.writeFileSync(flowFile, JSON.stringify(flow), 'utf8');

  const port = await getFreePort();
  const env = {
    ...buildEnv({
      port,
      provider: 'http_flow',
      endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
      httpFlowFile: flowFile,
      stateFile: files.stateFile,
      pendingFile: files.pendingFile
    }),
    FLOW_TEST_USER: 'demo-user',
    FLOW_TEST_PASS: 'demo-pass'
  };

  try {
    await runWithServer(env, async () => {
      const resp = await postChangeIp(port);
      assert(resp.status === 200, `expected 200, got ${resp.status}`);
      assert(resp.json?.changeip_provider === 'http_flow', `unexpected response: ${resp.text}`);

      await waitUntil(async () => {
        const changeCall = panel.calls.find((c) => c.method === 'POST' && c.url === '/api/change-ip');
        return !!changeCall;
      }, {
        timeoutMs: 4000,
        intervalMs: 80,
        label: 'missing POST /api/change-ip call'
      });

      const changeCall = panel.calls.find((c) => c.method === 'POST' && c.url === '/api/change-ip');
      assert(!!changeCall, 'missing POST /api/change-ip call');
    });
  } finally {
    await panel.close();
  }
}

async function testHttpFlowRequestRetriesAndWaitUntil(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'http_flow_retries_wait_until');
  const mock = await startHttpFlowResilienceMock({
    retryFailCount: 2,
    progressReadyAfter: 3
  });
  const flowFile = path.join(files.dir, 'flow.retries-wait-until.json');
  const flow = {
    base_url: `http://127.0.0.1:${mock.port}`,
    timeout_ms: 3000,
    max_redirects: 2,
    steps: [
      {
        type: 'request',
        name: 'retry_until_ok',
        method: 'POST',
        url: '/retry-ready',
        json: {},
        retries: 3,
        retry_delay_ms: 50,
        expect_status: 200
      },
      {
        type: 'wait_until',
        name: 'wait_progress_ready',
        timeout_ms: 2000,
        interval_ms: 50,
        request: {
          method: 'POST',
          url: '/progress',
          json: {},
          expect_status: 200
        },
        assert: {
          from: 'body',
          includes: '"state":"ready"'
        }
      }
    ]
  };
  fs.writeFileSync(flowFile, JSON.stringify(flow), 'utf8');

  const port = await getFreePort();
  const env = buildEnv({
    port,
    provider: 'http_flow',
    endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
    httpFlowFile: flowFile,
    stateFile: files.stateFile,
    pendingFile: files.pendingFile
  });

  try {
    await runWithServer(env, async () => {
      const resp = await postChangeIp(port);
      assert(resp.status === 200, `expected 200, got ${resp.status}`);
      assert(resp.json?.changeip_provider === 'http_flow', `unexpected response: ${resp.text}`);

      await waitUntil(async () => {
        return mock.calls.retryReady === 3 && mock.calls.progress >= 3;
      }, {
        timeoutMs: 5000,
        intervalMs: 60,
        label: 'http_flow retries/wait_until did not converge in time'
      });

      assert(mock.calls.retryReady === 3, `expected 3 retry-ready calls, got ${mock.calls.retryReady}`);
      assert(mock.calls.progress >= 3, `expected progress polling >= 3, got ${mock.calls.progress}`);
    });
  } finally {
    await mock.close();
  }
}

async function testHttpFlowRetriesHonorRetryAfterOn429(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'http_flow_retry_after_429');
  const mock = await startHttpFlowRetryAfterMock({
    retryAfterSeconds: 1,
    failCount: 1
  });
  const flowFile = path.join(files.dir, 'flow.retry-after.json');
  const flow = {
    base_url: `http://127.0.0.1:${mock.port}`,
    timeout_ms: 3000,
    max_redirects: 2,
    steps: [
      {
        type: 'request',
        name: 'retry_after_step',
        method: 'POST',
        url: '/retry-after',
        json: {},
        retries: 2,
        retry_delay_ms: 50,
        expect_status: 200
      }
    ]
  };
  fs.writeFileSync(flowFile, JSON.stringify(flow), 'utf8');

  const port = await getFreePort();
  const env = buildEnv({
    port,
    provider: 'http_flow',
    endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
    httpFlowFile: flowFile,
    stateFile: files.stateFile,
    pendingFile: files.pendingFile
  });

  try {
    await runWithServer(env, async () => {
      const resp = await postChangeIp(port);
      assert(resp.status === 200, `expected 200, got ${resp.status}`);
      assert(resp.json?.changeip_provider === 'http_flow', `unexpected response: ${resp.text}`);

      await waitUntil(async () => {
        return mock.calls.total === 2 && mock.calls.firstSuccessAt > 0;
      }, {
        timeoutMs: 5000,
        intervalMs: 80,
        label: 'http_flow retry-after flow did not finish in time'
      });

      assert(mock.calls.total === 2, `expected 2 calls, got ${mock.calls.total}`);
      assert(
        mock.calls.firstSuccessAt - mock.calls.firstLimitedAt >= 800,
        `expected server-side gap >= 800ms, got ${mock.calls.firstSuccessAt - mock.calls.firstLimitedAt}ms`
      );
    });
  } finally {
    await mock.close();
  }
}

async function testHttpFlowProviderRejectsUnknownVar(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'http_flow_invalid_unknown_var');
  const flowFile = path.join(files.dir, 'flow.invalid.json');
  const flow = {
    steps: [
      {
        type: 'request',
        name: 'bad_request',
        method: 'GET',
        url: 'http://127.0.0.1:65535/${missing_var}',
        expect_status: 200
      }
    ]
  };
  fs.writeFileSync(flowFile, JSON.stringify(flow), 'utf8');

  const port = await getFreePort();
  const env = buildEnv({
    port,
    provider: 'http_flow',
    endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
    httpFlowFile: flowFile,
    stateFile: files.stateFile,
    pendingFile: files.pendingFile
  });

  await runWithServer(env, async () => {
    const resp = await postChangeIp(port);
    assert(resp.status === 500, `expected 500, got ${resp.status}`);
    assert(
      String(resp.json?.error || '').includes('unknown var: missing_var'),
      `unexpected compile error: ${resp.text}`
    );
    assert(resp.json?.provider_error_code === 'provider.config_invalid', `unexpected error code: ${resp.text}`);
  });
}

async function testRequireProviderWhenChangeipEnabled(tmpRoot, sink) {
  const files = makeCaseFiles(tmpRoot, 'missing_provider');
  const scriptPath = path.join(files.dir, 'noop.sh');
  writeShellScript(scriptPath, 'exit 0');

  const port = await getFreePort();
  const env = buildEnv({
    port,
    provider: 'script',
    endpoint: `http://127.0.0.1:${sink.port}/internal/ip-events`,
    scriptPath,
    stateFile: files.stateFile,
    pendingFile: files.pendingFile
  });
  delete env.CHANGEIP_PROVIDER;

  await startIpChangerExpectConfigError(env, 'CHANGEIP_PROVIDER is required when CHANGEIP_ENABLED=1');
}

async function testTimedOutPendingSessionReportsStuckAlertOnIpEvent500(tmpRoot, _sink) {
  const files = makeCaseFiles(tmpRoot, 'pending_timeout_ip_event_500');
  writeTimedOutPendingSession(files.pendingFile);
  const rejectingSink = await startRejectingEventSink({ statusCode: 500 });

  const port = await getFreePort();
  const env = {
    ...buildEnv({
      port,
      provider: 'exec',
      endpoint: `http://127.0.0.1:${rejectingSink.port}/internal/ip-events`,
      execCommand: 'sleep 3; exit 0',
      stateFile: files.stateFile,
      pendingFile: files.pendingFile
    }),
    CHANGE_MONITOR_START_DELAY_SECONDS: '0',
    CHANGE_MONITOR_INTERVAL_SECONDS: '1'
  };

  try {
    await runWithServer(env, async () => {
      await waitUntil(async () => {
        const info = await postInfo(port);
        const count = Number(info.json?.runtime_metrics?.counters?.pending_timeout_stuck_alerts_total || 0);
        return count >= 1;
      }, {
        timeoutMs: 8000,
        intervalMs: 200,
        label: 'expected pending_timeout_stuck_alerts_total to increase on 500 responses'
      });

      assert(fs.existsSync(files.pendingFile), 'pending session should remain while terminal reports fail');
      const pending = JSON.parse(fs.readFileSync(files.pendingFile, 'utf8'));
      assert(pending.op_id, 'expected pending session op_id to remain present');
      assert(
        Number(pending.timeout_stuck_alert_count || 0) >= 1,
        `expected timeout_stuck_alert_count >= 1, got ${pending.timeout_stuck_alert_count}`
      );

      const terminalEvents = rejectingSink.events.filter((e) => TERMINAL_EVENT_SET.has(String(e.body?.event || '')));
      assert(terminalEvents.length >= 1, 'expected at least one terminal event post attempt to rejecting sink');
    });
  } finally {
    await rejectingSink.close();
  }
}

async function testTimedOutPendingSessionReportsStuckAlertOnIpEventTimeout(tmpRoot, _sink) {
  const files = makeCaseFiles(tmpRoot, 'pending_timeout_ip_event_timeout');
  writeTimedOutPendingSession(files.pendingFile, {
    opId: '20260228T101500Z_regression_ipv4_timeout1'
  });
  const slowSink = await startEventSink({ delayMs: 9000 });

  const port = await getFreePort();
  const env = {
    ...buildEnv({
      port,
      provider: 'exec',
      endpoint: `http://127.0.0.1:${slowSink.port}/internal/ip-events`,
      execCommand: 'sleep 3; exit 0',
      stateFile: files.stateFile,
      pendingFile: files.pendingFile
    }),
    CHANGE_MONITOR_START_DELAY_SECONDS: '0',
    CHANGE_MONITOR_INTERVAL_SECONDS: '1'
  };

  try {
    await runWithServer(env, async () => {
      await waitUntil(async () => {
        const info = await postInfo(port);
        const count = Number(info.json?.runtime_metrics?.counters?.pending_timeout_stuck_alerts_total || 0);
        return count >= 1;
      }, {
        timeoutMs: 30000,
        intervalMs: 250,
        label: 'expected pending_timeout_stuck_alerts_total to increase on timeout responses'
      });

      assert(fs.existsSync(files.pendingFile), 'pending session should remain while terminal reports timeout');
      assert(
        slowSink.events.length >= 1,
        `expected at least one ip-events request to slow sink, got ${slowSink.events.length}`
      );
    });
  } finally {
    await slowSink.close();
  }
}

const CASES = [
  {
    title: 'concurrent /changeip only accepts one request (script provider)',
    run: testConcurrentOnlyOneAccepted
  },
  {
    title: 'reject relative script path',
    run: testRejectRelativeScriptPath
  },
  {
    title: 'reject non-regular script path',
    run: testRejectNonRegularFile
  },
  {
    title: 'fail-fast script returns 500 and clears pending',
    run: testFailFastScriptDoesNotLeavePending
  },
  {
    title: 'fail-fast script keeps pending and retries change_failed when first terminal report is rejected',
    run: testFailFastScriptRetriesFailedTerminalReport
  },
  {
    title: 'invalid pending schema is not compatible and is cleared before accepting new /changeip',
    run: testInvalidPendingSchemaIsCleared
  },
  {
    title: 'invalid pending without op_id is cleared even when /changeip is disabled',
    run: testInvalidPendingMissingOpIdIsClearedWhenChangeipDisabled
  },
  {
    title: 'concurrent /changeip only accepts one request (exec provider)',
    run: testExecProviderOnlyOneAccepted
  },
  {
    title: 'fail-fast exec returns 500 and clears pending',
    run: testFailFastExecDoesNotLeavePending
  },
  {
    title: 'http_flow provider executes login + action flow',
    run: testHttpFlowProviderHappyPath
  },
  {
    title: 'http_flow provider can tolerate network drop on final action step',
    run: testHttpFlowProviderAllowsNetworkErrorOnFinalStep
  },
  {
    title: 'http_flow provider supports request retries and wait_until polling',
    run: testHttpFlowRequestRetriesAndWaitUntil
  },
  {
    title: 'http_flow request retries honor Retry-After on 429 responses',
    run: testHttpFlowRetriesHonorRetryAfterOn429
  },
  {
    title: 'http_flow compile-time rejects unknown var reference',
    run: testHttpFlowProviderRejectsUnknownVar
  },
  {
    title: 'changeip provider must be explicitly configured',
    run: testRequireProviderWhenChangeipEnabled
  },
  {
    title: 'timed-out pending session keeps retrying and raises stuck alert when ip-events returns 500',
    run: testTimedOutPendingSessionReportsStuckAlertOnIpEvent500
  },
  {
    title: 'timed-out pending session raises stuck alert when ip-events request times out',
    run: testTimedOutPendingSessionReportsStuckAlertOnIpEventTimeout
  }
];

module.exports = {
  CASES
};
