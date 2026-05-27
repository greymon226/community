'use strict';

// Property 28: 管理操作恰一次 AuditLog
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 22.5
//
// 不变量：For each event listed in R22.5, invoking the corresponding endpoint
// once writes EXACTLY ONE AuditLog row whose `action` matches the event,
// and whose (targetType, targetId) is consistent with the operated entity.
//
// R22.5 lists 16 actions:
//   post.create / post.update / post.delete / post.pin / post.feature /
//   post.block / post.rejected_by_ai / comment.delete / category.create /
//   category.update / category.delete / report.create / report.block /
//   report.reject / user.update / setting.update
//
// We exercise a representative subset (≥ 6) per the task spec, chosen to
// span 6 different controllers:
//   1) category.create     (POST /api/admin/categories)
//   2) post.create         (POST /api/posts; AI mock → pass)
//   3) post.delete         (DELETE /api/posts/:id)
//   4) report.create       (POST /api/reports)
//   5) setting.update      (PUT /api/admin/settings)
//   6) user.update         (PUT /api/admin/users/:id/role)
//
// Other R22.5 actions (post.update, post.pin, post.feature, post.block,
// post.rejected_by_ai, comment.delete, category.update, category.delete,
// report.block, report.reject) are covered by integration tests under
// tests/*.e2e.js (post_block.e2e.js, settings_toggle.e2e.js, ...) and the
// implementation paths are identical writeAudit calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fc = require('fast-check');
const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');

const setup = require('./_setup');
const { resetDb, getModels, closeDb, config, installAiMock, restoreAiMock, setAiHandler } = setup;

const apiRouter = require('../../src/routes');

// ---------- harness ----------

let server;
let port;

let adminToken;
let userToken;
let adminId;
let userId;
let baseCategoryId; // reused for post.create / report.create

const ADMIN_EMPNO = 'E-ADMIN-P28';
const USER_EMPNO = 'E-USER-P28';

function passReply() {
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
            content: JSON.stringify({ status: 'pass', reason: '', categories: [] }),
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  };
}

async function seedFixture() {
  const { User, Category } = getModels();
  const admin = await User.create({
    empNo: ADMIN_EMPNO,
    name: 'Admin P28',
    role: 'admin',
    status: 'active',
    passwordHash: await bcrypt.hash('admin', 4),
  });
  const user = await User.create({
    empNo: USER_EMPNO,
    name: 'User P28',
    role: 'user',
    status: 'active',
    passwordHash: await bcrypt.hash('user', 4),
  });
  const cat = await Category.create({ name: 'p28-base', sort: 0, enabled: true });
  adminId = admin.id;
  userId = user.id;
  baseCategoryId = cat.id;
  adminToken = jwt.sign({ id: admin.id, role: 'admin' }, config.jwt.secret, { expiresIn: '7d' });
  userToken = jwt.sign({ id: user.id, role: 'user' }, config.jwt.secret, { expiresIn: '7d' });
}

