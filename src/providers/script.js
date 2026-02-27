const { validateReadableRegularFile, spawnDetachedAndProbe } = require('./utils');
const { PROVIDER_ERROR_CODES, providerFailure, providerSuccess } = require('./errors');

function validate(config) {
  return validateReadableRegularFile(config.changeipScript, {
    emptyError: 'changeip script path is empty',
    notAbsoluteError: 'changeip script path must be absolute',
    notFoundError: 'changeip script not found',
    notRegularFileError: 'changeip script is not a regular file',
    notReadableError: 'changeip script not readable'
  });
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

  const result = await spawnDetachedAndProbe({
    command: '/bin/bash',
    args: [check.value],
    graceMs: 1500,
    spawnErrorMessage: 'failed to spawn changeip script',
    earlyExitErrorMessage: 'changeip script exited early',
    earlyExitCode: PROVIDER_ERROR_CODES.EXITED_EARLY
  });
  if (!result.ok) {
    return providerFailure({
      code: result.code || PROVIDER_ERROR_CODES.RUNTIME_FAILED,
      error: result.error,
      detail: result.detail,
      reason: result.code === PROVIDER_ERROR_CODES.EXITED_EARLY ? 'script_exited_early' : 'spawn_failed'
    });
  }
  return providerSuccess({ exitedEarly: result.exitedEarly });
}

module.exports = {
  name: 'script',
  validate,
  start
};
