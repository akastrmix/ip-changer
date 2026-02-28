const { hasOwn } = require('../../common');
const { compileTemplateValue } = require('../../template');
const { compileRegexSpec } = require('../shared');
const { parseBoolean } = require('./boolean');
const { compileSource } = require('./source');

function compileAssertStep(step, label, state) {
  const source = compileSource(step, label, 'assert', state);
  const ops = ['exists', 'equals', 'includes', 'regex'].filter((k) => hasOwn(step, k));
  if (ops.length !== 1) {
    throw new Error(`${label} must contain exactly one assertion: exists/equals/includes/regex`);
  }
  const op = ops[0];

  if (op === 'exists') {
    const expected = parseBoolean(step.exists, `${label}.exists`);
    return {
      type: 'assert',
      label,
      source,
      op: 'exists',
      expected
    };
  }
  if (op === 'equals') {
    return {
      type: 'assert',
      label,
      source,
      op: 'equals',
      expectedTemplate: compileTemplateValue(step.equals, {
        availableVars: state.availableVars,
        env: state.env,
        label: `${label}.equals`
      })
    };
  }
  if (op === 'includes') {
    return {
      type: 'assert',
      label,
      source,
      op: 'includes',
      expectedTemplate: compileTemplateValue(step.includes, {
        availableVars: state.availableVars,
        env: state.env,
        label: `${label}.includes`
      })
    };
  }
  return {
    type: 'assert',
    label,
    source,
    op: 'regex',
    regex: compileRegexSpec(step.regex, step.flags, {
      availableVars: state.availableVars,
      env: state.env,
      label
    })
  };
}

module.exports = {
  compileAssertStep
};
