'use strict';

const {
  StateFileError,
  loadOptionalJsonObjectFile,
  saveJsonObjectFileAtomic
} = require('../state');

const RUN_STATUS_RUNNING = 'running';

function ensurePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StateFileError(`${label} must be an object`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  const text = String(value || '').trim();
  if (!text) {
    throw new StateFileError(`${label} must be a non-empty string`);
  }
  return text;
}

function optionalString(value) {
  return String(value || '').trim();
}

function normalizeCurrentRun(currentRunRaw) {
  if (currentRunRaw == null) return null;
  const currentRun = ensurePlainObject(currentRunRaw, 'ipquality current_run');
  const status = requireNonEmptyString(currentRun.status, 'ipquality current_run.status');
  if (status !== RUN_STATUS_RUNNING) {
    throw new StateFileError(`ipquality current_run.status must be ${RUN_STATUS_RUNNING}`);
  }
  return {
    run_id: requireNonEmptyString(currentRun.run_id, 'ipquality current_run.run_id'),
    status,
    started_at: requireNonEmptyString(currentRun.started_at, 'ipquality current_run.started_at')
  };
}

function normalizeLastSuccess(lastSuccessRaw) {
  if (lastSuccessRaw == null) return null;
  const lastSuccess = ensurePlainObject(lastSuccessRaw, 'ipquality last_success');
  return {
    run_id: requireNonEmptyString(lastSuccess.run_id, 'ipquality last_success.run_id'),
    checked_at: requireNonEmptyString(lastSuccess.checked_at, 'ipquality last_success.checked_at'),
    report_url: requireNonEmptyString(lastSuccess.report_url, 'ipquality last_success.report_url'),
    stdout_excerpt: optionalString(lastSuccess.stdout_excerpt)
  };
}

function normalizeLastFailure(lastFailureRaw) {
  if (lastFailureRaw == null) return null;
  const lastFailure = ensurePlainObject(lastFailureRaw, 'ipquality last_failure');
  return {
    run_id: requireNonEmptyString(lastFailure.run_id, 'ipquality last_failure.run_id'),
    failed_at: requireNonEmptyString(lastFailure.failed_at, 'ipquality last_failure.failed_at'),
    error: requireNonEmptyString(lastFailure.error, 'ipquality last_failure.error'),
    stdout_excerpt: optionalString(lastFailure.stdout_excerpt)
  };
}

function createEmptyIpqualityState() {
  return {
    current_run: null,
    last_success: null,
    last_failure: null,
    updated_at: ''
  };
}

function normalizeIpqualityState(raw) {
  const source = raw == null ? {} : ensurePlainObject(raw, 'ipquality state file');
  return {
    current_run: normalizeCurrentRun(source.current_run),
    last_success: normalizeLastSuccess(source.last_success),
    last_failure: normalizeLastFailure(source.last_failure),
    updated_at: optionalString(source.updated_at)
  };
}

function saveIpqualityState(config, state) {
  return saveJsonObjectFileAtomic(config.ipqualityStateFile, state);
}

function loadIpqualityState(config, { repairStaleRunning = false } = {}) {
  if (!config.ipqualityEnabled) return createEmptyIpqualityState();

  const result = loadOptionalJsonObjectFile(config.ipqualityStateFile, 'ipquality state file');
  const state = result.exists ? normalizeIpqualityState(result.value) : createEmptyIpqualityState();

  if (repairStaleRunning && state.current_run) {
    const nowIso = new Date().toISOString();
    const repaired = {
      current_run: null,
      last_success: state.last_success,
      last_failure: {
        run_id: state.current_run.run_id,
        failed_at: nowIso,
        error: 'service_restarted_during_ipquality_run',
        stdout_excerpt: ''
      },
      updated_at: nowIso
    };
    const saved = saveIpqualityState(config, repaired);
    if (!saved.ok) {
      throw new StateFileError(`failed to save ipquality state file ${config.ipqualityStateFile}: ${saved.error}`);
    }
    return repaired;
  }

  return state;
}

function startIpqualityRun(config, { runId, startedAt }) {
  const state = loadIpqualityState(config);
  if (state.current_run?.run_id) {
    return {
      ok: false,
      conflict: true,
      state
    };
  }

  const nextState = {
    current_run: {
      run_id: requireNonEmptyString(runId, 'ipquality run_id'),
      status: RUN_STATUS_RUNNING,
      started_at: requireNonEmptyString(startedAt, 'ipquality started_at')
    },
    last_success: state.last_success,
    last_failure: state.last_failure,
    updated_at: requireNonEmptyString(startedAt, 'ipquality started_at')
  };
  const saved = saveIpqualityState(config, nextState);
  if (!saved.ok) {
    return {
      ok: false,
      conflict: false,
      error: `failed to persist ipquality run: ${saved.error}`
    };
  }
  return {
    ok: true,
    state: nextState
  };
}

function completeIpqualityRun(config, runId, { checkedAt, reportUrl, stdoutExcerpt = '' }) {
  const state = loadIpqualityState(config);
  const currentRunId = String(state.current_run?.run_id || '').trim();
  if (!currentRunId || currentRunId !== String(runId || '').trim()) {
    return {
      ok: false,
      mismatch: true,
      error: 'ipquality current_run mismatch'
    };
  }

  const nextState = {
    current_run: null,
    last_success: {
      run_id: currentRunId,
      checked_at: requireNonEmptyString(checkedAt, 'ipquality checked_at'),
      report_url: requireNonEmptyString(reportUrl, 'ipquality report_url'),
      stdout_excerpt: optionalString(stdoutExcerpt)
    },
    last_failure: null,
    updated_at: requireNonEmptyString(checkedAt, 'ipquality checked_at')
  };
  const saved = saveIpqualityState(config, nextState);
  if (!saved.ok) {
    return {
      ok: false,
      mismatch: false,
      error: `failed to persist ipquality success state: ${saved.error}`
    };
  }
  return {
    ok: true,
    state: nextState
  };
}

function failIpqualityRun(config, runId, { failedAt, error, stdoutExcerpt = '' }) {
  const state = loadIpqualityState(config);
  const currentRunId = String(state.current_run?.run_id || '').trim();
  if (!currentRunId || currentRunId !== String(runId || '').trim()) {
    return {
      ok: false,
      mismatch: true,
      error: 'ipquality current_run mismatch'
    };
  }

  const nextState = {
    current_run: null,
    last_success: state.last_success,
    last_failure: {
      run_id: currentRunId,
      failed_at: requireNonEmptyString(failedAt, 'ipquality failed_at'),
      error: requireNonEmptyString(error, 'ipquality error'),
      stdout_excerpt: optionalString(stdoutExcerpt)
    },
    updated_at: requireNonEmptyString(failedAt, 'ipquality failed_at')
  };
  const saved = saveIpqualityState(config, nextState);
  if (!saved.ok) {
    return {
      ok: false,
      mismatch: false,
      error: `failed to persist ipquality failure state: ${saved.error}`
    };
  }
  return {
    ok: true,
    state: nextState
  };
}

module.exports = {
  RUN_STATUS_RUNNING,
  completeIpqualityRun,
  createEmptyIpqualityState,
  failIpqualityRun,
  loadIpqualityState,
  startIpqualityRun,
  _test: {
    normalizeIpqualityState
  }
};
