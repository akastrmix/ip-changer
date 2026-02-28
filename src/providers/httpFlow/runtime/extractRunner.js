const { readSourceText, resolveRegex } = require('./shared');

async function executeExtractStep(step, ctx, env) {
  const sourceText = readSourceText(step.source, ctx, env, step.label);
  const regex = resolveRegex(step.regex, ctx, env);
  const match = sourceText.match(regex);
  if (!match) throw new Error('extract did not match');
  if (step.group >= match.length) throw new Error(`extract group ${step.group} out of range`);

  let value = String(match[step.group] ?? '');
  if (step.trim) value = value.trim();
  if (step.decodeUriComponent) {
    try {
      value = decodeURIComponent(value);
    } catch (err) {
      throw new Error(`decode_uri_component failed: ${String(err)}`);
    }
  }
  ctx.vars[step.to] = value;
}

module.exports = {
  executeExtractStep
};
