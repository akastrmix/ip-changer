function parseBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

module.exports = {
  parseBoolean
};
