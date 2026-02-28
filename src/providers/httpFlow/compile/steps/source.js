const { hasOwn } = require('../../common');
const { compileTemplateText } = require('../../template');
const { ensureNonEmptyText } = require('../shared');

function compileSource(step, label, stepType, state) {
  const from = String(step.from || 'body').trim().toLowerCase();
  if (from === 'body' || from === 'status') return { from };
  if (from === 'header') {
    if (!hasOwn(step, 'header')) {
      throw new Error(`${label}.header is required when from=header`);
    }
    return {
      from,
      headerTemplate: compileTemplateText(step.header, {
        availableVars: state.availableVars,
        env: state.env,
        label: `${label}.header`
      })
    };
  }
  if (from === 'var') {
    const varName = ensureNonEmptyText(step.var, `${label}.var`);
    if (!state.availableVars.has(varName)) {
      throw new Error(`${label}.var references unknown var: ${varName}`);
    }
    return { from, varName };
  }
  throw new Error(`${label}: unsupported ${stepType} source: ${from}`);
}

module.exports = {
  compileSource
};
