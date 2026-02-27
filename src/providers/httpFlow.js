const { validateReadableRegularFile } = require('./utils');
const { compileFlowFromFile } = require('./httpFlow/compile');
const { runCompiledFlow } = require('./httpFlow/runtime');
const { PROVIDER_ERROR_CODES, providerFailure, providerSuccess } = require('./errors');

function validate(config) {
  return validateReadableRegularFile(config.changeipHttpFlowFile, {
    emptyError: 'changeip http_flow file path is empty',
    notAbsoluteError: 'changeip http_flow file path must be absolute',
    notFoundError: 'changeip http_flow file not found',
    notRegularFileError: 'changeip http_flow file is not a regular file',
    notReadableError: 'changeip http_flow file not readable'
  });
}

async function start(config) {
  const check = validate(config);
  if (!check.ok) {
    return providerFailure({
      code: PROVIDER_ERROR_CODES.CONFIG_INVALID,
      error: check.error,
      reason: 'provider_config_invalid'
    });
  }

  const compiled = compileFlowFromFile(check.value, process.env);
  if (!compiled.ok) {
    return providerFailure({
      code: PROVIDER_ERROR_CODES.CONFIG_INVALID,
      error: compiled.error,
      reason: 'provider_config_invalid'
    });
  }

  try {
    await runCompiledFlow(compiled.flow, process.env);
  } catch (err) {
    return providerFailure({
      code: PROVIDER_ERROR_CODES.RUNTIME_FAILED,
      reason: 'http_flow_failed',
      error: 'changeip http_flow flow failed',
      detail: String(err && err.message ? err.message : err)
    });
  }

  return providerSuccess();
}

module.exports = {
  name: 'http_flow',
  validate,
  start
};
