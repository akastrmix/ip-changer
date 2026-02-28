const { hasOwn } = require('../../common');
const { ensureNonEmptyText, parseStrictInt, compileRegexSpec } = require('../shared');
const { parseBoolean } = require('./boolean');
const { compileSource } = require('./source');

function compileExtractStep(step, label, state) {
  const to = ensureNonEmptyText(step.to, `${label}.to`);
  const source = compileSource(step, label, 'extract', state);
  const regex = compileRegexSpec(step.regex, step.flags, {
    availableVars: state.availableVars,
    env: state.env,
    label
  });
  const group = parseStrictInt(step.group, 1, {
    min: 0,
    max: 20,
    label: `${label}.group`
  });
  const trim = hasOwn(step, 'trim')
    ? parseBoolean(step.trim, `${label}.trim`)
    : true;
  const decodeUriComponent = hasOwn(step, 'decode_uri_component')
    ? parseBoolean(step.decode_uri_component, `${label}.decode_uri_component`)
    : false;

  state.availableVars.add(to);
  return {
    type: 'extract',
    label,
    to,
    source,
    regex,
    group,
    trim,
    decodeUriComponent
  };
}

module.exports = {
  compileExtractStep
};
