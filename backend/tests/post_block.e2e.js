'use strict';

// 验证 AI 审核拒绝路径：blocked → 4002，草稿不走 AI
// 需要后端运行且配置了真实 DeepSeek API_KEY；若未配置则会跳过敏感用例
const { api, login, expectOk, assert, step, pass } = require('./_helper');

(async () => {
  const userToken = await login('user001', 'user123');
  const adminToken = await login('admin', 'admin123');

  step('确认 AI 审核已开启');
  const settings = await expectOk(api('GET', '/admin/settings', null, adminToken), 'list settings');
  const aiStatus = settings.aiStatus || {};
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAuditEnabled', value: true }, adminToken), 'turn on');

  const tree = await expectOk(api('GET', '/categories'), 'categories');
  const cid = tree.find((c) => c.children?.length).children[0].id;

  step('正常内容应当 pass');
  const r1 = await api('POST', '/posts', {
    title: '[e2e block] 正常分享',
    content: '<p>今天解决了一个 Vue3 的响应式追踪 bug，原因是把 ref 解构出来传入函数后丢失了响应式。建议用 toRefs 或保持原对象传递。</p>',
    categoryId: cid,
  }, userToken);
  assert(r1.body.code === 0, `expected ok, got ${r1.body.code}: ${r1.body.message}`);
  pass(`正常发帖 status=${r1.body.data.status}`);

  step('明显广告引流应当 4002（仅在配置真实 LLM 时严格断言）');
  const r2 = await api('POST', '/posts', {
    title: '加微信领免费资料',
    content: '<p>加我微信 wx12345，扫码进群有惊喜，长期接广告投放，私聊优惠</p>',
    categoryId: cid,
  }, userToken);
  if (aiStatus.provider !== 'local' && aiStatus.apiKeyConfigured) {
    assert(r2.status === 400 && r2.body.code === 4002, `expected 4002 got ${r2.body.code}: ${r2.body.message}`);
    pass(`广告引流被拒：${r2.body.message}`);
  } else {
    console.log('    ⚠ 未配置真实 LLM，广告引流可能被本地兜底标为 review；跳过严格断言');
  }

  step('草稿不走 AI');
  const r3 = await expectOk(api('POST', '/posts', {
    title: '加微信领福利',
    content: '<p>请加微信免费送资料</p>',
    categoryId: cid,
    status: 'draft',
  }, userToken), 'draft post');
  assert(r3.status === 'draft', `expected draft, got ${r3.status}`);
  pass(`草稿存为 ${r3.status}, aiAuditStatus=${r3.aiAuditStatus}`);

  console.log('\n✅ post_block 通过');
  process.exit(0);
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
