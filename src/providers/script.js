const { validateReadableRegularFile } = require('./utils');
const { PROVIDER_ERROR_CODES } = require('./errors');
const { createDetachedCommandProvider } = require('./detachedCommandProvider');

function validate(config) {
  return validateReadableRegularFile(config.changeipScript, {
    emptyError: 'changeip script path is empty',
    notAbsoluteError: 'changeip script path must be absolute',
    notFoundError: 'changeip script not found',
    notRegularFileError: 'changeip script is not a regular file',
    notReadableError: 'changeip script not readable'
  });
}

module.exports = createDetachedCommandProvider({
  name: 'script',
  validate,
  earlyExitReason: 'script_exited_early',
  buildSpawnSpec: (scriptPath) => ({
    command: '/bin/bash',
    args: [scriptPath],
    graceMs: 1500,
    spawnErrorMessage: 'failed to spawn changeip script',
    earlyExitErrorMessage: 'changeip script exited early',
    earlyExitCode: PROVIDER_ERROR_CODES.EXITED_EARLY
  })
});
