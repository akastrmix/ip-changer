const { hasOwn } = require('../../common');
const { compileTemplateValue } = require('../../template');
const { ensureNonEmptyText } = require('../shared');

function compileSetStep(step, label, state) {
  const name = ensureNonEmptyText(step.name, `${label}.name`);
  const hasFromEnv = hasOwn(step, 'from_env');
  const hasValue = hasOwn(step, 'value');
  if (hasFromEnv && hasValue) throw new Error(`${label} uses mutually exclusive fields: from_env/value`);
  if (!hasFromEnv && !hasValue) throw new Error(`${label} requires value or from_env`);

  let compiled;
  if (hasFromEnv) {
    const envName = ensureNonEmptyText(step.from_env, `${label}.from_env`);
    if (!hasOwn(state.env, envName)) {
      throw new Error(`${label}.from_env env var not found: ${envName}`);
    }
    compiled = {
      type: 'set',
      label,
      name,
      mode: 'from_env',
      envName
    };
  } else {
    compiled = {
      type: 'set',
      label,
      name,
      mode: 'value',
      valueTemplate: compileTemplateValue(step.value, {
        availableVars: state.availableVars,
        env: state.env,
        label: `${label}.value`
      })
    };
  }

  state.availableVars.add(name);
  return compiled;
}

module.exports = {
  compileSetStep
};
