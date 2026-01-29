const { requestText } = require('./http');

function isValidIpv4(value) {
  const ip = String(value || '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const parts = ip.split('.').map((n) => parseInt(n, 10));
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
}

async function fetchPublicIpv4({ userAgent = 'ip-changer', timeoutMs = 5000 } = {}) {
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
  fetchPublicIpv4
};
