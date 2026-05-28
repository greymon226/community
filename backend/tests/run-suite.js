#!/usr/bin/env node
/**
 * Cross-platform test runner: spawns `node --test` with an explicit list of
 * *.test.js files under the requested directory. Avoids depending on shell
 * glob expansion (PowerShell, bash, GitHub Actions ubuntu shell all behave
 * differently).
 *
 * Usage:
 *   node tests/run-suite.js unit       → runs all tests/unit/**\/*.test.js
 *   node tests/run-suite.js property   → runs all tests/property/**\/*.test.js
 *
 * Exits with the same status code that `node --test` returned.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node tests/run-suite.js <unit|property>');
  process.exit(1);
}

const root = path.resolve(__dirname, arg);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`[run-suite] not a directory: ${root}`);
  process.exit(1);
}

function collect(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collect(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      result.push(full);
    }
  }
  return result;
}

const files = collect(root).sort();
if (files.length === 0) {
  console.error(`[run-suite] no *.test.js files found under ${root}`);
  process.exit(1);
}

console.log(`[run-suite] ${arg}: discovered ${files.length} test files`);
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
