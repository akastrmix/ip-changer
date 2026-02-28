const httpClient = require('http');
const httpsClient = require('https');
const { URL } = require('url');
const { normalizeMaxResponseBytes, readResponseText } = require('./responseText');

const HTTP_KEEPALIVE_AGENT = new httpClient.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 16,
  maxFreeSockets: 4,
  timeout: 60 * 1000
});
const HTTPS_KEEPALIVE_AGENT = new httpsClient.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 16,
  maxFreeSockets: 4,
  timeout: 60 * 1000
});

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

function requestText(urlString, {
  timeoutMs = 5000,
  userAgent = 'ip-changer',
  family = 4,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'https:' ? httpsClient : httpClient;
    const maxBytes = normalizeMaxResponseBytes(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    const req = lib.request(url, {
      method: 'GET',
      timeout: timeoutMs,
      family,
      agent: url.protocol === 'https:' ? HTTPS_KEEPALIVE_AGENT : HTTP_KEEPALIVE_AGENT,
      headers: { 'user-agent': userAgent }
    }, (res) => {
      readResponseText(res, maxBytes).then((body) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
          return;
        }
        reject(new Error(`status ${res.statusCode || 0}`));
      }, reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function postJson(urlString, {
  token,
  body,
  timeoutMs = 8000,
  userAgent = 'ip-changer',
  family = 4,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'https:' ? httpsClient : httpClient;
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const maxBytes = normalizeMaxResponseBytes(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);

    const req = lib.request(url, {
      method: 'POST',
      timeout: timeoutMs,
      family,
      agent: url.protocol === 'https:' ? HTTPS_KEEPALIVE_AGENT : HTTP_KEEPALIVE_AGENT,
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        'user-agent': userAgent,
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      readResponseText(res, maxBytes).then((text) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, status: res.statusCode, text });
          return;
        }
        resolve({ ok: false, status: res.statusCode || 0, text });
      }, reject);
    });

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = {
  requestText,
  postJson
};
