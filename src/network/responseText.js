const MIN_RESPONSE_BYTES = 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

function normalizeMaxResponseBytes(value, fallback, {
  min = MIN_RESPONSE_BYTES,
  max = MAX_RESPONSE_BYTES
} = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function buildResponseTooLargeError(maxResponseBytes) {
  return new Error(`response too large (max ${maxResponseBytes} bytes)`);
}

function readResponseText(res, maxResponseBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;

    const cleanup = () => {
      res.removeListener('data', onData);
      res.removeListener('end', onEnd);
      res.removeListener('error', onError);
      res.removeListener('aborted', onAborted);
      res.removeListener('close', onClose);
    };
    const finishReject = (err) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };
    const finishResolve = (body) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(body);
    };
    const onData = (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxResponseBytes) {
        const err = buildResponseTooLargeError(maxResponseBytes);
        res.destroy(err);
        finishReject(err);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (done) return;
      finishResolve(Buffer.concat(chunks, total).toString('utf8'));
    };
    const onError = (err) => finishReject(err);
    const onAborted = () => finishReject(new Error('response aborted'));
    const onClose = () => {
      if (done || res.complete) return;
      finishReject(new Error('response closed before end'));
    };

    res.on('data', onData);
    res.on('end', onEnd);
    res.on('error', onError);
    res.on('aborted', onAborted);
    res.on('close', onClose);
  });
}

module.exports = {
  MAX_RESPONSE_BYTES,
  MIN_RESPONSE_BYTES,
  normalizeMaxResponseBytes,
  readResponseText
};
