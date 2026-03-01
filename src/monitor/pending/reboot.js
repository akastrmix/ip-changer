const { spawnDetachedAndProbe } = require('../../providers/utils');

async function scheduleReboot(config, delayMinutes) {
  const delay = Number(delayMinutes);
  if (delay === -1) {
    console.log('[changeip-http] reboot disabled (REBOOT_DELAY_MINUTES=-1)');
    return { scheduled: false, delayMinutes: -1, error: '' };
  }

  const safeDelayMinutes = Math.max(parseInt(String(delay), 10) || 1, 1);
  console.log(`[changeip-http] scheduling reboot in ${safeDelayMinutes} minutes...`);

  let result;
  try {
    result = await spawnDetachedAndProbe({
      command: config.shutdownBin,
      args: ['-r', `+${safeDelayMinutes}`],
      graceMs: 800,
      spawnErrorMessage: 'failed to schedule reboot',
      earlyExitErrorMessage: 'shutdown exited early with non-zero'
    });
  } catch (err) {
    const error = String(err || 'unknown');
    console.error('[changeip-http] failed to schedule reboot:', error);
    return { scheduled: false, delayMinutes: safeDelayMinutes, error };
  }

  if (!result.ok) {
    const detail = result.detail ? ` (${result.detail})` : '';
    const error = `${result.error}${detail}`.trim();
    console.error('[changeip-http] failed to schedule reboot:', error);
    return { scheduled: false, delayMinutes: safeDelayMinutes, error };
  }

  return { scheduled: true, delayMinutes: safeDelayMinutes, error: '' };
}

module.exports = {
  scheduleReboot
};
