'use strict';

const { spawn } = require('child_process');

const {
  completeIpqualityRun,
  failIpqualityRun
} = require('./state');
const {
  recordIpqualityRunFailed,
  recordIpqualityRunSucceeded
} = require('../runtime/metrics');
const { StateFileError } = require('../state');

const OUTPUT_CAPTURE_MAX_BYTES = 128 * 1024;
const OUTPUT_EXCERPT_MAX_CHARS = 1200;
const FORCE_KILL_GRACE_MS = 2000;
const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*[A-Za-z]/g;
const REPORT_URL_RE = /https:\/\/\S+?\.svg\b/gi;
const USE_DETACHED_PROCESS_GROUP = process.platform !== 'win32';

function appendChunk(buffer, chunk) {
  const next = `${buffer}${String(chunk || '')}`;
  if (Buffer.byteLength(next, 'utf8') <= OUTPUT_CAPTURE_MAX_BYTES) {
    return next;
  }

  const nextBytes = Buffer.from(next, 'utf8');
  return nextBytes.slice(nextBytes.length - OUTPUT_CAPTURE_MAX_BYTES).toString('utf8');
}

function sanitizeOutputText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildOutputExcerpt(text) {
  const cleaned = sanitizeOutputText(text);
  if (!cleaned) return '';
  if (cleaned.length <= OUTPUT_EXCERPT_MAX_CHARS) return cleaned;
  return cleaned.slice(cleaned.length - OUTPUT_EXCERPT_MAX_CHARS);
}

function extractReportUrl(text) {
  const cleaned = sanitizeOutputText(text);
  const matches = cleaned.match(REPORT_URL_RE);
  if (!matches || !matches.length) return '';
  return String(matches[matches.length - 1] || '').trim();
}

function interpretIpqualityScriptResult({ code, signal, timedOut, outputText, timeoutSeconds }) {
  if (timedOut) {
    return {
      ok: false,
      error: `ipquality timed out after ${timeoutSeconds}s`
    };
  }

  const reportUrl = extractReportUrl(outputText);
  if (reportUrl) {
    return {
      ok: true,
      reportUrl
    };
  }

  if (code !== 0) {
    const detail = code == null ? `signal ${String(signal || 'unknown')}` : `exit code ${code}`;
    return {
      ok: false,
      error: `ipquality script exited with ${detail}`
    };
  }

  return {
    ok: false,
    error: 'ipquality report url not found'
  };
}

function spawnIpqualityProcess(config) {
  return spawn('/bin/bash', [config.ipqualityScriptPath, '-4', '-n'], {
    detached: USE_DETACHED_PROCESS_GROUP,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function signalIpqualityProcess(child, signal) {
  if (!child || child.killed) return;

  if (USE_DETACHED_PROCESS_GROUP && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (err) {
      if (err && err.code === 'ESRCH') return;
    }
  }

  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

function throwIpqualityStateFileError(message) {
  throw new StateFileError(message);
}

async function runIpqualityScript(config, { runId }) {
  return new Promise((resolve) => {
    let stdoutText = '';
    let stderrText = '';
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    let timeoutTimer = null;
    let child = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        ...result,
        outputText: `${stdoutText}\n${stderrText}`.trim()
      });
    };

    try {
      child = spawnIpqualityProcess(config);
    } catch (err) {
      finish({
        ok: false,
        error: `failed to spawn ipquality script: ${String(err && err.message ? err.message : err)}`
      });
      return;
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalIpqualityProcess(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        signalIpqualityProcess(child, 'SIGKILL');
      }, FORCE_KILL_GRACE_MS);
    }, Math.max(Number(config.ipqualityTimeoutSeconds || 0) * 1000, 1000));

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdoutText = appendChunk(stdoutText, chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrText = appendChunk(stderrText, chunk);
      });
    }

    child.once('error', (err) => {
      finish({
        ok: false,
        error: `failed to spawn ipquality script: ${String(err && err.message ? err.message : err)}`
      });
    });

    child.once('close', (code, signal) => {
      finish(interpretIpqualityScriptResult({
        code,
        signal,
        timedOut,
        outputText: `${stdoutText}\n${stderrText}`,
        timeoutSeconds: config.ipqualityTimeoutSeconds
      }));
    });
  });
}

async function runIpqualityInBackground(config, { runId }) {
  console.log(`[changeip-http] starting ipquality run: run_id=${runId}`);

  const startedResult = await runIpqualityScript(config, { runId });
  const nowIso = new Date().toISOString();
  const stdoutExcerpt = buildOutputExcerpt(startedResult.outputText);

  if (!startedResult.ok) {
    const failed = failIpqualityRun(config, runId, {
      failedAt: nowIso,
      error: startedResult.error,
      stdoutExcerpt
    });
    if (!failed.ok) {
      if (failed.mismatch) {
        console.error(`[changeip-http] ipquality failure state discarded due to current_run mismatch: run_id=${runId}`);
        return;
      } else {
        console.error(`[changeip-http] ipquality failure state persist error: ${failed.error}`);
        recordIpqualityRunFailed(failed.error);
        throwIpqualityStateFileError(failed.error);
      }
    }
    recordIpqualityRunFailed(startedResult.error);
    console.error(`[changeip-http] ipquality run failed: run_id=${runId} error=${startedResult.error}`);
    return;
  }

  const completed = completeIpqualityRun(config, runId, {
    checkedAt: nowIso,
    reportUrl: startedResult.reportUrl,
    stdoutExcerpt
  });
  if (!completed.ok) {
    if (completed.mismatch) {
      console.error(`[changeip-http] ipquality success state discarded due to current_run mismatch: run_id=${runId}`);
      return;
    }
    recordIpqualityRunFailed(completed.error);
    console.error(`[changeip-http] ipquality success state persist error: ${completed.error}`);
    throwIpqualityStateFileError(completed.error);
  }

  recordIpqualityRunSucceeded();
  console.log(`[changeip-http] ipquality run succeeded: run_id=${runId} report_url=${startedResult.reportUrl}`);
}

module.exports = {
  runIpqualityInBackground,
  _test: {
    buildOutputExcerpt,
    extractReportUrl,
    interpretIpqualityScriptResult,
    sanitizeOutputText
  }
};
