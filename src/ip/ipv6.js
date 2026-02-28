const net = require('net');
const { requestText } = require('../network/http');

const IPV6_SOURCES = [
  'https://api6.ipify.org',
  'https://v6.ident.me',
  'https://ifconfig.co/ip',
  'https://ipv6.icanhazip.com'
];

function isValidIpv6(value) {
  const ip = String(value || '').trim();
  return net.isIP(ip) === 6;
}

async function fetchPublicIpv6({ userAgent = 'ip-changer', timeoutMs = 5000 } = {}) {
  const errors = [];
  for (const source of IPV6_SOURCES) {
    try {
      const ip = (await requestText(source, { userAgent, timeoutMs, family: 6 })).trim();
      if (isValidIpv6(ip)) return ip;
      errors.push(`${source}: invalid ipv6 response "${ip}"`);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      errors.push(`${source}: ${message}`);
    }
  }
  throw new Error(`failed to fetch public ipv6 (${errors.join('; ')})`);
}

module.exports = {
  isValidIpv6,
  fetchPublicIpv6
};
