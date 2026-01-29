const { fetchPublicIpv4, isValidIpv4 } = require('./ipv4');
const { loadIpState, saveIpState, loadPendingChange, savePendingChange, clearPendingChange } = require('./state');
const { makeIpv4OpId } = require('./opId');
const { postIpEvent } = require('./events');

function nowIso() {
  return new Date().toISOString();
}

function buildTerminalEvent({ opId, serverLabel, channel, oldIpv4, newIpv4, event, reason }) {
  const payload = {
    server_label: serverLabel,
    channel,
    op_id: opId,
    ts: nowIso(),
    event
  };
  if (isValidIpv4(oldIpv4)) payload.old_ipv4 = oldIpv4;
  if (isValidIpv4(newIpv4)) payload.new_ipv4 = newIpv4;
  if (reason) payload.reason = reason;
  return payload;
}

async function handlePendingChange(config) {
  const pending = loadPendingChange(config);
  if (!pending?.op_id) return { handled: false };

  const opId = String(pending.op_id || '').trim();
  const serverLabel = String(pending.server_label || '').trim() || config.serverLabel;
  const channel = String(pending.channel || '').trim() || config.reportChannel;

  const startedAt = String(pending.started_at || '').trim();
  const startedAtMs = startedAt ? Date.parse(startedAt) : NaN;
  const rebootDelayMinutes =
    pending.reboot_delay_minutes === -1 || pending.reboot_delay_minutes >= 1
      ? pending.reboot_delay_minutes
      : config.rebootDelayMinutes;

  let monitorAfterMs = Number(pending.monitor_after_ms || 0);
  let timeoutAtMs = Number(pending.timeout_at_ms || 0);
  if (Number.isFinite(startedAtMs)) {
    if (rebootDelayMinutes !== -1) {
      const rebootDelayMs = Math.max(Number(rebootDelayMinutes) || 1, 1) * 60 * 1000;
      const minMonitorAfterMs = startedAtMs + rebootDelayMs + config.changeMonitorStartDelaySeconds * 1000;
      if (!monitorAfterMs || monitorAfterMs < minMonitorAfterMs) {
        monitorAfterMs = minMonitorAfterMs;
        pending.monitor_after_ms = monitorAfterMs;
        pending.timeout_at_ms = monitorAfterMs + config.changeMonitorTimeoutSeconds * 1000;
        timeoutAtMs = Number(pending.timeout_at_ms || 0);
        savePendingChange(config, pending);
      }
    }
  }

  if (!pending.started_sent && startedAt) {
    const startedPayload = {
      server_label: serverLabel,
      channel,
      op_id: opId,
      ts: startedAt,
      event: 'change_started',
      ...(isValidIpv4(pending.old_ipv4) ? { old_ipv4: pending.old_ipv4 } : {})
    };
    try {
      const r = await postIpEvent(config, startedPayload);
      if (r.ok) {
        pending.started_sent = true;
        pending.last_error = '';
        savePendingChange(config, pending);
      } else {
        pending.last_error = r.error || pending.last_error || '';
        savePendingChange(config, pending);
      }
    } catch (err) {
      pending.last_error = String(err);
      savePendingChange(config, pending);
    }
  }

  const nowMs = Date.now();
  if (monitorAfterMs && nowMs < monitorAfterMs) return { handled: true };

  let ip;
  try {
    ip = await fetchPublicIpv4({ userAgent: 'ip-changer' });
  } catch (err) {
    if (rebootDelayMinutes === -1 && !pending.offline_observed) {
      pending.offline_observed = true;
      savePendingChange(config, pending);
    }
    if (timeoutAtMs && nowMs >= timeoutAtMs) {
      const payload = buildTerminalEvent({
        opId,
        serverLabel,
        channel,
        oldIpv4: pending.old_ipv4,
        event: 'change_failed',
        reason: 'no_ipv4_observed'
      });
      try {
        const r = await postIpEvent(config, payload);
        if (r.ok) {
          clearPendingChange(config);
          return { handled: true, done: true };
        }
        pending.last_error = r.error || pending.last_error || '';
        savePendingChange(config, pending);
      } catch (postErr) {
        pending.last_error = String(postErr);
        savePendingChange(config, pending);
      }
    }
    return { handled: true };
  }

  const oldIpv4 = isValidIpv4(pending.old_ipv4) ? pending.old_ipv4 : null;
  let terminal;
  if (!oldIpv4) {
    terminal = buildTerminalEvent({
      opId,
      serverLabel,
      channel,
      newIpv4: ip,
      event: 'change_failed',
      reason: 'old_ipv4_unknown'
    });
  } else if (ip === oldIpv4) {
    if (rebootDelayMinutes === -1 && !pending.offline_observed) {
      if (timeoutAtMs && nowMs >= timeoutAtMs) {
        terminal = buildTerminalEvent({
          opId,
          serverLabel,
          channel,
          oldIpv4,
          event: 'change_no_change'
        });
      } else {
        return { handled: true };
      }
    } else {
      terminal = buildTerminalEvent({
        opId,
        serverLabel,
        channel,
        oldIpv4,
        event: 'change_no_change'
      });
    }
  } else {
    terminal = buildTerminalEvent({
      opId,
      serverLabel,
      channel,
      oldIpv4,
      newIpv4: ip,
      event: 'change_succeeded'
    });
  }

  try {
    const r = await postIpEvent(config, terminal);
    if (!r.ok) {
      pending.last_error = r.error || pending.last_error || '';
      savePendingChange(config, pending);
      return { handled: true };
    }
  } catch (err) {
    pending.last_error = String(err);
    savePendingChange(config, pending);
    return { handled: true };
  }

  const ipState = loadIpState(config);
  ipState.observed_ipv4 = ip;
  ipState.updated_at = nowIso();
  if (terminal.event === 'change_succeeded') {
    ipState.notified_ipv4 = ip;
    ipState.last_report_at = ipState.updated_at;
    ipState.last_report_error = '';
  }
  saveIpState(config, ipState);

  clearPendingChange(config);
  return { handled: true, done: true };
}

