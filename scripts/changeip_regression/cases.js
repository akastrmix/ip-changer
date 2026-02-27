'use strict';

const fs = require('fs');
const path = require('path');

const {
  assert,
  buildEnv,
  getFreePort,
  makeCaseFiles,
  postChangeIp,
  runWithServer,
  sleep,
  startHttpFlowMockPanel,
  startIpChangerExpectConfigError,
  writeShellScript
} = require('./harness');

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
    const started = newEvents.filter((e) => e.body?.event === 'change_started');
    assert(started.length === 0, 'fail-fast script should not emit change_started');
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
    const started = newEvents.filter((e) => e.body?.event === 'change_started');
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
    title: 'http_flow compile-time rejects unknown var reference',
    run: testHttpFlowProviderRejectsUnknownVar
  },
  {
    title: 'changeip provider must be explicitly configured',
    run: testRequireProviderWhenChangeipEnabled
  }
];

module.exports = {
  CASES
};
