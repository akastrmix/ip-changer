const httpClient = require('http');
const httpsClient = require('https');
const { URL } = require('url');

function requestText(urlString, { timeoutMs = 5000, userAgent = 'ip-changer' } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'https:' ? httpsClient : httpClient;
    const req = lib.request(url, {
      method: 'GET',
      timeout: timeoutMs,
      family: 4,
      headers: { 'user-agent': userAgent }
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

function postJson(urlString, { token, body, timeoutMs = 8000, userAgent = 'ip-changer' } = {}) {
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
        'user-agent': userAgent,
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

module.exports = {
  requestText,
  postJson
};

