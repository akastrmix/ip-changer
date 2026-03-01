const scriptProvider = require('./script');
const execProvider = require('./exec');
const httpFlowProvider = require('./httpFlow');
const { PROVIDER_ERROR_CODES, providerFailure } = require('./errors');

const PROVIDERS = {
  script: scriptProvider,
  exec: execProvider,
  http_flow: httpFlowProvider
};

function getProvider(config) {
  const key = String(config.changeipProvider || '').trim();
  const provider = PROVIDERS[key];
  if (!provider) {
    return providerFailure({
      code: PROVIDER_ERROR_CODES.UNSUPPORTED,
      error: `unsupported changeip provider: ${key || '(empty)'}`,
      reason: 'unsupported_provider'
    });
  }
  return { ok: true, provider };
}

async function startProvider(config, ctx = {}) {
  const resolved = getProvider(config);
  if (!resolved.ok) return resolved;
  return resolved.provider.start(config, ctx);
}

module.exports = {
  getProvider,
  startProvider
};
