'use strict';

const { getIpqualityStatus, triggerIpquality } = require('./trigger');
const { loadIpqualityState } = require('./state');

module.exports = {
  getIpqualityStatus,
  loadIpqualityState,
  triggerIpquality
};