async function handleNaturalMonitor(config, lastNaturalRunMsRef) {
  if (!config.ipMonitorEnabled) return { ok: true, skipped: true };
  if (!config.ipEventsActive) return { ok: false, error: 'ip events not configured' };

  const nowMs = Date.now();
  const dueMs = (lastNaturalRunMsRef.value || 0) + config.ipMonitorIntervalSeconds * 1000;
  if (lastNaturalRunMsRef.value && nowMs < dueMs) return { ok: true, skipped: true };
  lastNaturalRunMsRef.value = nowMs;

  let ip;
  try {
    ip = await fetchPublicIpv4({ userAgent: 'ip-changer' });
  } catch (err) {
    console.error('[changeip-http] monitor error:', String(err));
    return { ok: false, error: String(err) };
  }

  const state = loadIpState(config);
  const notified = String(state.notified_ipv4 || '').trim();

  // First run: initialize baseline without reporting.
  if (!isValidIpv4(notified)) {
    state.notified_ipv4 = ip;
    state.observed_ipv4 = ip;
    state.updated_at = nowIso();
    saveIpState(config, state);
    return { ok: true, initialized: true };
  }

  if (ip === notified) return { ok: true, unchanged: true };

  const opId = makeIpv4OpId(config.serverLabel, new Date());
  const payload = {
    server_label: config.serverLabel,
    channel: config.reportChannel,
    op_id: opId,
    ts: nowIso(),
    event: 'ipv4_changed',
    old_ipv4: notified,
    new_ipv4: ip
  };

  let result;
  try {
    result = await postIpEvent(config, payload);
  } catch (err) {
    result = { ok: false, error: String(err) };
  }

  state.observed_ipv4 = ip;
  state.updated_at = nowIso();
  if (result.ok) {
    state.notified_ipv4 = ip;
    state.last_report_at = state.updated_at;
    state.last_report_error = '';
  } else {
    state.last_report_error = result.error || state.updated_at;
  }
  saveIpState(config, state);
  return { ok: result.ok };
}

function startMonitor(config) {
  if (!config.ipEventsActive) return;
  if (!config.ipMonitorEnabled && !config.changeipEnabled) {
    const pending = loadPendingChange(config);
    if (!pending?.op_id) return;
  }
  const baseIntervalSeconds = Math.max(Math.min(config.changeMonitorIntervalSeconds, config.ipMonitorIntervalSeconds), 1);
  console.log(`[changeip-http] monitor enabled: tick every ${baseIntervalSeconds}s`);

  let running = false;
  const lastNaturalRunMsRef = { value: 0 };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const pendingResult = await handlePendingChange(config);
      if (!pendingResult.handled) {
        await handleNaturalMonitor(config, lastNaturalRunMsRef);
      }
    } catch (err) {
      console.error('[changeip-http] monitor tick error:', String(err));
    } finally {
      running = false;
    }
  };

  tick();
  setInterval(tick, baseIntervalSeconds * 1000).unref();
}

module.exports = {
  startMonitor
};
