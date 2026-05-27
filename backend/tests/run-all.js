'use strict';

// 顺序执行 tests/*.e2e.js
// 任何一个失败立刻退出，方便接入 CI

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { ensureBackendUp } = require('./_helper');

(async () => {
  const ok = await ensureBackendUp();
  if (!ok) {
    console.error('❌ 后端未启动。请先在另一个终端运行：cd backend && npm run start');
    process.exit(2);
  }

  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.e2e.js')).sort();
  if (files.length === 0) {
    console.warn('未发现 e2e 用例');
    process.exit(0);
  }

  let failed = 0;
  const failedFiles = [];
  for (const f of files) {
    console.log(`\n========== ${f} ==========`);
    const ret = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
    if (ret.status !== 0) {
      console.error(`❌ ${f} 失败 (exit ${ret.status})`);
      failed++;
      failedFiles.push(f);
    }
  }

  if (failed) {
    console.error(`\n============ ${failed} / ${files.length} 个 e2e 失败 ============`);
    failedFiles.forEach((f) => console.error('  -', f));
    process.exit(1);
  }
  console.log(`\n============ 全部 ${files.length} 个 e2e 通过 ✅ ============`);
})();
