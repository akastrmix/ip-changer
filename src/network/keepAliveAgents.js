const http = require('http');
const https = require('https');

const DEFAULT_KEEPALIVE_AGENT_OPTIONS = Object.freeze({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 16,
  maxFreeSockets: 4,
  timeout: 60 * 1000
});

function createKeepAliveAgents(options = {}) {
  const opts = { ...DEFAULT_KEEPALIVE_AGENT_OPTIONS, ...(options || {}) };
  return {
    httpAgent: new http.Agent(opts),
    httpsAgent: new https.Agent(opts)
  };
}

module.exports = {
  DEFAULT_KEEPALIVE_AGENT_OPTIONS,
  createKeepAliveAgents
};
