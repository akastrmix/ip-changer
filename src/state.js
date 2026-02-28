const fs = require('fs');
const path = require('path');

function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore
  }
}

function loadJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
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

function loadIpState(config) {
  return loadJsonFile(config.ipStateFile) || {};
}

function saveIpState(config, state) {
  return saveJsonFileAtomic(config.ipStateFile, state || {});
}

function loadPendingChange(config) {
  const obj = loadJsonFile(config.pendingChangeFile);
  return obj && typeof obj === 'object' ? obj : null;
}

function savePendingChange(config, pending) {
  return saveJsonFileAtomic(config.pendingChangeFile, pending || {});
}

function clearPendingChange(config) {
  return deleteFile(config.pendingChangeFile);
}

module.exports = {
  loadIpState,
  saveIpState,
  loadPendingChange,
  savePendingChange,
  clearPendingChange
};
