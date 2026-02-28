const { hasOwn, isObject, normalizeExpectedStatus } = require('../../common');
const { compileTemplateText, compileTemplateValue } = require('../../template');
const { ensureNonEmptyText, parseStrictInt } = require('../shared');
const { parseBoolean } = require('./boolean');

function compileRequestStep(step, label, state) {
  const method = String(step.method || 'GET').trim().toUpperCase();
  if (!method) throw new Error(`${label}.method is empty`);
  if (!hasOwn(step, 'url')) throw new Error(`${label}.url is required`);

  const urlTemplate = compileTemplateText(step.url, {
    availableVars: state.availableVars,
    env: state.env,
    label: `${label}.url`
  });

  let headers = [];
  if (step.headers !== undefined) {
    if (!isObject(step.headers)) throw new Error(`${label}.headers must be an object`);
    headers = Object.entries(step.headers).map(([headerNameRaw, headerValue]) => {
      const headerName = ensureNonEmptyText(headerNameRaw, `${label}.headers key`);
      const valueTemplate = compileTemplateValue(headerValue, {
        availableVars: state.availableVars,
        env: state.env,
        label: `${label}.headers.${headerName}`
      });
      return { name: headerName, valueTemplate };
    });
  }

  const bodyFields = ['body', 'json', 'form'].filter((k) => hasOwn(step, k));
  if (bodyFields.length > 1) {
    throw new Error(`${label} uses mutually exclusive fields: body/json/form`);
  }

  let bodyMode = 'none';
  let bodyValueTemplate = null;
  if (hasOwn(step, 'json')) {
    bodyMode = 'json';
    bodyValueTemplate = compileTemplateValue(step.json, {
      availableVars: state.availableVars,
      env: state.env,
      label: `${label}.json`
    });
  } else if (hasOwn(step, 'form')) {
    if (!isObject(step.form)) throw new Error(`${label}.form must be an object`);
    bodyMode = 'form';
    const formEntries = [];
    for (const [formKeyRaw, formValue] of Object.entries(step.form)) {
      const formKey = ensureNonEmptyText(formKeyRaw, `${label}.form key`);
      formEntries.push({
        key: formKey,
        valueTemplate: compileTemplateValue(formValue, {
          availableVars: state.availableVars,
          env: state.env,
          label: `${label}.form.${formKey}`
        })
      });
    }
    bodyValueTemplate = formEntries;
  } else if (hasOwn(step, 'body')) {
    bodyMode = 'body';
    bodyValueTemplate = compileTemplateValue(step.body, {
      availableVars: state.availableVars,
      env: state.env,
      label: `${label}.body`
    });
  }

  const followRedirects = hasOwn(step, 'follow_redirects')
    ? parseBoolean(step.follow_redirects, `${label}.follow_redirects`)
    : null;
  const retries = parseStrictInt(step.retries, 0, {
    min: 0,
    max: 10,
    label: `${label}.retries`
  });
  const retryDelayMs = parseStrictInt(step.retry_delay_ms, 800, {
    min: 0,
    max: 60000,
    label: `${label}.retry_delay_ms`
  });
  const allowNetworkError = hasOwn(step, 'allow_network_error')
    ? parseBoolean(step.allow_network_error, `${label}.allow_network_error`)
    : false;
  const timeoutMs = parseStrictInt(step.timeout_ms, null, {
    min: 100,
    max: 120000,
    label: `${label}.timeout_ms`
  });
  const maxRedirects = parseStrictInt(step.max_redirects, null, {
    min: 0,
    max: 20,
    label: `${label}.max_redirects`
  });
  const expectStatus = normalizeExpectedStatus(step.expect_status);

  let userAgentTemplate = null;
  if (hasOwn(step, 'user_agent')) {
    userAgentTemplate = compileTemplateText(step.user_agent, {
      availableVars: state.availableVars,
      env: state.env,
      label: `${label}.user_agent`
    });
  }

  const saveBodyAs = hasOwn(step, 'save_body_as')
    ? ensureNonEmptyText(step.save_body_as, `${label}.save_body_as`)
    : '';
  const saveStatusAs = hasOwn(step, 'save_status_as')
    ? ensureNonEmptyText(step.save_status_as, `${label}.save_status_as`)
    : '';

  let saveHeadersAs = [];
  if (hasOwn(step, 'save_headers_as')) {
    if (!isObject(step.save_headers_as)) {
      throw new Error(`${label}.save_headers_as must be an object`);
    }
    saveHeadersAs = Object.entries(step.save_headers_as).map(([varNameRaw, headerRaw]) => {
      const varName = ensureNonEmptyText(varNameRaw, `${label}.save_headers_as var`);
      const headerTemplate = compileTemplateText(headerRaw, {
        availableVars: state.availableVars,
        env: state.env,
        label: `${label}.save_headers_as.${varName}`
      });
      return { varName, headerTemplate };
    });
  }

  if (saveBodyAs) state.availableVars.add(saveBodyAs);
  if (saveStatusAs) state.availableVars.add(saveStatusAs);
  for (const item of saveHeadersAs) state.availableVars.add(item.varName);

  return {
    type: 'request',
    label,
    method,
    urlTemplate,
    headers,
    bodyMode,
    bodyValueTemplate,
    followRedirects,
    retries,
    retryDelayMs,
    allowNetworkError,
    timeoutMs,
    maxRedirects,
    expectStatus,
    userAgentTemplate,
    saveBodyAs,
    saveStatusAs,
    saveHeadersAs
  };
}

module.exports = {
  compileRequestStep
};
