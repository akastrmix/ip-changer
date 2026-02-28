const { renderTemplateValue } = require('./template');
const { sleep } = require('./runtime/shared');
const { executeRequestStep } = require('./runtime/requestRunner');
const { executeAssertStep } = require('./runtime/assertRunner');
const { executeExtractStep } = require('./runtime/extractRunner');
const { executeWaitUntilStep } = require('./runtime/waitUntilRunner');

async function executeSetStep(step, ctx, env) {
  if (step.mode === 'from_env') {
    if (!Object.prototype.hasOwnProperty.call(env, step.envName)) {
      throw new Error(`env var not found: ${step.envName}`);
    }
    ctx.vars[step.name] = String(env[step.envName] ?? '');
    return;
  }
  ctx.vars[step.name] = renderTemplateValue(step.valueTemplate, { vars: ctx.vars, env });
}

async function runCompiledFlow(flow, env = process.env) {
  const ctx = {
    vars: {},
    last: null,
    cookieJar: []
  };

  for (const item of flow.vars) {
    ctx.vars[item.name] = renderTemplateValue(item.valueTemplate, { vars: ctx.vars, env });
  }

  for (const step of flow.steps) {
    try {
      if (step.type === 'request') {
        await executeRequestStep(step, ctx, flow.defaults, env);
      } else if (step.type === 'wait_until') {
        await executeWaitUntilStep(step, ctx, flow.defaults, env, {
          executeRequestStep,
          executeAssertStep
        });
      } else if (step.type === 'extract') {
        await executeExtractStep(step, ctx, env);
      } else if (step.type === 'assert') {
        await executeAssertStep(step, ctx, env);
      } else if (step.type === 'sleep') {
        await sleep(step.ms);
      } else if (step.type === 'set') {
        await executeSetStep(step, ctx, env);
      } else {
        throw new Error(`unsupported step type: ${step.type}`);
      }
    } catch (err) {
      throw new Error(`${step.label}: ${String(err && err.message ? err.message : err)}`);
    }
  }
}

module.exports = {
  runCompiledFlow
};
