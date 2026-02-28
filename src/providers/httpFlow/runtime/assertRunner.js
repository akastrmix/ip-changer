const { renderTemplateValue } = require('../template');
const { readSourceText, resolveRegex } = require('./shared');

async function executeAssertStep(step, ctx, env) {
  const actual = readSourceText(step.source, ctx, env, step.label);
  if (step.op === 'exists') {
    const ok = actual.length > 0;
    if (ok !== step.expected) {
      throw new Error(`assert exists failed (expected ${step.expected}, got ${ok})`);
    }
    return;
  }
  if (step.op === 'equals') {
    const expected = String(renderTemplateValue(step.expectedTemplate, { vars: ctx.vars, env }) ?? '');
    if (actual !== expected) {
      throw new Error(`assert equals failed (expected "${expected}", got "${actual}")`);
    }
    return;
  }
  if (step.op === 'includes') {
    const expected = String(renderTemplateValue(step.expectedTemplate, { vars: ctx.vars, env }) ?? '');
    if (!actual.includes(expected)) {
      throw new Error(`assert includes failed (missing "${expected}")`);
    }
    return;
  }
  if (step.op === 'regex') {
    const regex = resolveRegex(step.regex, ctx, env);
    if (!regex.test(actual)) {
      throw new Error(`assert regex failed: /${regex.source}/${regex.flags}`);
    }
    return;
  }
  throw new Error(`unsupported assert op: ${step.op}`);
}

module.exports = {
  executeAssertStep
};
