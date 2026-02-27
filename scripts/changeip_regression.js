#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CASES } = require('./changeip_regression/cases');
const { log, startEventSink } = require('./changeip_regression/harness');

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-changer-regression-'));
  const sink = await startEventSink();

  try {
    for (let i = 0; i < CASES.length; i += 1) {
      const c = CASES[i];
      log(`case ${i + 1}/${CASES.length}: ${c.title}`);
      await c.run(tmpRoot, sink);
      log(`case ${i + 1}/${CASES.length} passed`);
    }

    log('all regression checks passed');
  } finally {
    await sink.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[regression] FAILED: ${err.stack || String(err)}`);
  process.exit(1);
});
