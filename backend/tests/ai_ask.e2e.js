'use strict';

// 验证 AI 站内 RAG 问答：检索 + LLM 回答 + 引用 ID 映射 + 开关 + 缓存
const { api, login, expectOk, assert, step, pass } = require('./_helper');

(async () => {
  const userToken = await login('user001', 'user123');
  const adminToken = await login('admin', 'admin123');
  const settings = await expectOk(api('GET', '/admin/settings', null, adminToken), 'list settings');
  const aiStatus = settings.aiStatus || {};

  step('确保问答开关开启');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAskEnabled', value: true }, adminToken), 'enable ask');

  step('准备一篇用于检索的"知识帖"（关闭审核避免被拦）');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAuditEnabled', value: false }, adminToken), 'disable audit');
  const tree = await expectOk(api('GET', '/categories'), 'categories');
  const cid = tree.find((c) => c.children?.length).children[0].id;
  const seed = await expectOk(api('POST', '/posts', {
    title: '[e2e ask] Vue3 响应式丢失最常见原因与排查',
    content: '<p>Vue3 在 setup 中如果把 ref 解构出来传给函数，会导致响应式丢失。' +
             '排查步骤：1) 用 toRefs 保留响应式 2) 检查 reactive 对象是否被 spread' +
             ' 3) 在子组件用 props 接收时不要解构。' +
             '常见误区是直接读 ref.value 后传值，建议传 ref 本体或用 toRef 单字段保持。</p>',
    categoryId: cid,
    tags: ['Vue', '响应式'],
  }, userToken), 'seed post');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAuditEnabled', value: true }, adminToken), 'restore audit');
  pass(`种子帖 #${seed.id}`);

  if (!aiStatus.apiKeyConfigured) {
    console.log('    ⚠ 未配置真实 LLM，跳过 RAG 调用断言');
    process.exit(0);
  }

  // 用一个不太可能命中过往缓存的问句，避免上次结果干扰
  const Q = `请问 Vue3 出现响应式丢失要如何排查 (e2e-${Date.now()})`;

  step('1) 站内问答应基于站内帖子作答');
  const r1 = await api('POST', '/ai/ask', { question: Q }, userToken);
  assert(r1.body.code === 0, `expected ok, got ${r1.body.code}: ${r1.body.message}`);
  assert(r1.body.data.candidates?.length > 0, 'candidates 非空');
  assert(r1.body.data.cached === false, 'first call cached=false');
  pass(`回答: ${r1.body.data.answer.slice(0, 40)}... | candidates=${r1.body.data.candidates.length} citations=${r1.body.data.citations.length}`);
  // 引用应当映射回真实帖子 id
  for (const c of r1.body.data.citations) {
    assert(typeof c.id === 'number' && c.title, 'citation 应包含 id 和 title');
  }

  step('2) 同问题再次提问应命中缓存');
  const r2 = await api('POST', '/ai/ask', { question: Q }, userToken);
  assert(r2.body.code === 0 && r2.body.data.cached === true, `expected cached=true, got ${r2.body.data.cached}`);
  pass('命中缓存');

  step('3) 找不到答案的问题应引导发帖');
  const r3 = await api('POST', '/ai/ask', { question: '量子纠缠的最新研究突破是什么？' }, userToken);
  assert(r3.body.code === 0, 'ok');
  // 默认 candidates 为空时 hasAnswer=false
  if (r3.body.data.candidates.length === 0) {
    assert(r3.body.data.hasAnswer === false, 'hasAnswer should be false when no candidates');
    pass('无相关候选 → hasAnswer=false 引导发帖');
  } else {
    console.log('    ⚠ 该问题有候选帖子，跳过 hasAnswer=false 断言');
  }

  step('4) 关闭开关 -> 4003');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAskEnabled', value: false }, adminToken), 'disable ask');
  const r4 = await api('POST', '/ai/ask', { question: '随便问问' }, userToken);
  assert(r4.status === 403 && r4.body.code === 4003, `expected 4003, got ${r4.body.code}: ${r4.body.message}`);
  pass('开关关闭时返回 4003');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAskEnabled', value: true }, adminToken), 'restore ask');

  console.log('\n✅ ai_ask 通过');
  process.exit(0);
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
