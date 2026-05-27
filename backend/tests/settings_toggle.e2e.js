'use strict';

// 验证 AI 审核开关：默认开启 → 关闭后 aiAuditStatus=skipped
const { api, login, expectOk, assert, step, pass } = require('./_helper');

(async () => {
  const userToken = await login('user001', 'user123');
  const adminToken = await login('admin', 'admin123');

  step('读取默认设置');
  const settings = await expectOk(api('GET', '/admin/settings', null, adminToken), 'list settings');
  const defaults = (settings.items || []).find((s) => s.key === 'aiAuditEnabled');
  assert(defaults, 'aiAuditEnabled exists');
  pass(`默认 aiAuditEnabled=${defaults.value}`);

  step('确保开启 AI 审核，发帖应当 aiAuditStatus 不为 skipped（pass 或 review，依赖模型）');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAuditEnabled', value: true }, adminToken), 'turn on');
  const tree = await expectOk(api('GET', '/categories'), 'categories');
  const cid = tree.find((c) => c.children?.length).children[0].id;

  // 注意：默认本地兜底也算"参与审核"。aiAuditStatus 至少不会是 skipped。
  const p1 = await expectOk(api('POST', '/posts', {
    title: '[e2e settings] 普通技术内容',
    content: '<p>今天总结了一些 React 性能优化的实践经验，包含 useMemo 和 useCallback。</p>',
    categoryId: cid,
  }, userToken), 'post with audit on');
  assert(p1.aiAuditStatus !== 'skipped', `aiAuditStatus 不应为 skipped, 当前=${p1.aiAuditStatus}`);
  pass(`AI 开启时 aiAuditStatus=${p1.aiAuditStatus}`);

  step('关闭后 aiAuditStatus 应当为 skipped');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAuditEnabled', value: false }, adminToken), 'turn off');
  const p2 = await expectOk(api('POST', '/posts', {
    title: '[e2e settings] 关闭 AI 后发帖',
    content: '<p>这是关闭 AI 审核时的发帖测试。</p>',
    categoryId: cid,
  }, userToken), 'post with audit off');
  assert(p2.aiAuditStatus === 'skipped', `aiAuditStatus 应为 skipped, 当前=${p2.aiAuditStatus}`);
  pass(`AI 关闭时 aiAuditStatus=${p2.aiAuditStatus}, status=${p2.status}`);

  // 还原
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAuditEnabled', value: true }, adminToken), 'restore');

  console.log('\n✅ settings_toggle 通过');
  process.exit(0);
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