test.before(async () => {
  await resetDb();
  await seedFixture();
  await installAiMock();
  setAiHandler(() => passReply());

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
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
          try { parsed = JSON.parse(raw); } catch { parsed = { __raw: raw }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function countAudits(action) {
  const { AuditLog } = getModels();
  return AuditLog.count({ where: { action } });
}

async function lastAudit(action) {
  const { AuditLog } = getModels();
  return AuditLog.findOne({ where: { action }, order: [['id', 'DESC']] });
}

// ============================================================================
// P28.A: category.create — POST /api/admin/categories writes exactly one row
// ============================================================================

test('P28.A: POST /api/admin/categories writes exactly one category.create AuditLog', async () => {
  const nameArb = fc
    .string({ minLength: 1, maxLength: 24, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')) })
    .filter((s) => s.trim().length > 0);

  await fc.assert(
    fc.asyncProperty(nameArb, async (rawName) => {
      const name = `p28-cat-${rawName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const before = await countAudits('category.create');
      const r = await request('POST', '/admin/categories', { name }, adminToken);
      assert.equal(r.status, 200, `category create failed: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 0);
      const after = await countAudits('category.create');
      assert.equal(after - before, 1, 'must write exactly one category.create AuditLog');
      const audit = await lastAudit('category.create');
      assert.equal(audit.targetType, 'category', 'targetType must be "category"');
      assert.equal(audit.targetId, r.body.data.id, 'targetId must match created category id');
      assert.equal(audit.operatorId, adminId, 'operatorId must be the admin');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P28.B: post.create — POST /api/posts writes exactly one row (AI = pass)
// ============================================================================

test('P28.B: POST /api/posts (AI=pass) writes exactly one post.create AuditLog', async () => {
  const titleArb = fc.string({ minLength: 4, maxLength: 60 }).filter((s) => s.trim().length >= 4);
  const contentArb = fc.string({ minLength: 10, maxLength: 200 }).filter((s) => s.trim().length >= 10);

  await fc.assert(
    fc.asyncProperty(titleArb, contentArb, async (title, content) => {
      const before = await countAudits('post.create');
      const r = await request(
        'POST',
        '/posts',
        { title, content, categoryId: baseCategoryId, status: 'published' },
        userToken
      );
      assert.equal(r.status, 200, `post create failed: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 0);
      const after = await countAudits('post.create');
      assert.equal(after - before, 1, 'must write exactly one post.create AuditLog');
      const audit = await lastAudit('post.create');
      assert.equal(audit.targetType, 'post');
      assert.equal(audit.targetId, r.body.data.id, 'targetId must match newly created post id');
      assert.equal(audit.operatorId, userId, 'operatorId must be the post author');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P28.C: post.delete — DELETE /api/posts/:id writes exactly one row
// ============================================================================

test('P28.C: DELETE /api/posts/:id writes exactly one post.delete AuditLog', async () => {
  const { Post } = getModels();

  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 4, maxLength: 32 }).filter((s) => s.trim().length >= 4),
      async (title) => {
        // Pre-create a post owned by the regular user.
        const post = await Post.create({
          title: `del-${title}`,
          content: 'sample content for delete test',
          summary: 'sample',
          authorId: userId,
          categoryId: baseCategoryId,
          status: 'published',
        });
        const before = await countAudits('post.delete');
        const r = await request('DELETE', `/posts/${post.id}`, null, userToken);
        assert.equal(r.status, 200, `delete failed: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, 0);
        const after = await countAudits('post.delete');
        assert.equal(after - before, 1, 'must write exactly one post.delete AuditLog');
        const audit = await lastAudit('post.delete');
        assert.equal(audit.targetType, 'post');
        assert.equal(audit.targetId, post.id, 'targetId must match deleted post id');
        assert.equal(audit.operatorId, userId);
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// P28.D: report.create — POST /api/reports writes exactly one row
// ============================================================================

test('P28.D: POST /api/reports writes exactly one report.create AuditLog', async () => {
  const { Post } = getModels();

  // Pre-create a stable target post so the report references a real id.
  const targetPost = await Post.create({
    title: 'report-target',
    content: 'report-target-content',
    summary: '',
    authorId: adminId,
    categoryId: baseCategoryId,
    status: 'published',
  });

  const reasonArb = fc
    .string({ minLength: 1, maxLength: 60 })
    .filter((s) => s.trim().length > 0);

  await fc.assert(
    fc.asyncProperty(reasonArb, async (reason) => {
      const before = await countAudits('report.create');
      const r = await request(
        'POST',
        '/reports',
        { targetType: 'post', targetId: targetPost.id, reason },
        userToken
      );
      assert.equal(r.status, 200, `report create failed: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 0);
      const after = await countAudits('report.create');
      assert.equal(after - before, 1, 'must write exactly one report.create AuditLog');
      const audit = await lastAudit('report.create');
      assert.equal(audit.targetType, 'post');
      assert.equal(audit.targetId, targetPost.id);
      assert.equal(audit.operatorId, userId);
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P28.E: setting.update — PUT /api/admin/settings writes exactly one row
// ============================================================================

test('P28.E: PUT /api/admin/settings writes exactly one setting.update AuditLog', async () => {
  const KNOWN_KEYS = {
    aiAuditEnabled: 'bool',
    aiExplainEnabled: 'bool',
    aiAskEnabled: 'bool',
    aiAssistEnabled: 'bool',
    aiExplainPerUserDailyLimit: 'number',
    aiAskPerUserDailyLimit: 'number',
    aiAssistPerUserDailyLimit: 'number',
  };
  const keyArb = fc.constantFrom(...Object.keys(KNOWN_KEYS));

  await fc.assert(
    fc.asyncProperty(keyArb, fc.boolean(), fc.integer({ min: 0, max: 9999 }), async (key, b, n) => {
      const value = KNOWN_KEYS[key] === 'bool' ? b : n;
      const before = await countAudits('setting.update');
      const r = await request('PUT', '/admin/settings', { key, value }, adminToken);
      assert.equal(r.status, 200, `setting update failed: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 0);
      const after = await countAudits('setting.update');
      assert.equal(after - before, 1, 'must write exactly one setting.update AuditLog');
      const audit = await lastAudit('setting.update');
      assert.equal(audit.targetType, 'setting');
      assert.equal(audit.operatorId, adminId);
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P28.F: user.update — PUT /api/admin/users/:id/role writes exactly one row
// ============================================================================

test('P28.F: PUT /api/admin/users/:id/role writes exactly one user.update AuditLog', async () => {
  const { User } = getModels();

  // For each iteration we operate on a fresh user so role flipping is harmless.
  let counter = 0;

  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('user', 'moderator'),
      fc.constantFrom('active', 'disabled'),
      async (role, status) => {
        const u = await User.create({
          empNo: `E-VICTIM-P28-${Date.now()}-${++counter}`,
          name: 'victim',
          role: 'user',
          status: 'active',
          passwordHash: 'x',
        });
        const before = await countAudits('user.update');
        const r = await request('PUT', `/admin/users/${u.id}/role`, { role, status }, adminToken);
        assert.equal(r.status, 200, `user.update failed: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, 0);
        const after = await countAudits('user.update');
        assert.equal(after - before, 1, 'must write exactly one user.update AuditLog');
        const audit = await lastAudit('user.update');
        assert.equal(audit.targetType, 'user');
        assert.equal(audit.targetId, u.id);
        assert.equal(audit.operatorId, adminId);
      }
    ),
    { numRuns: 100 }
  );
});
