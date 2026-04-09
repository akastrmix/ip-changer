'use strict';

const fs = require('fs');
const path = require('path');

const { makeIpQualityRunId } = require('../opId');
const {
  recordIpqualityRequest,
  recordIpqualityRunStarted
} = require('../runtime/metrics');
const { isStateFileError } = require('../state');
const {
  loadIpqualityState,
  startIpqualityRun
} = require('./state');
const { runIpqualityInBackground } = require('./runner');

let FATAL_IPQUALITY_EXIT_SCHEDULED = false;

function scheduleFatalIpqualityExit(reason, err) {
  console.error(`[changeip-http] fatal ipquality error: ${reason}: ${String(err || 'unknown')}`);
  if (FATAL_IPQUALITY_EXIT_SCHEDULED) return;
  FATAL_IPQUALITY_EXIT_SCHEDULED = true;
  setImmediate(() => process.exit(1));
}

function createResponder() {
  return (status, body, outcome) => {
    recordIpqualityRequest(outcome);
    return { status, body };
  };
}

function validateIpqualityScriptPath(config) {
  const filePath = String(config.ipqualityScriptPath || '').trim();
  if (!filePath) {
    return { ok: false, error: 'ipquality script path is empty' };
  }
  if (!path.isAbsolute(filePath)) {
    return { ok: false, error: 'ipquality script path must be absolute' };
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, error: 'ipquality script not found' };
  }
  if (!stat.isFile()) {
    return { ok: false, error: 'ipquality script is not a regular file' };
  }
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    return { ok: false, error: 'ipquality script not readable' };
  }
  return { ok: true, value: filePath };
}

function buildIpqualityStatusBody(config, state) {
  const lastSuccess = state.last_success ? {
    run_id: state.last_success.run_id,
    checked_at: state.last_success.checked_at,
    report_url: state.last_success.report_url
  } : null;
  const lastFailure = state.last_failure ? {
    run_id: state.last_failure.run_id,
    failed_at: state.last_failure.failed_at,
    error: state.last_failure.error
  } : null;
  return {
    ok: true,
    ipquality_enabled: config.ipqualityEnabled,
    server_label: config.serverLabel,
    current_run: state.current_run,
    last_success: lastSuccess,
    last_failure: lastFailure
  };
}

function getIpqualityStatus(config) {
  const state = config.ipqualityEnabled ? loadIpqualityState(config) : {
    current_run: null,
    last_success: null,
    last_failure: null
  };
  return {
    status: 200,
    body: buildIpqualityStatusBody(config, state)
  };
}

function scheduleIpqualityRunner(config, runId) {
  try {
    const schedule = () => runIpqualityInBackground(config, { runId }).catch((err) => {
      console.error('[changeip-http] async ipquality runner failed:', String(err || 'unknown'));
      if (isStateFileError(err)) {
        scheduleFatalIpqualityExit('state file became unreadable/corrupt during ipquality run', err);
      }
    });
    if (typeof setImmediate === 'function') {
      setImmediate(schedule);
    } else {
      schedule();
    }
  } catch (err) {
    console.error('[changeip-http] failed to schedule ipquality runner:', String(err || 'unknown'));
    if (isStateFileError(err)) {
      scheduleFatalIpqualityExit('failed to schedule ipquality runner due to state file error', err);
    }
  }
}

function triggerIpquality(config) {
  const respond = createResponder();

  if (!config.ipqualityEnabled) {
    return respond(403, { ok: false, error: 'ipquality disabled' }, 'disabled');
  }

  const state = loadIpqualityState(config);
  if (state.current_run?.run_id) {
    return respond(200, {
      ok: true,
      state: 'running',
      server_label: config.serverLabel,
      run_id: state.current_run.run_id,
      started_at: state.current_run.started_at
    }, 'running');
  }

  const scriptCheck = validateIpqualityScriptPath(config);
  if (!scriptCheck.ok) {
    return respond(500, { ok: false, error: scriptCheck.error }, 'config_invalid');
  }

  const startedAt = new Date();
  const runId = makeIpQualityRunId(config.serverLabel, startedAt);
  const started = startIpqualityRun(config, {
    runId,
    startedAt: startedAt.toISOString()
  });
  if (!started.ok) {
    if (started.conflict && started.state?.current_run?.run_id) {
      return respond(200, {
        ok: true,
        state: 'running',
        server_label: config.serverLabel,
        run_id: started.state.current_run.run_id,
        started_at: started.state.current_run.started_at
      }, 'running');
    }
    return respond(500, { ok: false, error: started.error || 'failed to persist ipquality run' }, 'state_error');
  }

  recordIpqualityRunStarted();
  scheduleIpqualityRunner(config, runId);
  return respond(200, {
    ok: true,
    state: 'started',
    server_label: config.serverLabel,
    run_id: runId,
    started_at: startedAt.toISOString()
  }, 'started');
}

module.exports = {
  getIpqualityStatus,
  triggerIpquality,
  _test: {
    validateIpqualityScriptPath
  }
};
