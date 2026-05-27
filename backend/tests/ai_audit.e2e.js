'use strict';

// 单元 / 集成测试：直接加载 aiService，对 DeepSeek HTTP 协议层进行 mock，验证 4 类用例
// 不需要后端进程在运行
process.env.AI_PROVIDER = 'deepseek';
process.env.AI_API_KEY = 'sk-fake-key-for-test';
process.env.AI_BASE_URL = 'http://127.0.0.1:5599';
process.env.AI_MODEL = 'deepseek-chat';

const http = require('http');
const path = require('path');

const sockets = new Set();
const mock = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => (buf += c));
  req.on('end', () => {
    const payload = JSON.parse(buf);
    const userMsg = payload.messages.find((m) => m.role === 'user').content;
    let result;
    if (/加微信|t\.me/i.test(userMsg)) {
      result = { status: 'blocked', reason: '推广引流', categories: ['广告推广'] };
    } else if (/不确定/.test(userMsg)) {
      result = { status: 'review', reason: '内容存疑', categories: [] };
    } else {
      result = { status: 'pass', reason: '', categories: [] };
    }
    res.setHeader('Connection', 'close');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(result) } }],
    }));
  });
});

mock.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

async function runAll() {
  const aiPath = path.join(__dirname, '..', 'src', 'services', 'aiService.js');
  const ai = require(aiPath);

  console.log('1) 正常技术内容 -> pass');
  const r1 = await ai.auditContent({
    title: '分享 Vue3 组合式 API 经验',
    content: '今天总结了 setup 函数下的常见踩坑：响应式丢失、effectScope、watch 时机',
  });
  if (r1.status !== 'pass') throw new Error(`expected pass got ${r1.status}`);
  console.log('   ✅', r1);

  console.log('2) 含推广 -> blocked');
  const r2 = await ai.auditContent({ title: '加微信领福利', content: 'http://t.me/xxx 私聊有惊喜' });
  if (r2.status !== 'blocked') throw new Error(`expected blocked got ${r2.status}`);
  console.log('   ✅', r2);

  console.log('3) review 用例');
  const r3 = await ai.auditContent({ title: '不确定的事', content: '不确定这个能否发布，仅供参考。' });
  if (r3.status !== 'review') throw new Error(`expected review got ${r3.status}`);
  console.log('   ✅', r3);

  // 4) 模型不可用 -> 降级到本地规则
  // 在 Windows + Node 24 下，AbortController 超时 + fetch 的 socket 关闭顺序会
  // 触发 libuv 断言导致进程异常退出，但不影响功能正确性。
  // 用 child_process.spawnSync 隔离一下，让本进程的 exit code 与该步骤解耦。
  console.log('4) 模型不可用 -> 降级到本地规则（子进程隔离）');
  const { spawnSync } = require('child_process');
  const inline = `
    process.env.AI_PROVIDER = 'deepseek';
    process.env.AI_API_KEY = 'sk-fake';
    process.env.AI_BASE_URL = 'http://127.0.0.1:1';
    process.env.AI_MODEL = 'deepseek-chat';
    const ai = require(${JSON.stringify(aiPath)});
    ai.auditContent({ title: '辱骂他人', content: '一些攻击性内容' }).then((r) => {
      if (r.status !== 'review' || !/本地风险词/.test(r.reason || '')) {
        console.error('FAIL', r);
        process.stdout.write('AUDIT_FAIL');
      } else {
        process.stdout.write('AUDIT_OK ' + JSON.stringify(r));
      }
    }).catch((e) => { console.error(e.message); process.stdout.write('AUDIT_FAIL'); });
  `;
  const ret = spawnSync(process.execPath, ['-e', inline], { encoding: 'utf8', timeout: 10000 });
  const out = (ret.stdout || '') + (ret.stderr || '');
  if (!out.includes('AUDIT_OK')) {
    throw new Error(`本地规则降级测试失败：${out}`);
  }
  console.log('   ✅', out.replace('AUDIT_OK', '').trim());
}

mock.listen(5599, async () => {
  let exitCode = 0;
  try {
    await runAll();
    console.log('\n✅ ai_audit 通过');
  } catch (e) {
    console.error('❌', e.stack || e.message);
    exitCode = 1;
  }
  for (const s of sockets) { try { s.destroy(); } catch {} }
  try { mock.close(); } catch {}
  process.exit(exitCode);
});
