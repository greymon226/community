'use strict';

// Property 15: AI 审核状态映射
// Validates: Requirements 5.6, 5.9, 8.7, 8.8, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.11
//
// 不变量：对任意三元组 (aiAuditEnabled, post.status, mockedAuditResult)，
// POST /api/posts 的最终状态满足以下表：
//
//   aiAuditEnabled = false:
//     status preserved (draft → draft, published → published)
//     aiAuditStatus = 'skipped', aiAuditReason = 'AI 审核已关闭'
//     no LLM call.
//
//   status = 'draft':
//     no LLM call (regardless of aiAuditEnabled).
//
//   aiAuditEnabled = true, status = 'published':
//     mock = 'pass'    → post.status='published', aiAuditStatus='pass'
//     mock = 'review'  → post.status='blocked',  aiAuditStatus='review',
//                        response.data.pending = true
//     mock = 'blocked' → no Post persisted, response { code:4002, status:400 },
//                        AuditLog 'post.rejected_by_ai' written.
//
// 实现策略：
//   - 通过 _setup 的内存 sqlite 启动模型，挂载 /api 路由到一个临时 express
//     server，再用 installAiMock + setAiHandler 在每次迭代前注入想要的 AI
//     响应。所有断言通过 HTTP 实际驱动 controller，不直接调用 aiService。
//   - 每次迭代前通过 settings.set('aiAuditEnabled', value) 设置开关并自动
//     invalidate 缓存，再用 resetCounters 清零 AI 调用计数器。
//   - 在 between-iteration 我们不 resetDb（开销大），而是只清空 Post / AuditLog
//     表，保留 User / Category / SystemSetting 等基线 fixture。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fc = require('fast-check');
const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');

const setup = require('./_setup');
const { resetDb, getModels, closeDb, config, installAiMock, setAiHandler, restoreAiMock } = setup;

const apiRouter = require('../../src/routes');
const settings = require('../../src/services/settingService');
const moderation = require('../../src/services/moderationService');

// ---------- harness ----------

let server;
let port;
let userToken;
let userId;
let categoryId;

// AI invocation tracking ----------------------------------------------------
let aiCallCount = 0;

