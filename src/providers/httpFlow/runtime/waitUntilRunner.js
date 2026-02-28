const { sleep } = require('./shared');

async function executeWaitUntilStep(step, ctx, defaults, env, { executeRequestStep, executeAssertStep }) {
  const deadlineMs = Date.now() + step.timeoutMs;
  let lastError = null;

  while (Date.now() <= deadlineMs) {
    try {
      await executeRequestStep(step.requestStep, ctx, defaults, env, { deadlineMs });
      if (Date.now() > deadlineMs) {
        throw new Error('wait_until deadline exceeded');
      }

      await executeAssertStep(step.assertStep, ctx, env);
      if (Date.now() > deadlineMs) {
        throw new Error('wait_until deadline exceeded');
      }

      return;
    } catch (err) {
      lastError = err;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(step.intervalMs, remainingMs));
    }
  }

  const detail = String(lastError && lastError.message ? lastError.message : lastError || 'condition not met');
  throw new Error(`wait_until timeout after ${step.timeoutMs}ms: ${detail}`);
}

module.exports = {
  executeWaitUntilStep
};
