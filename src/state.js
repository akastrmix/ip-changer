const fs = require('fs');
const path = require('path');

class StateFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateFileError';
  }
}

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore
  }
}

function readJsonObjectFile(filePath, label) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must contain a JSON object`);
    }
    return { exists: true, value: parsed };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { exists: false, value: null };
    }
    const detail = err && err.message ? err.message : String(err);
    throw new StateFileError(`failed to load ${label} ${filePath}: ${detail}`);
  }
}

function loadOptionalJsonObjectFile(filePath, label) {
  return readJsonObjectFile(filePath, label);
}

function isStateFileError(err) {
  return err instanceof StateFileError;
}

function fsyncDirBestEffort(dirPath) {
  let dirFd = null;
  try {
    dirFd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(dirFd);
  } catch {
    // ignore: some filesystems do not allow directory fsync
  } finally {
    if (dirFd !== null) {
      try {
        fs.closeSync(dirFd);
      } catch {
        // ignore
      }
    }
  }
}

function saveJsonFileAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  try {
    ensureDirFor(filePath);

    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(obj), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmp, filePath);
    fsyncDirBestEffort(path.dirname(filePath));
    return { ok: true, error: '' };
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    const error = String(err);
    console.error('[changeip-http] failed to save state:', error);
    return { ok: false, error };
  }
}

function saveJsonObjectFileAtomic(filePath, obj) {
  return saveJsonFileAtomic(filePath, obj);
}

function deleteFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    return { ok: true, error: '' };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, error: '' };
    }
    const error = String(err);
    console.error('[changeip-http] failed to delete state file:', error);
    return { ok: false, error };
  }
}

function deleteStateFile(filePath) {
  return deleteFile(filePath);
}

function loadIpState(config) {
  const result = readJsonObjectFile(config.ipStateFile, 'ip state file');
  return result.exists ? result.value : {};
}

function saveIpState(config, state) {
  return saveJsonFileAtomic(config.ipStateFile, state || {});
}

function loadPendingChange(config) {
  const result = readJsonObjectFile(config.pendingChangeFile, 'pending change file');
  return result.exists ? result.value : null;
}

function savePendingChange(config, pending) {
  return saveJsonFileAtomic(config.pendingChangeFile, pending || {});
}

function clearPendingChange(config) {
  return deleteFile(config.pendingChangeFile);
}

module.exports = {
  StateFileError,
  deleteStateFile,
  isStateFileError,
  loadIpState,
  loadOptionalJsonObjectFile,
  saveIpState,
  saveJsonObjectFileAtomic,
  loadPendingChange,
  savePendingChange,
  clearPendingChange
};
