function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function parseIntInRange(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function normalizeExpectedStatus(expectStatus) {
  if (expectStatus === undefined) return null;
  if (Array.isArray(expectStatus)) {
    const list = expectStatus
      .map((n) => Number.parseInt(String(n), 10))
      .filter((n) => Number.isFinite(n) && n >= 100 && n <= 599);
    if (!list.length) throw new Error('expect_status must contain valid HTTP status codes');
    return list;
  }

  const one = Number.parseInt(String(expectStatus), 10);
  if (!Number.isFinite(one) || one < 100 || one > 599) {
    throw new Error('expect_status must be a valid HTTP status code');
  }
  return [one];
}

module.exports = {
  isObject,
  hasOwn,
  parseIntInRange,
  normalizeExpectedStatus
};
