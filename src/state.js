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

function saveJsonFileAtomic(filePath, obj) {
  try {
    ensureDirFor(filePath);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error('[changeip-http] failed to save state:', String(err));
  }
}

function deleteFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function loadIpState(config) {
  return loadJsonFile(config.ipStateFile) || {};
}

function saveIpState(config, state) {
  saveJsonFileAtomic(config.ipStateFile, state || {});
}

function loadPendingChange(config) {
  const obj = loadJsonFile(config.pendingChangeFile);
  return obj && typeof obj === 'object' ? obj : null;
}

function savePendingChange(config, pending) {
  saveJsonFileAtomic(config.pendingChangeFile, pending || {});
}

function clearPendingChange(config) {
  deleteFile(config.pendingChangeFile);
}

module.exports = {
  loadIpState,
  saveIpState,
  loadPendingChange,
  savePendingChange,
  clearPendingChange
};

