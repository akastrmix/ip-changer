const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PROVIDER_ERROR_CODES } = require('./errors');

function ensureAbsolutePath(value, { emptyError, notAbsoluteError }) {
  const text = String(value || '').trim();
  if (!text) return { ok: false, error: emptyError };
  if (!path.isAbsolute(text)) return { ok: false, error: notAbsoluteError };
  return { ok: true, value: text };
}

function validateReadableRegularFile(filePath, errors) {
  const abs = ensureAbsolutePath(filePath, {
    emptyError: errors.emptyError,
    notAbsoluteError: errors.notAbsoluteError
  });
  if (!abs.ok) return abs;

  const file = abs.value;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, error: errors.notFoundError };
  }
  if (!stat.isFile()) {
    return { ok: false, error: errors.notRegularFileError };
  }
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch {
    return { ok: false, error: errors.notReadableError };
  }
  return { ok: true, value: file };
}

function waitForStableStart(proc, {
  graceMs = 1500,
  earlyExitCode = PROVIDER_ERROR_CODES.EXITED_EARLY
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener('error', onError);
      proc.removeListener('exit', onExit);
      resolve(result);
    };

    const onError = (err) => finish({
      ok: false,
      code: PROVIDER_ERROR_CODES.SPAWN_FAILED,
      detail: String(err)
    });
    const onExit = (code, signal) => {
      if (code === 0) {
        finish({ ok: true, exitedEarly: true });
        return;
      }
      const detail = code === null ? `signal ${String(signal || 'unknown')}` : `exit code ${code}`;
      finish({ ok: false, code: earlyExitCode, detail });
    };

    const timer = setTimeout(() => finish({ ok: true, exitedEarly: false }), Math.max(graceMs, 0));
    proc.once('error', onError);
    proc.once('exit', onExit);

    // Handle the fast-exit race: process may exit before listeners are attached.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      onExit(proc.exitCode, proc.signalCode);
    }
  });
}

function probeAsyncTaskStart(taskPromise, {
  graceMs = 1500,
  onLateError = null
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let gracePassed = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    Promise.resolve(taskPromise).then(
      () => {
        if (gracePassed) return;
        finish({ ok: true, completedInGrace: true });
      },
      (err) => {
        const detail = String(err && err.message ? err.message : err);
        if (!gracePassed) {
          finish({ ok: false, detail });
          return;
        }
        if (typeof onLateError === 'function') {
          try {
            onLateError(err);
          } catch {
            // ignore error from late error hook
          }
        }
      }
    );

    const timer = setTimeout(() => {
      gracePassed = true;
      finish({ ok: true, completedInGrace: false });
    }, Math.max(graceMs, 0));
  });
}

async function spawnDetachedAndProbe({
  command,
  args,
  graceMs = 1500,
  spawnErrorMessage,
  earlyExitErrorMessage,
  earlyExitCode = PROVIDER_ERROR_CODES.EXITED_EARLY
}) {
  let proc;
  try {
    proc = spawn(command, args, { stdio: 'ignore', detached: true });
  } catch (err) {
    return {
      ok: false,
      code: PROVIDER_ERROR_CODES.SPAWN_FAILED,
      error: spawnErrorMessage,
      detail: String(err && err.message ? err.message : err)
    };
  }

  const probe = await waitForStableStart(proc, { graceMs, earlyExitCode });
  if (!probe.ok) {
    const errorMessage = probe.code === PROVIDER_ERROR_CODES.SPAWN_FAILED
      ? spawnErrorMessage
      : earlyExitErrorMessage;
    return { ok: false, code: probe.code, error: errorMessage, detail: probe.detail };
  }

  proc.unref();
  return { ok: true, exitedEarly: !!probe.exitedEarly };
}

module.exports = {
  ensureAbsolutePath,
  probeAsyncTaskStart,
  validateReadableRegularFile,
  spawnDetachedAndProbe
};
