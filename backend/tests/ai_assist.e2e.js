'use strict';

// 验证 AI 写作助手：title / summary / explainCode 三种 kind + 开关
const { api, login, expectOk, assert, step, pass } = require('./_helper');

(async () => {
  const userToken = await login('user001', 'user123');
  const adminToken = await login('admin', 'admin123');
  const settings = await expectOk(api('GET', '/admin/settings', null, adminToken), 'list settings');
  const aiStatus = settings.aiStatus || {};

  step('确保 aiAssistEnabled 开启');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAssistEnabled', value: true }, adminToken), 'enable');

  if (!aiStatus.apiKeyConfigured) {
    console.log('    ⚠ 未配置真实 LLM，跳过');
    process.exit(0);
  }

  step('1) 改写标题');
  const r1 = await api('POST', '/ai/assist', {
    kind: 'title',
    title: 'vue3 一些经验',
    content: 'Vue3 setup 函数中常见的响应式丢失问题及排查方法，包含 toRefs、reactive 解构等。',
  }, userToken);
  assert(r1.body.code === 0, `title fail: ${r1.body.message}`);
  assert(Array.isArray(r1.body.data.suggestions) && r1.body.data.suggestions.length > 0, 'no suggestions');
  pass(`候选：${r1.body.data.suggestions.slice(0, 2).join(' | ')}`);

  step('2) 生成摘要');
  const r2 = await api('POST', '/ai/assist', {
    kind: 'summary',
    title: 'Vue3 响应式丢失排查',
    content: 'Vue3 setup 中如果把 ref 解构出来传给函数，会导致响应式丢失。建议用 toRefs 或保持原对象传递。',
  }, userToken);
  assert(r2.body.code === 0, `summary fail: ${r2.body.message}`);
  assert(typeof r2.body.data.summary === 'string' && r2.body.data.summary.length > 5, 'empty summary');
  pass(`摘要：${r2.body.data.summary}`);

  step('3) 解释代码');
  const r3 = await api('POST', '/ai/assist', {
    kind: 'explainCode',
    snippet: 'const list = arr.map(x => x.value).filter(Boolean);',
    language: 'javascript',
  }, userToken);
  assert(r3.body.code === 0, `explainCode fail: ${r3.body.message}`);
  assert(r3.body.data.explanation, 'empty explanation');
  pass(`解释：${r3.body.data.explanation.slice(0, 50)}...`);

  step('4) 关闭开关 -> 4003');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAssistEnabled', value: false }, adminToken), 'disable');
  const r4 = await api('POST', '/ai/assist', { kind: 'title', title: 'x', content: 'y' }, userToken);
  assert(r4.status === 403 && r4.body.code === 4003, `expected 4003, got ${r4.body.code}`);
  pass('开关关闭返回 4003');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAssistEnabled', value: true }, adminToken), 'restore');

  console.log('\n✅ ai_assist 通过');
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
