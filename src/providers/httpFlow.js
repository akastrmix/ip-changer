const fs = require('fs');

const { probeAsyncTaskStart, validateReadableRegularFile } = require('./utils');
const { compileFlowFromFile } = require('./httpFlow/compile');
const { runCompiledFlow } = require('./httpFlow/runtime');
const { PROVIDER_ERROR_CODES, providerFailure, providerSuccess } = require('./errors');
const { markChangeSessionProviderRuntimeFailed } = require('../change/session');

const COMPILE_CACHE = new Map();
const FLOW_START_PROBE_MS = 1500;

function validate(config) {
  return validateReadableRegularFile(config.changeipHttpFlowFile, {
    emptyError: 'changeip http_flow file path is empty',
    notAbsoluteError: 'changeip http_flow file path must be absolute',
    notFoundError: 'changeip http_flow file not found',
    notRegularFileError: 'changeip http_flow file is not a regular file',
    notReadableError: 'changeip http_flow file not readable'
  });
}

function resolveCompileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const mtime = Number.isFinite(stat.mtimeMs) ? Math.trunc(stat.mtimeMs) : 0;
    return { ok: true, signature: `${mtime}:${stat.size}` };
  } catch (err) {
    return { ok: false, error: `failed to stat http_flow file: ${String(err)}` };
  }
}

function compileFlowWithCache(filePath, env) {
  const sig = resolveCompileSignature(filePath);
  if (!sig.ok) return sig;

  const cached = COMPILE_CACHE.get(filePath);
  if (cached && cached.signature === sig.signature) {
    return { ok: true, flow: cached.flow, cacheHit: true };
  }

  const compiled = compileFlowFromFile(filePath, env);
  if (!compiled.ok) return compiled;

  COMPILE_CACHE.set(filePath, {
    signature: sig.signature,
    flow: compiled.flow
  });
  return { ok: true, flow: compiled.flow, cacheHit: false };
}

async function start(config, ctx = {}) {
  const check = validate(config);
  if (!check.ok) {
    return providerFailure({
      code: PROVIDER_ERROR_CODES.CONFIG_INVALID,
      error: check.error,
      reason: 'provider_config_invalid'
    });
  }

  const compiled = compileFlowWithCache(check.value, process.env);
  if (!compiled.ok) {
    return providerFailure({
      code: PROVIDER_ERROR_CODES.CONFIG_INVALID,
      error: compiled.error,
      reason: 'provider_config_invalid'
    });
  }

  const runtimePromise = runCompiledFlow(compiled.flow, process.env);
  const probe = await probeAsyncTaskStart(runtimePromise, {
    graceMs: FLOW_START_PROBE_MS,
    onLateError: (err) => {
      const detail = String(err && err.message ? err.message : err);
      console.error(`[changeip-http] background http_flow runtime error: ${detail}`);
      const opId = String(ctx?.opId || '').trim();
      if (opId) {
        markChangeSessionProviderRuntimeFailed(config, opId, {
          reason: 'http_flow_failed',
          reportError: detail
        });
      }
    }
  });
  if (!probe.ok) {
    return providerFailure({
      code: PROVIDER_ERROR_CODES.RUNTIME_FAILED,
      reason: 'http_flow_failed',
      error: 'changeip http_flow flow failed',
      detail: probe.detail
    });
  }

  return providerSuccess({
    start_mode: 'background',
    completed_in_grace: !!probe.completedInGrace
  });
}

module.exports = {
  name: 'http_flow',
  validate,
  start
};
