const http = require('http');
const https = require('https');
const { URL } = require('url');

const { normalizeMaxResponseBytes, readResponseText } = require('../../network/responseText');
const { buildCookieHeader, saveCookies } = require('./cookies');

const HTTP_KEEPALIVE_AGENT = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 16,
  maxFreeSockets: 4,
  timeout: 60 * 1000
});
const HTTPS_KEEPALIVE_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 16,
  maxFreeSockets: 4,
  timeout: 60 * 1000
});

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function hasHeader(headers, name) {
  const key = String(name || '').toLowerCase();
  return Object.keys(headers).some((k) => String(k).toLowerCase() === key);
}

function getHeader(headers, name) {
  const key = String(name || '').toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) {
    if (String(k).toLowerCase() === key) return v;
  }
  return undefined;
}

function headerToText(value) {
  if (Array.isArray(value)) return value.join('\n');
  return String(value ?? '');
}

function stripEntityHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase();
    if (key === 'content-length' || key === 'content-type') continue;
    out[k] = v;
  }
  return out;
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function nextMethodForRedirect(status, method) {
  const m = String(method || 'GET').toUpperCase();
  if ((status === 301 || status === 302 || status === 303) && m !== 'GET' && m !== 'HEAD') {
    return 'GET';
  }
  return m;
}

function requestOnce({ urlObj, method, headers, body, timeoutMs, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    const lib = urlObj.protocol === 'https:' ? https : http;
    const maxBytes = normalizeMaxResponseBytes(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    const req = lib.request(urlObj, {
      method,
      headers,
      timeout: timeoutMs,
      agent: urlObj.protocol === 'https:' ? HTTPS_KEEPALIVE_AGENT : HTTP_KEEPALIVE_AGENT
    }, (res) => {
      readResponseText(res, maxBytes).then((bodyText) => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: bodyText,
          url: new URL(urlObj.toString())
        });
      }, reject);
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (body !== undefined && body !== null && body !== '') req.write(body);
    req.end();
  });
}

async function requestWithRedirects({
  urlObj,
  method,
  headers,
  body,
  timeoutMs,
  followRedirects,
  maxRedirects,
  cookieJar,
  userAgent,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
}) {
  let currentUrl = new URL(urlObj.toString());
  let currentMethod = String(method || 'GET').toUpperCase();
  let currentHeaders = { ...(headers || {}) };
  let currentBody = body;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const requestHeaders = { ...currentHeaders };
    if (userAgent && !hasHeader(requestHeaders, 'user-agent')) {
      requestHeaders['user-agent'] = userAgent;
    }
    if (!hasHeader(requestHeaders, 'cookie')) {
      const cookieHeader = buildCookieHeader(cookieJar, currentUrl);
      if (cookieHeader) requestHeaders.cookie = cookieHeader;
    }
    if (currentBody !== undefined && currentBody !== null && !hasHeader(requestHeaders, 'content-length')) {
      requestHeaders['content-length'] = String(Buffer.byteLength(String(currentBody), 'utf8'));
    }

    const response = await requestOnce({
      urlObj: currentUrl,
      method: currentMethod,
      headers: requestHeaders,
      body: currentBody,
      timeoutMs,
      maxResponseBytes
    });
    saveCookies(cookieJar, currentUrl, response.headers);

    if (!followRedirects || !isRedirectStatus(response.status)) return response;

    const location = getHeader(response.headers, 'location');
    if (!location) return response;
    if (redirects >= maxRedirects) throw new Error('too many redirects');

    const nextUrl = new URL(String(location), currentUrl);
    const nextMethod = nextMethodForRedirect(response.status, currentMethod);
    if (nextMethod !== currentMethod) {
      currentBody = null;
      currentHeaders = stripEntityHeaders(currentHeaders);
    }

    currentMethod = nextMethod;
    currentUrl = nextUrl;
  }

  throw new Error('too many redirects');
}

module.exports = {
  getHeader,
  hasHeader,
  headerToText,
  requestWithRedirects
};
