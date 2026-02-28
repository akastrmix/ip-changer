const { PROVIDER_ERROR_CODES } = require('./errors');
const { createDetachedCommandProvider } = require('./detachedCommandProvider');

function validate(config) {
  const command = String(config.changeipExecCommand || '').trim();
  if (!command) return { ok: false, error: 'changeip exec command is empty' };
  return { ok: true, value: command };
}

module.exports = createDetachedCommandProvider({
  name: 'exec',
  validate,
  earlyExitReason: 'exec_exited_early',
  buildSpawnSpec: (commandText) => ({
    command: '/bin/bash',
    args: ['-lc', commandText],
    graceMs: 1500,
    spawnErrorMessage: 'failed to spawn changeip exec command',
    earlyExitErrorMessage: 'changeip exec command exited early',
    earlyExitCode: PROVIDER_ERROR_CODES.EXITED_EARLY
  })
});
