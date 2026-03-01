const { requestText } = require('../network/http');

function isValidIpv4(value) {
  const ip = String(value || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const parts = ip.split('.').map((n) => parseInt(n, 10));
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
}

function resolveIpv4Override({
  overrideIpv4 = '',
  env = process.env
} = {}) {
  const explicit = String(overrideIpv4 || '').trim();
  if (explicit) {
    if (isValidIpv4(explicit)) return explicit;
    throw new Error('override_ipv4_invalid');
  }

  const allowFromEnv = (() => {
    const raw = String(env?.ALLOW_PUBLIC_IPV4_OVERRIDE || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  })();
  if (!allowFromEnv) return '';

  const fromEnv = String(env?.PUBLIC_IPV4_OVERRIDE || '').trim();
  if (!fromEnv) return '';
  if (isValidIpv4(fromEnv)) return fromEnv;
  throw new Error('public_ipv4_override_invalid');
}

async function fetchPublicIpv4({
  userAgent = 'ip-changer',
  timeoutMs = 5000,
  overrideIpv4 = '',
  env = process.env
} = {}) {
  const override = resolveIpv4Override({ overrideIpv4, env });
  if (override) return override;

  const sources = [
    async () => (await requestText('https://api.ipify.org', { userAgent, timeoutMs })).trim(),
    async () => (await requestText('https://ipv4.icanhazip.com', { userAgent, timeoutMs })).trim(),
    async () => {
      const text = await requestText('https://1.1.1.1/cdn-cgi/trace', { userAgent, timeoutMs });
      const line = text.split('\n').find((l) => l.startsWith('ip='));
      return (line ? line.slice(3) : '').trim();
    }
  ];

  for (const get of sources) {
    try {
      const ip = await get();
      if (isValidIpv4(ip)) return ip;
    } catch {
      // try next
    }
  }
  throw new Error('failed to fetch public ipv4');
}

module.exports = {
  isValidIpv4,
  fetchPublicIpv4,
  _test: {
    resolveIpv4Override
  }
};
