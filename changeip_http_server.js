// ip-changer (VPS): minimal HTTP server + optional changeip trigger + IPv4 monitor (IPv4-only)
// - No third-party NPM deps; Node.js standard library only.
//
// Endpoints:
// - GET  /
// - POST /info     { token }
// - POST /changeip { token }   (optional)

const http = require('http');

const { loadConfigFromEnv, safeTokenEquals } = require('./src/config');
const { loadIpState } = require('./src/state');
const { triggerChangeIp } = require('./src/changeip');
const { startMonitor } = require('./src/monitor');

let config;
try {
  config = loadConfigFromEnv(process.env);
} catch (err) {
  console.error('[changeip-http] config error:', String(err));
  process.exit(1);
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

function handleInfo(req, res) {
  readJsonBody(req, res).then((parsed) => {
    if (!parsed) return;
    const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
    if (!token || !safeTokenEquals(token, config.authToken)) {
      jsonResponse(res, 403, { ok: false, error: 'forbidden' });
      return;
    }

    const state = loadIpState(config);
    jsonResponse(res, 200, {
      ok: true,
      server_label: config.serverLabel,
      channel: config.reportChannel,
      changeip_enabled: config.changeipEnabled,
      ip_events_enabled: config.ipEventsActive,
      ip_monitor_enabled: config.ipMonitorEnabled && config.ipEventsActive,
      notified_ipv4: state.notified_ipv4 || null
    });
  });
}

function handleChangeIp(req, res) {
  readJsonBody(req, res).then(async (parsed) => {
    if (!parsed) return;
    const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
    if (!token || !safeTokenEquals(token, config.authToken)) {
      jsonResponse(res, 403, { ok: false, error: 'forbidden' });
      return;
    }

    let result;
    try {
      result = await triggerChangeIp(config);
    } catch (err) {
      console.error('[changeip-http] /changeip error:', String(err));
      result = { status: 500, body: { ok: false, error: 'internal_error' } };
    }
    jsonResponse(res, result.status || 500, result.body || { ok: false, error: 'unknown_error' });
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

  jsonResponse(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer(handleRequest);

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[changeip-http] listening on 0.0.0.0:${config.port}`);
  if (config.ipEventsActive) {
    console.log(`[changeip-http] ip-events enabled: ${config.ipEventsEndpoint}`);
  }
  if (config.ipMonitorEnabled) {
    console.log(`[changeip-http] ipv4 monitor enabled: interval=${config.ipMonitorIntervalSeconds}s`);
  }
  if (config.changeipEnabled) {
    console.log(`[changeip-http] /changeip enabled: script=${config.changeipScript}`);
  }
});
server.on('error', (err) => {
  console.error('[changeip-http] server error:', String(err));
  process.exit(1);
});

startMonitor(config);