function makeAiHandler(result) {
  return (_req, _body) => {
    aiCallCount += 1;
    return {
      status: 200,
      json: {
        id: 'mock',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify(result),
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
    };
  };
}

async function seedFixture() {
  const { User, Category } = getModels();
  const user = await User.create({
    empNo: 'E-P15-AUTHOR',
    name: 'P15 Author',
    role: 'user',
    status: 'active',
    passwordHash: await bcrypt.hash('p15', 4),
  });
  const cat = await Category.create({ name: 'p15-fixture', sort: 0, enabled: true });
  userId = user.id;
  categoryId = cat.id;
  userToken = jwt.sign({ id: user.id, role: 'user' }, config.jwt.secret, { expiresIn: '7d' });
}

test.before(async () => {
  await resetDb();
  await seedFixture();
  // Make sure moderation cache is empty so generated content never accidentally
  // hits the .env fallback list (only mask strategy by default; would not
  // affect status mapping but kept for hygiene).
  config.sensitiveWords.length = 0;
  moderation.invalidate();

  await installAiMock();

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(500).json({ code: 500, message: err.message || 'internal', data: null });
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await restoreAiMock();
  await closeDb();
});

// ---------- helpers ----------

function request(method, path, body, token) {
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api' + path, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c.toString('utf8')));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = { __raw: raw };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function clearWriteTables() {
  const { Post, AuditLog, PostTag, Tag } = getModels();
  // Order matters because of FK / unique constraints.
  await PostTag.destroy({ where: {}, truncate: true });
  await Post.destroy({ where: {}, truncate: true });
  await AuditLog.destroy({ where: {}, truncate: true });
  await Tag.destroy({ where: {}, truncate: true });
}

async function setupIteration({ aiAuditEnabled, mockResult }) {
  await clearWriteTables();
  await settings.set('aiAuditEnabled', aiAuditEnabled);
  setAiHandler(makeAiHandler(mockResult));
  aiCallCount = 0;
}

// ---------- arbitraries ----------

// Safe payloads that do NOT trip moderation or length limits.
const safeTitleArb = fc
  .stringMatching(/^[A-Za-z0-9 ]{6,40}$/)
  .map((s) => s.trim())
  .filter((s) => s.length >= 6);

const safeContentArb = fc
  .stringMatching(/^[A-Za-z0-9 .,]{10,200}$/)
  .map((s) => s.trim())
  .filter((s) => s.length >= 10);

const inputStatusArb = fc.constantFrom('draft', 'published');
const aiEnabledArb = fc.boolean();
const mockResultArb = fc.record({
  status: fc.constantFrom('pass', 'review', 'blocked'),
  reason: fc
    .stringMatching(/^[A-Za-z0-9 ,.]{0,40}$/)
    .map((s) => s.slice(0, 40)),
  categories: fc.constant([]),
});

// One iteration's full input bundle.
const iterationArb = fc.record({
  title: safeTitleArb,
  content: safeContentArb,
  status: inputStatusArb,
  aiAuditEnabled: aiEnabledArb,
  mock: mockResultArb,
});

// ---------- the property ----------

test('P15: AI 审核状态映射 (POST /api/posts)', async () => {
  await fc.assert(
    fc.asyncProperty(iterationArb, async ({ title, content, status, aiAuditEnabled, mock }) => {
      await setupIteration({ aiAuditEnabled, mockResult: mock });

      const resp = await request(
        'POST',
        '/posts',
        { title, content, categoryId, status },
        userToken
      );

      const { Post, AuditLog } = getModels();

      // ---------- branch: aiAuditEnabled = false ----------
      if (aiAuditEnabled === false) {
        // Always succeeds: status preserved, aiAuditStatus='skipped',
        // aiAuditReason='AI 审核已关闭', no LLM call.
        assert.equal(resp.status, 200, `aiEnabled=false should not 4xx (got ${resp.status})`);
        assert.equal(resp.body.code, 0, `aiEnabled=false should code=0 (got ${resp.body.code})`);
        assert.equal(aiCallCount, 0, 'aiEnabled=false: no LLM call expected');
        const rows = await Post.findAll();
        assert.equal(rows.length, 1, 'exactly 1 post should be persisted');
        const p = rows[0];
        assert.equal(p.status, status, `post.status preserved (${status})`);
        assert.equal(p.aiAuditStatus, 'skipped');
        assert.equal(p.aiAuditReason, 'AI 审核已关闭');
        return;
      }

      // ---------- branch: aiAuditEnabled = true, status = 'draft' ----------
      if (status === 'draft') {
        // Drafts skip LLM regardless of mock.
        assert.equal(resp.status, 200);
        assert.equal(resp.body.code, 0);
        assert.equal(aiCallCount, 0, 'draft path must not invoke AI');
        const rows = await Post.findAll();
        assert.equal(rows.length, 1, 'draft should still persist exactly 1 post');
        assert.equal(rows[0].status, 'draft');
        // aiAuditStatus must NOT be a model-derived terminal state for drafts
        // (controller takes the early-pass branch so it cannot be 'review' or
        // 'blocked' here).
        assert.ok(
          rows[0].aiAuditStatus !== 'review' && rows[0].aiAuditStatus !== 'blocked',
          `draft aiAuditStatus must not be review/blocked, got ${rows[0].aiAuditStatus}`
        );
        return;
      }

      // ---------- branch: aiAuditEnabled = true, status = 'published' ----------
      // Exactly one LLM call must have happened.
      assert.equal(aiCallCount, 1, `published path must invoke AI exactly once, got ${aiCallCount}`);

      if (mock.status === 'pass') {
        assert.equal(resp.status, 200);
        assert.equal(resp.body.code, 0);
        const rows = await Post.findAll();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'published');
        assert.equal(rows[0].aiAuditStatus, 'pass');
        // No reject audit must have been written for pass.
        const rejected = await AuditLog.count({ where: { action: 'post.rejected_by_ai' } });
        assert.equal(rejected, 0, 'pass result must not write post.rejected_by_ai');
        // Pending must be falsey.
        assert.notEqual(resp.body.data && resp.body.data.pending, true);
      } else if (mock.status === 'review') {
        assert.equal(resp.status, 200);
        assert.equal(resp.body.code, 0);
        const rows = await Post.findAll();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'blocked', 'review → post.status=blocked');
        assert.equal(rows[0].aiAuditStatus, 'review');
        assert.equal(
          resp.body.data && resp.body.data.pending,
          true,
          'review response must include pending=true'
        );
      } else {
        // mock.status === 'blocked'
        assert.equal(resp.status, 400, `blocked → HTTP 400, got ${resp.status}`);
        assert.equal(resp.body.code, 4002, `blocked → code=4002, got ${resp.body.code}`);
        const rows = await Post.findAll();
        assert.equal(rows.length, 0, 'blocked must not persist any post row');
        const rejected = await AuditLog.count({ where: { action: 'post.rejected_by_ai' } });
        assert.equal(rejected, 1, 'blocked must write exactly one post.rejected_by_ai audit');
      }
    }),
    { numRuns: 100 }
  );
});
