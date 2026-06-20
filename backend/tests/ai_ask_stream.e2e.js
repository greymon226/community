'use strict';

// 验证流式 AI 问答 SSE：先收 meta，再收 delta，最后 done
const { api, login, expectOk, assert, step, pass, BASE } = require('./_helper');

(async () => {
  const userToken = await login('user001', 'user123');
  const adminToken = await login('admin', 'admin123');
  const settings = await expectOk(api('GET', '/admin/settings', null, adminToken), 'list settings');
  const aiStatus = settings.aiStatus || {};

  await expectOk(api('PUT', '/admin/settings', { key: 'aiAskEnabled', value: true }, adminToken), 'enable ask');

  step('准备种子帖');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAuditEnabled', value: false }, adminToken), 'disable audit');
  const tree = await expectOk(api('GET', '/categories'), 'categories');
  const cid = tree.find((c) => c.children?.length).children[0].id;
  await expectOk(api('POST', '/posts', {
    title: '[e2e stream] Vue3 响应式丢失常见原因',
    content: '<p>setup 中把 ref 解构出来传给函数会导致响应式丢失，应使用 toRefs。</p>',
    categoryId: cid,
  }, userToken), 'seed');
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAuditEnabled', value: true }, adminToken), 'restore audit');

  if (!aiStatus.apiKeyConfigured) {
    console.log('    ⚠ 未配置真实 LLM，跳过');
    process.exit(0);
  }

  step('发起 SSE 请求');
  const Q = `Vue3 响应式丢失排查方法 (e2e-${Date.now()})`;
  const streamAsk = async (question) => {
    const resp = await fetch(`${BASE}/ai/ask/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ question, topN: 5 }),
    });
    assert(resp.ok, `expected 200, got ${resp.status}`);
    assert(resp.headers.get('content-type')?.includes('text/event-stream'), 'content-type 应为 SSE');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const events = [];
    let answer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!raw.startsWith('data:')) continue;
        const evt = JSON.parse(raw.slice(5).trim());
        events.push(evt);
        if (evt.type === 'delta') answer += evt.payload?.text || '';
      }
    }
    return { events, answer };
  };

  const { events, answer } = await streamAsk(Q);

  pass(`收到 ${events.length} 帧`);
  const types = events.map((e) => e.type);

  assert(types[0] === 'meta', `第一帧应为 meta, got ${types[0]}`);
  assert(events.some((e) => e.type === 'delta'), '应至少有一个 delta 帧');
  assert(types.at(-1) === 'done', `最后一帧应为 done, got ${types.at(-1)}`);
  pass(`帧序列：${types.slice(0, 3).join(' -> ')} ... -> ${types.at(-1)}`);
  pass(`累计回答 ${answer.length} 字：${answer.slice(0, 60)}...`);

  const meta = events.find((e) => e.type === 'meta').payload;
  const doneEvt = events.find((e) => e.type === 'done').payload;
  assert(Array.isArray(meta.candidates), 'meta.candidates');
  assert(Array.isArray(doneEvt.citations), 'done.citations');
  pass(`候选 ${meta.candidates.length} 引用 ${doneEvt.citations.length} hasAnswer=${doneEvt.hasAnswer}`);

  step('同问题再次提问应命中缓存');
  const cached = await streamAsk(Q);
  const cachedMeta = cached.events.find((e) => e.type === 'meta').payload;
  const cachedDone = cached.events.find((e) => e.type === 'done').payload;
  assert(cachedMeta.cached === true, `meta.cached 应为 true, got ${cachedMeta.cached}`);
  assert(cachedDone.cached === true, `done.cached 应为 true, got ${cachedDone.cached}`);
  assert(cached.answer === answer, '缓存回放内容应与首次一致');
  pass('流式接口命中缓存');

  console.log('\n✅ ai_ask_stream 通过');
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
