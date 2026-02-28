const { spawnDetachedAndProbe } = require('./utils');
const { PROVIDER_ERROR_CODES, providerFailure, providerSuccess } = require('./errors');

function createDetachedCommandProvider({
  name,
  validate,
  buildSpawnSpec,
  earlyExitReason
}) {
  if (typeof validate !== 'function') {
    throw new Error('createDetachedCommandProvider: validate must be a function');
  }
  if (typeof buildSpawnSpec !== 'function') {
    throw new Error('createDetachedCommandProvider: buildSpawnSpec must be a function');
  }

  async function start(config) {
    const check = validate(config);
    if (!check.ok) {
      return providerFailure({
        code: PROVIDER_ERROR_CODES.CONFIG_INVALID,
        error: check.error,
        reason: 'provider_config_invalid'
      });
    }

    const spec = buildSpawnSpec(check.value, config);
    const result = await spawnDetachedAndProbe(spec);
    if (!result.ok) {
      return providerFailure({
        code: result.code || PROVIDER_ERROR_CODES.RUNTIME_FAILED,
        error: result.error,
        detail: result.detail,
        reason: result.code === PROVIDER_ERROR_CODES.EXITED_EARLY
          ? String(earlyExitReason || 'provider_exited_early')
          : 'spawn_failed'
      });
    }

    return providerSuccess({
      start_mode: 'detached',
      exitedEarly: result.exitedEarly
    });
  }

  return {
    name: String(name || ''),
    validate,
    start
  };
}

module.exports = {
  createDetachedCommandProvider
};
