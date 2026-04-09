// ip-changer (VPS): minimal HTTP server + optional changeip trigger + IPv4/IPv6 monitor
// - No third-party NPM deps; Node.js standard library only.
//
// Endpoints:
// - GET  /
// - POST /info     { token }
// - POST /changeip { token }   (optional)
// - POST /ipquality { token }  (optional)
// - POST /ipquality/status { token }  (optional)

const http = require('http');

const { loadConfigFromEnv, safeTokenEquals } = require('./src/config');
const {
  isStateFileError,
  loadIpState,
  loadPendingChange
} = require('./src/state');
const { triggerChangeIp } = require('./src/change/trigger');
const { getIpqualityStatus, loadIpqualityState, triggerIpquality } = require('./src/ipquality');
const { startMonitor } = require('./src/monitor');
const { getRuntimeMetricsSnapshot } = require('./src/runtime/metrics');
const {
  IP_EVENTS_CONTRACT_VERSION,
  SUPPORTED_IP_EVENTS_CONTRACT_VERSIONS
} = require('./src/contracts/ipEvents');

const SERVER_REQUEST_TIMEOUT_MS = 300 * 1000;
const SERVER_HEADERS_TIMEOUT_MS = 60 * 1000;
const SERVER_KEEP_ALIVE_TIMEOUT_MS = 5 * 1000;

let config;
try {
  config = loadConfigFromEnv(process.env);
  loadIpState(config);
  loadPendingChange(config);
  if (config.ipqualityEnabled) {
    loadIpqualityState(config, { repairStaleRunning: true });
  }
} catch (err) {
  console.error('[changeip-http] startup error:', String(err));
  process.exit(1);
}

let FATAL_EXIT_SCHEDULED = false;

function scheduleFatalExit(reason, err) {
  const detail = String(err || reason || 'unknown');
  console.error(`[changeip-http] fatal: ${reason}: ${detail}`);
  if (FATAL_EXIT_SCHEDULED) return;
  FATAL_EXIT_SCHEDULED = true;
  setImmediate(() => process.exit(1));
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
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          jsonResponse(res, 400, { ok: false, error: 'json body must be an object' });
          return resolve(null);
        }
        resolve(parsed);
      } catch (_err) {
        jsonResponse(res, 400, { ok: false, error: 'invalid json' });
        return resolve(null);
      }
    });

    req.on('error', () => {
      if (responded) return resolve(null);
      responded = true;
      try {
        jsonResponse(res, 400, { ok: false, error: 'request error' });
      } catch {
        // ignore: connection may already be closed
      }
      resolve(null);
    });
  });
}

function sendResult(res, result) {
  jsonResponse(res, result.status || 500, result.body || { ok: false, error: 'unknown_error' });
}

function handleAuthenticatedPost(req, res, routeName, handler) {
  readJsonBody(req, res).then(async (parsed) => {
    if (!parsed) return;
    const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
    if (!token || !safeTokenEquals(token, config.authToken)) {
      jsonResponse(res, 403, { ok: false, error: 'forbidden' });
      return;
    }

    try {
      sendResult(res, await handler(parsed));
    } catch (err) {
      console.error(`[changeip-http] ${routeName} error:`, String(err));
      if (isStateFileError(err)) {
        scheduleFatalExit(`state file error during ${routeName}`, err);
        jsonResponse(res, 500, { ok: false, error: 'state_error' });
        return;
      }
      jsonResponse(res, 500, { ok: false, error: 'internal_error' });
    }
  });
}

function handleInfo(req, res) {
  handleAuthenticatedPost(req, res, '/info', () => {
    const state = loadIpState(config);
    return {
      status: 200,
      body: {
      ok: true,
      server_label: config.serverLabel,
      channel: config.reportChannel,
      changeip_enabled: config.changeipEnabled,
      changeip_provider: config.changeipEnabled ? config.changeipProvider : null,
      ip_events_enabled: config.ipEventsActive,
      ip_monitor_enabled: config.ipMonitorEnabled && config.ipEventsActive,
      ipv6_monitor_enabled: config.ipv6MonitorEnabled && config.ipEventsActive,
      ip_events_contract_version: IP_EVENTS_CONTRACT_VERSION,
      ip_events_contract_versions_supported: SUPPORTED_IP_EVENTS_CONTRACT_VERSIONS,
      notified_ipv4: state.notified_ipv4 || null,
      notified_ipv6: state.notified_ipv6 || null,
      runtime_metrics: getRuntimeMetricsSnapshot()
      }
    };
  });
}

function handleChangeIp(req, res) {
  handleAuthenticatedPost(req, res, '/changeip', (parsed) => {
    const force = parsed && parsed.force === true;
    return triggerChangeIp(config, { force });
  });
}

function handleIpquality(req, res) {
  handleAuthenticatedPost(req, res, '/ipquality', () => {
    return triggerIpquality(config);
  });
}

function handleIpqualityStatus(req, res) {
  handleAuthenticatedPost(req, res, '/ipquality/status', () => {
    return getIpqualityStatus(config);
  });
}

function handleRequest(req, res) {
  const { method, url } = req;

  if (method === 'GET' && url === '/') {
    return jsonResponse(res, 200, { ok: true, service: 'changeip-http' });
  }

  if (method === 'POST' && url === '/info') {
    return handleInfo(req, res);
  }

  if (method === 'POST' && url === '/changeip') {
    return handleChangeIp(req, res);
  }

  if (method === 'POST' && url === '/ipquality') {
    return handleIpquality(req, res);
  }

  if (method === 'POST' && url === '/ipquality/status') {
    return handleIpqualityStatus(req, res);
  }

  jsonResponse(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer(handleRequest);
server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
server.headersTimeout = Math.max(SERVER_HEADERS_TIMEOUT_MS, SERVER_KEEP_ALIVE_TIMEOUT_MS + 1000);

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[changeip-http] listening on 0.0.0.0:${config.port}`);
  if (config.ipEventsActive) {
    console.log(`[changeip-http] ip-events enabled: ${config.ipEventsEndpoint}`);
  }
  if (config.ipMonitorEnabled) {
    console.log(`[changeip-http] ipv4 monitor enabled: interval=${config.ipMonitorIntervalSeconds}s`);
  }
  if (config.ipv6MonitorEnabled) {
    console.log(`[changeip-http] ipv6 monitor enabled: interval=${config.ipMonitorIntervalSeconds}s (shared with ipv4)`);
  }
  if (config.changeipEnabled) {
    console.log(`[changeip-http] /changeip enabled: provider=${config.changeipProvider}`);
    if (config.changeipProvider === 'script') {
      console.log(`[changeip-http] changeip script: ${config.changeipScript}`);
    }
    if (config.changeipProvider === 'http_flow') {
      console.log(`[changeip-http] changeip http_flow file: ${config.changeipHttpFlowFile}`);
    }
  }
  if (config.ipqualityEnabled) {
    console.log(`[changeip-http] /ipquality enabled: script=${config.ipqualityScriptPath}`);
  }
});
server.on('error', (err) => {
  console.error('[changeip-http] server error:', String(err));
  process.exit(1);
});

startMonitor(config);
