'use strict';

// 验证 AI 解读：缓存命中 + 开关 + 真实 LLM 调用
const { api, login, expectOk, assert, step, pass } = require('./_helper');

(async () => {
  const userToken = await login('user001', 'user123');
  const adminToken = await login('admin', 'admin123');

  step('确保解读开关开启');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiExplainEnabled', value: true }, adminToken), 'enable explain');
  const settings = await expectOk(api('GET', '/admin/settings', null, adminToken), 'list settings');
  const aiStatus = settings.aiStatus || {};

  step('找一篇有内容的已发布帖子');
  const list = await expectOk(api('GET', '/posts?pageSize=10'), 'list posts');
  const target = list.items.find((p) => p.summary && p.summary.length > 10) || list.items[0];
  assert(target, '至少需要一个帖子');
  pass(`选中 #${target.id} ${target.title}`);

  step('第一次解读');
  const r1 = await api('GET', `/posts/${target.id}/explain`, null, userToken);
  if (!aiStatus.apiKeyConfigured) {
    console.log('    ⚠ 未配置真实 LLM，解读可能失败；跳过');
    return process.exit(0);
  }
  assert(r1.body.code === 0, `expected ok, got ${r1.body.code}: ${r1.body.message}`);
  assert(r1.body.data.summary, 'summary 非空');
  assert(Array.isArray(r1.body.data.keyPoints), 'keyPoints 数组');
  assert(r1.body.data.cached === false, 'first call cached=false');
  pass(`耗时 ${r1.body.data.elapsedMs}ms, summary: ${r1.body.data.summary.slice(0, 30)}...`);

  step('第二次解读应命中缓存');
  const r2 = await api('GET', `/posts/${target.id}/explain`, null, userToken);
  assert(r2.body.code === 0, 'second call ok');
  assert(r2.body.data.cached === true, `expected cached=true, got ${r2.body.data.cached}`);
  pass(`命中缓存，耗时 ${r2.body.data.elapsedMs}ms (response 实际很快)`);

  step('关闭开关 -> 4003');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiExplainEnabled', value: false }, adminToken), 'disable');
  const r3 = await api('GET', `/posts/${target.id}/explain`, null, userToken);
  assert(r3.status === 403 && r3.body.code === 4003, `expected 4003, got ${r3.body.code}: ${r3.body.message}`);
  pass(`开关关闭时返回 4003`);
  await expectOk(api('PUT', '/admin/settings', { key: 'aiExplainEnabled', value: true }, adminToken), 'restore');

  console.log('\n✅ ai_explain 通过');
  process.exit(0);
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
