#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { QUICK_CASES } = require('./changeip_regression/quickCases');
const { CASES } = require('./changeip_regression/cases');
const { log, startEventSink } = require('./changeip_regression/harness');

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-changer-regression-'));
  try {
    for (let i = 0; i < QUICK_CASES.length; i += 1) {
      const c = QUICK_CASES[i];
      log(`quick case ${i + 1}/${QUICK_CASES.length}: ${c.title}`);
      await c.run(tmpRoot);
      log(`quick case ${i + 1}/${QUICK_CASES.length} passed`);
    }

    const sink = await startEventSink();
    try {
      for (let i = 0; i < CASES.length; i += 1) {
        const c = CASES[i];
        log(`case ${i + 1}/${CASES.length}: ${c.title}`);
        await c.run(tmpRoot, sink);
        log(`case ${i + 1}/${CASES.length} passed`);
      }
    } finally {
      await sink.close();
    }

    log('all regression checks passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[regression] FAILED: ${err.stack || String(err)}`);
  process.exit(1);
});
