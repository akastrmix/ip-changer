const crypto = require('crypto');

function formatUtcCompact(date) {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return iso.replace(/[-:]/g, '').replace('Z', 'Z');
}

function normalizeLabel(label) {
  const out = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'server';
  return out.slice(0, 32) || 'server';
}

function randomSuffixHex(len = 6) {
  const bytes = crypto.randomBytes(Math.ceil(len / 2));
  return bytes.toString('hex').slice(0, len);
}

function makeChangeOpId(serverLabel, date = new Date()) {
  const ts = formatUtcCompact(date);
  const label = normalizeLabel(serverLabel);
  return `${ts}_${label}_${randomSuffixHex(6)}`;
}

function makeIpv4OpId(serverLabel, date = new Date()) {
  const ts = formatUtcCompact(date);
  const label = normalizeLabel(serverLabel);
  return `${ts}_${label}_ipv4_${randomSuffixHex(6)}`;
}

module.exports = {
  makeChangeOpId,
  makeIpv4OpId
};
