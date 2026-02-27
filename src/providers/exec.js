const { spawnDetachedAndProbe } = require('./utils');
const { PROVIDER_ERROR_CODES, providerFailure, providerSuccess } = require('./errors');

function validate(config) {
  const command = String(config.changeipExecCommand || '').trim();
  if (!command) return { ok: false, error: 'changeip exec command is empty' };
  return { ok: true, value: command };
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
    args: ['-lc', check.value],
    graceMs: 1500,
    spawnErrorMessage: 'failed to spawn changeip exec command',
    earlyExitErrorMessage: 'changeip exec command exited early',
    earlyExitCode: PROVIDER_ERROR_CODES.EXITED_EARLY
  });
  if (!result.ok) {
    return providerFailure({
      code: result.code || PROVIDER_ERROR_CODES.RUNTIME_FAILED,
      error: result.error,
      detail: result.detail,
      reason: result.code === PROVIDER_ERROR_CODES.EXITED_EARLY ? 'exec_exited_early' : 'spawn_failed'
    });
  }
  return providerSuccess({ exitedEarly: result.exitedEarly });
}

module.exports = {
  name: 'exec',
  validate,
  start
};
