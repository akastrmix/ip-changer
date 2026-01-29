const { postJson } = require('./http');

function truncate(text, maxLen) {
  const s = String(text || '');
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

async function postIpEvent(config, payload) {
  if (!config.ipEventsActive) {
    return { ok: false, error: 'ip events disabled' };
  }
  const resp = await postJson(config.ipEventsEndpoint, {
    token: config.ipEventsToken,
    body: payload,
    timeoutMs: 8000,
    userAgent: 'ip-changer'
  });
  if (!resp.ok) {
    const msg = `${resp.status} ${truncate(resp.text, 200)}`.trim();
    return { ok: false, error: msg || `status ${resp.status}` };
  }
  return { ok: true, error: '' };
}

module.exports = {
  postIpEvent
};

