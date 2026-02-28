const { isObject } = require('../../common');
const { compileRequestStep } = require('./request');
const { compileWaitUntilStep } = require('./waitUntil');
const { compileExtractStep } = require('./extract');
const { compileAssertStep } = require('./assert');
const { compileSleepStep } = require('./sleep');
const { compileSetStep } = require('./set');

function compileStep(step, index, state) {
  if (!isObject(step)) throw new Error(`step ${index + 1}: step must be an object`);
  const type = String(step.type || '').trim().toLowerCase();
  const name = String(step.name || '').trim();
  const label = `step ${index + 1}${name ? ` (${name})` : ''}`;
  if (!type) throw new Error(`${label}: missing type`);

  if (type === 'request') return compileRequestStep(step, label, state);
  if (type === 'wait_until') return compileWaitUntilStep(step, label, state);
  if (type === 'extract') return compileExtractStep(step, label, state);
  if (type === 'assert') return compileAssertStep(step, label, state);
  if (type === 'sleep') return compileSleepStep(step, label);
  if (type === 'set') return compileSetStep(step, label, state);
  throw new Error(`${label}: unsupported step type: ${type}`);
}

module.exports = {
  compileStep
};
