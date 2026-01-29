const fs = require('fs');
const { spawn } = require('child_process');

const { fetchPublicIpv4, isValidIpv4 } = require('./ipv4');
const { loadIpState, saveIpState, loadPendingChange, savePendingChange, clearPendingChange } = require('./state');
const { makeChangeOpId } = require('./opId');
const { postIpEvent } = require('./events');

function scheduleReboot(config) {
  if (config.rebootDelayMinutes === -1) {
    console.log('[changeip-http] reboot disabled (REBOOT_DELAY_MINUTES=-1)');
    return { scheduled: false, delayMinutes: -1 };
  }

  const delayMinutes = Math.max(config.rebootDelayMinutes, 1);
  console.log(`[changeip-http] scheduling reboot in ${delayMinutes} minutes...`);

  const proc = spawn(config.shutdownBin, ['-r', `+${delayMinutes}`], {
    stdio: 'ignore',
    detached: true
  });
  proc.on('error', (err) => {
    console.error('[changeip-http] failed to schedule reboot:', String(err));
  });
  proc.unref();
  return { scheduled: true, delayMinutes };
}

function validateScriptReadable(scriptPath) {
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: 'changeip script not found' };
  }
  try {
    fs.accessSync(scriptPath, fs.constants.R_OK);
  } catch {
    return { ok: false, error: 'changeip script not readable' };
  }
  return { ok: true, error: '' };
}

async function trySendChangeStarted(config, pending) {
  const payload = {
    server_label: config.serverLabel,
    channel: config.reportChannel,
    op_id: pending.op_id,
    ts: pending.started_at,
    event: 'change_started'
  };
  if (isValidIpv4(pending.old_ipv4)) {
    payload.old_ipv4 = pending.old_ipv4;
  }

  const result = await postIpEvent(config, payload);
  if (result.ok) {
    pending.started_sent = true;
    pending.last_error = '';
    savePendingChange(config, pending);
  } else {
    pending.last_error = result.error || pending.last_error || '';
    savePendingChange(config, pending);
  }
}

async function triggerChangeIp(config) {
  if (!config.changeipEnabled) {
    return { status: 403, body: { ok: false, error: 'changeip disabled' } };
  }
  if (!config.ipEventsActive) {
    return { status: 500, body: { ok: false, error: 'ip events not configured' } };
  }

  const inFlight = loadPendingChange(config);
  if (inFlight?.op_id) {
    return {
      status: 409,
      body: { ok: false, error: 'change already in progress', op_id: String(inFlight.op_id) }
    };
  }

  const scriptCheck = validateScriptReadable(config.changeipScript);
  if (!scriptCheck.ok) {
    return { status: 500, body: { ok: false, error: scriptCheck.error } };
  }

  const startedAt = new Date();
  const opId = makeChangeOpId(config.serverLabel, startedAt);

  const state = loadIpState(config);
  let oldIpv4 = isValidIpv4(state.notified_ipv4) ? state.notified_ipv4 : null;
  if (!oldIpv4) {
    try {
      const observed = await fetchPublicIpv4({ userAgent: 'ip-changer', timeoutMs: 2000 });
      if (isValidIpv4(observed)) {
        oldIpv4 = observed;
        state.notified_ipv4 = observed;
        state.observed_ipv4 = observed;
        state.updated_at = startedAt.toISOString();
        saveIpState(config, state);
      }
    } catch {
      // ignore: will be handled later if old_ipv4 stays unknown
    }
  }

  // Start monitoring only after the scheduled reboot window (if any),
  // otherwise we might observe the pre-reboot IPv4 and incorrectly conclude "no_change".
  const rebootDelayMs = config.rebootDelayMinutes === -1 ? 0 : Math.max(config.rebootDelayMinutes, 1) * 60 * 1000;
  const monitorAfterMs = startedAt.getTime() + rebootDelayMs + config.changeMonitorStartDelaySeconds * 1000;
  const timeoutAtMs = monitorAfterMs + config.changeMonitorTimeoutSeconds * 1000;

  const pending = {
    op_id: opId,
    server_label: config.serverLabel,
    channel: config.reportChannel,
    old_ipv4: oldIpv4,
    started_at: startedAt.toISOString(),
    reboot_delay_minutes: config.rebootDelayMinutes,
    started_sent: false,
    monitor_after_ms: monitorAfterMs,
    timeout_at_ms: timeoutAtMs,
    last_error: ''
  };
  savePendingChange(config, pending);

  void trySendChangeStarted(config, pending).catch((err) => {
    console.error('[changeip-http] change_started report error:', String(err));
  });

  console.log(`[changeip-http] starting changeip script: ${config.changeipScript} ...`);

  let proc;
  try {
    proc = spawn('/bin/bash', [config.changeipScript], {
      stdio: 'ignore',
      detached: true
    });
  } catch (err) {
    console.error('[changeip-http] failed to spawn changeip script:', err);
    try {
      await postIpEvent(config, {
        server_label: config.serverLabel,
        channel: config.reportChannel,
        op_id: opId,
        ts: new Date().toISOString(),
        event: 'change_failed',
        reason: 'spawn_failed',
        ...(oldIpv4 ? { old_ipv4: oldIpv4 } : {})
      });
    } catch (reportErr) {
      console.error('[changeip-http] change_failed report error:', String(reportErr));
    }
    clearPendingChange(config);
    return { status: 500, body: { ok: false, error: 'failed to spawn changeip script' } };
  }

  proc.on('error', (err) => {
    console.error('[changeip-http] failed to start changeip script:', err);
  });
  proc.unref();

  const reboot = scheduleReboot(config);

  return {
    status: 200,
    body: {
      ok: true,
      op_id: opId,
      message: reboot.scheduled
        ? `changeip started, reboot scheduled in ${reboot.delayMinutes} minutes`
        : 'changeip started, reboot disabled',
      server_label: config.serverLabel,
      channel: config.reportChannel,
      old_ipv4: oldIpv4,
      reboot_scheduled: reboot.scheduled,
      reboot_delay_minutes: reboot.scheduled ? reboot.delayMinutes : -1
    }
  };
}

module.exports = {
  triggerChangeIp
};
