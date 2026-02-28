const { isObject } = require('../../common');
const { parseStrictInt } = require('../shared');
const { compileRequestStep } = require('./request');
const { compileAssertStep } = require('./assert');

function compileWaitUntilStep(step, label, state) {
  if (!isObject(step.request)) {
    throw new Error(`${label}.request must be an object`);
  }
  if (!isObject(step.assert)) {
    throw new Error(`${label}.assert must be an object`);
  }

  const timeoutMs = parseStrictInt(step.timeout_ms, 30000, {
    min: 100,
    max: 600000,
    label: `${label}.timeout_ms`
  });
  const intervalMs = parseStrictInt(step.interval_ms, 1000, {
    min: 50,
    max: 60000,
    label: `${label}.interval_ms`
  });

  const requestStep = compileRequestStep(step.request, `${label}.request`, state);
  if (requestStep.allowNetworkError) {
    throw new Error(`${label}.request.allow_network_error is not supported in wait_until`);
  }
  const assertStep = compileAssertStep(step.assert, `${label}.assert`, state);

  return {
    type: 'wait_until',
    label,
    timeoutMs,
    intervalMs,
    requestStep,
    assertStep
  };
}

module.exports = {
  compileWaitUntilStep
};
