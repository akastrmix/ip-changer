function defaultCookiePath(pathname) {
  const path = String(pathname || '/');
  if (!path.startsWith('/')) return '/';
  if (path === '/') return '/';
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.slice(0, idx);
}

function parseSetCookie(setCookie, urlObj) {
  const lines = Array.isArray(setCookie) ? setCookie : [setCookie];
  const cookies = [];
  for (const lineRaw of lines) {
    const line = String(lineRaw || '').trim();
    if (!line) continue;

    const parts = line.split(';');
    const nameValue = String(parts.shift() || '').trim();
    const eq = nameValue.indexOf('=');
    if (eq <= 0) continue;

    const cookie = {
      name: nameValue.slice(0, eq).trim(),
      value: nameValue.slice(eq + 1),
      domain: String(urlObj.hostname || '').toLowerCase(),
      hostOnly: true,
      path: defaultCookiePath(urlObj.pathname),
      secure: false,
      expired: false
    };
    if (!cookie.name) continue;

    for (const attrRaw of parts) {
      const attrText = String(attrRaw || '').trim();
      if (!attrText) continue;
      const attrEq = attrText.indexOf('=');
      const key = (attrEq >= 0 ? attrText.slice(0, attrEq) : attrText).trim().toLowerCase();
      const value = attrEq >= 0 ? attrText.slice(attrEq + 1).trim() : '';
      if (key === 'domain') {
        const normalized = value.replace(/^\./, '').toLowerCase();
        if (normalized) {
          cookie.domain = normalized;
          cookie.hostOnly = false;
        }
      } else if (key === 'path') {
        cookie.path = value || '/';
      } else if (key === 'secure') {
        cookie.secure = true;
      } else if (key === 'max-age') {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n <= 0) cookie.expired = true;
      }
    }

    cookies.push(cookie);
  }
  return cookies;
}

function domainMatches(host, cookie) {
  const reqHost = String(host || '').toLowerCase();
  const cookieDomain = String(cookie.domain || '').toLowerCase();
  if (!reqHost || !cookieDomain) return false;
  if (cookie.hostOnly) return reqHost === cookieDomain;
  return reqHost === cookieDomain || reqHost.endsWith(`.${cookieDomain}`);
}

function pathMatches(pathname, cookiePath) {
  const reqPath = String(pathname || '/');
  const cp = String(cookiePath || '/');
  if (cp === '/') return true;
  return reqPath === cp || reqPath.startsWith(`${cp}/`);
}

function saveCookies(cookieJar, responseUrl, headers) {
  const parsed = parseSetCookie(headers['set-cookie'], responseUrl);
  for (const cookie of parsed) {
    for (let i = cookieJar.length - 1; i >= 0; i -= 1) {
      const exists = cookieJar[i];
      if (
        exists.name === cookie.name &&
        exists.domain === cookie.domain &&
        exists.path === cookie.path
      ) {
        cookieJar.splice(i, 1);
      }
    }
    if (!cookie.expired) cookieJar.push(cookie);
  }
}

function buildCookieHeader(cookieJar, urlObj) {
  const pairs = [];
  for (const cookie of cookieJar) {
    if (!domainMatches(urlObj.hostname, cookie)) continue;
    if (!pathMatches(urlObj.pathname || '/', cookie.path)) continue;
    if (cookie.secure && urlObj.protocol !== 'https:') continue;
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  return pairs.join('; ');
}

module.exports = {
  buildCookieHeader,
  saveCookies
};
