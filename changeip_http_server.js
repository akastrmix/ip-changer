// Minimal HTTP server on VPS to trigger changeip + reboot
// Usage:
//   AUTH_TOKEN=your-secret PORT=8787 node changeip_http_server.js
//
// Then POST to:
//   http://<vps-ip>:8787/changeip  with JSON body: { "token": "your-secret" }

const http = require('http');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '8787', 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const CHANGEIP_SCRIPT = process.env.CHANGEIP_SCRIPT || '/changeip.sh';
const REBOOT_DELAY_MINUTES = parseInt(process.env.REBOOT_DELAY_MINUTES || '16', 10);

if (!AUTH_TOKEN) {
  console.error('[changeip-http] AUTH_TOKEN is not set. Refusing to start.');
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

function scheduleReboot() {
  const delayMinutes = Math.max(REBOOT_DELAY_MINUTES, 1);
  console.log(`[changeip-http] scheduling reboot in ${delayMinutes} minutes...`);

  const proc = spawn('shutdown', ['-r', `+${delayMinutes}`], {
    stdio: 'ignore',
    detached: true
  });
  proc.unref();
}

function runChangeIp(res) {
  console.log(`[changeip-http] starting changeip script: ${CHANGEIP_SCRIPT} ...`);

  const proc = spawn('/bin/bash', [CHANGEIP_SCRIPT], {
    stdio: 'ignore',
    detached: true
  });

  proc.on('error', (err) => {
    console.error('[changeip-http] failed to start changeip script:', err);
  });

  proc.unref();

  scheduleReboot();

  jsonResponse(res, 200, {
    ok: true,
    message: `changeip started, reboot scheduled in ${REBOOT_DELAY_MINUTES} minutes`
  });
}

function handleRequest(req, res) {
  const { method, url } = req;

  if (method === 'GET' && url === '/') {
    return jsonResponse(res, 200, { ok: true, service: 'changeip-http' });
  }

  if (method === 'POST' && url === '/changeip') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024) {
        // too large, abort
        req.destroy();
      }
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch (_err) {
        return jsonResponse(res, 400, { ok: false, error: 'invalid json' });
      }

      const token = parsed && typeof parsed.token === 'string' ? parsed.token : '';
      if (!token || token !== AUTH_TOKEN) {
        return jsonResponse(res, 403, { ok: false, error: 'forbidden' });
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
