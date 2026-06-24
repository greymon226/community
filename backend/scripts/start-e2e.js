'use strict';

// E2E 专用后端：SQLite 独立库 + seed 后启动，供 Playwright webServer 使用
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sqlitePath = path.join(root, 'data', 'e2e.sqlite');

const e2eEnv = {
  ...process.env,
  DB_DIALECT: 'sqlite',
  DB_STORAGE: sqlitePath,
  JWT_SECRET: 'e2e-test-secret',
  AI_PROVIDER: 'local',
  PORT: process.env.PORT || '4000',
  NODE_ENV: 'test',
  REDIS_URL: '',
};

Object.assign(process.env, e2eEnv);

function resetDbFile() {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${sqlitePath}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
}

async function main() {
  resetDbFile();
  const { run: seed } = require('../seed');
  await seed({ close: false });
  const { bootstrap } = require('../src/app');
  await bootstrap();
}

main().catch((err) => {
  console.error('[start-e2e]', err);
  process.exit(1);
});
