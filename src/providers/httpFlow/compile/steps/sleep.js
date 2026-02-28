const { parseStrictInt } = require('../shared');

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

module.exports = {
  compileSleepStep
};
