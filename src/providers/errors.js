const PROVIDER_ERROR_CODES = Object.freeze({
  UNSUPPORTED: 'provider.unsupported',
  CONFIG_INVALID: 'provider.config_invalid',
  SPAWN_FAILED: 'provider.spawn_failed',
  EXITED_EARLY: 'provider.exited_early',
  RUNTIME_FAILED: 'provider.runtime_failed'
});

function defaultReasonForCode(code) {
  if (code === PROVIDER_ERROR_CODES.UNSUPPORTED) return 'unsupported_provider';
  if (code === PROVIDER_ERROR_CODES.CONFIG_INVALID) return 'provider_config_invalid';
  if (code === PROVIDER_ERROR_CODES.SPAWN_FAILED) return 'provider_spawn_failed';
  if (code === PROVIDER_ERROR_CODES.EXITED_EARLY) return 'provider_exited_early';
  if (code === PROVIDER_ERROR_CODES.RUNTIME_FAILED) return 'provider_runtime_failed';
  return 'provider_error';
}

function providerFailure({ code, error, detail = '', reason = '' }) {
  const normalizedCode = String(code || PROVIDER_ERROR_CODES.RUNTIME_FAILED);
  const payload = {
    ok: false,
    code: normalizedCode,
    reason: reason || defaultReasonForCode(normalizedCode),
    error: String(error || 'provider failed')
  };
  if (detail) payload.detail = String(detail);
  return payload;
}

function providerSuccess(extra = {}) {
  return { ok: true, ...extra };
}

module.exports = {
  PROVIDER_ERROR_CODES,
  defaultReasonForCode,
  providerFailure,
  providerSuccess
};
