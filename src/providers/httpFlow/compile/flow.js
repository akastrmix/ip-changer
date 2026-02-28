const fs = require('fs');
const { URL } = require('url');

const { hasOwn, isObject } = require('../common');
const { compileTemplateText, compileTemplateValue } = require('../template');
const { parseStrictInt } = require('./shared');
const { compileStep } = require('./steps');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = 'ip-changer-http-flow/1.0';

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
    followRedirects: true
  };
  if (hasOwn(rawFlow, 'follow_redirects')) {
    if (typeof rawFlow.follow_redirects !== 'boolean') {
      throw new Error('follow_redirects must be a boolean');
    }
    defaults.followRedirects = rawFlow.follow_redirects;
  }
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
      const name = String(nameRaw || '').trim();
      if (!name) throw new Error('vars key is empty');
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

  const steps = rawFlow.steps.map((step, index) => compileStep(step, index, state));
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
