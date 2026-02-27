const fs = require('fs');
const { URL } = require('url');

const { hasOwn, isObject, normalizeExpectedStatus } = require('./common');
const {
  compileTemplateText,
  compileTemplateValue,
  hasVarRefs,
  renderTemplateText
} = require('./template');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = 'ip-changer-http-flow/1.0';

function parseStrictInt(value, fallback, { min, max, label }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) throw new Error(`${label} must be an integer`);
  if (n < min || n > max) throw new Error(`${label} must be in range ${min}..${max}`);
  return n;
}

function ensureNonEmptyText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is empty`);
  return text;
}

function compileRegexSpec(rawRegex, rawFlags, { availableVars, env, label }) {
  const sourceTemplate = compileTemplateText(String(rawRegex || ''), {
    availableVars,
    env,
    label: `${label}.regex`
  });
  const flags = String(rawFlags || '');
  if (!sourceTemplate.parts.length) {
    throw new Error(`${label}.regex is empty`);
  }

  if (!hasVarRefs(sourceTemplate)) {
    const source = renderTemplateText(sourceTemplate, { vars: {}, env });
    try {
      return {
        sourceTemplate,
        flags,
        precompiled: new RegExp(source, flags)
      };
    } catch (err) {
      throw new Error(`${label}.regex invalid: ${String(err)}`);
    }
  }

  try {
    void new RegExp('', flags);
  } catch (err) {
    throw new Error(`${label}.flags invalid: ${String(err)}`);
  }
  return {
    sourceTemplate,
    flags,
    precompiled: null
  };
}

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

  const followRedirects = hasOwn(step, 'follow_redirects') ? !!step.follow_redirects : null;
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
    timeoutMs,
    maxRedirects,
    expectStatus,
    userAgentTemplate,
    saveBodyAs,
    saveStatusAs,
    saveHeadersAs
  };
}

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
  const trim = step.trim !== false;
  const decodeUriComponent = !!step.decode_uri_component;

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

function compileAssertStep(step, label, state) {
  const source = compileSource(step, label, 'assert', state);
  const ops = ['exists', 'equals', 'includes', 'regex'].filter((k) => hasOwn(step, k));
  if (ops.length !== 1) {
    throw new Error(`${label} must contain exactly one assertion: exists/equals/includes/regex`);
  }
  const op = ops[0];

  if (op === 'exists') {
    return {
      type: 'assert',
      label,
      source,
      op: 'exists',
      expected: !!step.exists
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

function compileSleepStep(step, label) {
  return {
    type: 'sleep',
    label,
    ms: parseStrictInt(step.ms, 0, {
      min: 0,
      max: 300000,
      label: `${label}.ms`
    })
  };
}

function compileFlowObject(rawFlow, env = process.env) {
  if (!isObject(rawFlow)) throw new Error('http_flow file must be a JSON object');
  if (!Array.isArray(rawFlow.steps) || rawFlow.steps.length === 0) {
    throw new Error('http_flow steps must be a non-empty array');
  }

  const defaults = {
    baseUrl: String(rawFlow.base_url || '').trim(),
    timeoutMs: parseStrictInt(rawFlow.timeout_ms, DEFAULT_TIMEOUT_MS, {
      min: 100,
      max: 120000,
      label: 'timeout_ms'
    }),
    maxRedirects: parseStrictInt(rawFlow.max_redirects, DEFAULT_MAX_REDIRECTS, {
      min: 0,
      max: 20,
      label: 'max_redirects'
    }),
    followRedirects: rawFlow.follow_redirects !== false
  };
  if (defaults.baseUrl) {
    try {
      defaults.baseUrl = new URL(defaults.baseUrl).toString();
    } catch {
      throw new Error('base_url is invalid');
    }
  }

  const state = {
    env,
    availableVars: new Set()
  };

  const vars = [];
  if (hasOwn(rawFlow, 'vars')) {
    if (!isObject(rawFlow.vars)) throw new Error('vars must be a JSON object');
    for (const [nameRaw, value] of Object.entries(rawFlow.vars)) {
      const name = ensureNonEmptyText(nameRaw, 'vars key');
      vars.push({
        name,
        valueTemplate: compileTemplateValue(value, {
          availableVars: state.availableVars,
          env: state.env,
          label: `vars.${name}`
        })
      });
      state.availableVars.add(name);
    }
  }

  defaults.userAgentTemplate = compileTemplateText(
    rawFlow.user_agent === undefined ? DEFAULT_USER_AGENT : rawFlow.user_agent,
    {
      availableVars: state.availableVars,
      env: state.env,
      label: 'user_agent'
    }
  );

  const steps = [];
  for (let i = 0; i < rawFlow.steps.length; i += 1) {
    const step = rawFlow.steps[i];
    if (!isObject(step)) throw new Error(`step ${i + 1}: step must be an object`);
    const type = String(step.type || '').trim().toLowerCase();
    const name = String(step.name || '').trim();
    const label = `step ${i + 1}${name ? ` (${name})` : ''}`;
    if (!type) throw new Error(`${label}: missing type`);

    if (type === 'request') {
      steps.push(compileRequestStep(step, label, state));
    } else if (type === 'extract') {
      steps.push(compileExtractStep(step, label, state));
    } else if (type === 'assert') {
      steps.push(compileAssertStep(step, label, state));
    } else if (type === 'sleep') {
      steps.push(compileSleepStep(step, label));
    } else if (type === 'set') {
      steps.push(compileSetStep(step, label, state));
    } else {
      throw new Error(`${label}: unsupported step type: ${type}`);
    }
  }

  return { defaults, vars, steps };
}

function compileFlowFromFile(filePath, env = process.env) {
  let parsed;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid http_flow json: ${String(err)}` };
  }

  try {
    return { ok: true, flow: compileFlowObject(parsed, env) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

module.exports = {
  compileFlowFromFile
};
