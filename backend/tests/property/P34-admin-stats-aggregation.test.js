'use strict';

// Property 34: 管理后台统计聚合的正确性
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 22.1
//
// 不变量：For any User / Post / Comment / Category / Report data snapshot,
// `GET /api/admin/stats` returns counts that are bit-for-bit equal to the
// independently-computed Sequelize aggregates:
//   - users           === User.count()
//   - posts           === Post.count(   { where: { status: 'published' } })
//   - comments        === Comment.count({ where: { status: 'active'    } })
//   - categories      === Category.count()
//   - pendingReports  === Report.count( { where: { status: 'pending'   } })
//
// Strategy:
//   For each iteration we wipe & re-seed the relevant tables with random sizes
//   per status, then call GET /api/admin/stats and assert the returned values
//   match the directly-aggregated counts.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fc = require('fast-check');
const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');

const setup = require('./_setup');
const { resetDb, getModels, closeDb, config } = setup;

const apiRouter = require('../../src/routes');

// ---------- harness ----------

let server;
let port;
let adminToken;
let adminId;

const ADMIN_EMPNO = 'E-ADMIN-P34';

async function seedAdmin() {
  const { User } = getModels();
  const admin = await User.create({
    empNo: ADMIN_EMPNO,
    name: 'Admin P34',
    role: 'admin',
    status: 'active',
    passwordHash: await bcrypt.hash('admin', 4),
  });
  adminId = admin.id;
  adminToken = jwt.sign({ id: admin.id, role: 'admin' }, config.jwt.secret, { expiresIn: '7d' });
}

test.before(async () => {
  await resetDb();
  await seedAdmin();
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

// Reset everything except the admin user (we keep the admin so its JWT stays
// valid). Returns the admin id so callers can use it as authorId/reporterId.
async function resetDataKeepAdmin() {
  const { User, Post, Comment, Category, Report } = getModels();
  await Promise.all([
    Post.destroy({ where: {}, truncate: true, cascade: false }),
    Comment.destroy({ where: {}, truncate: true, cascade: false }),
    Category.destroy({ where: {}, truncate: true, cascade: false }),
    Report.destroy({ where: {}, truncate: true, cascade: false }),
  ]);
  await User.destroy({ where: { empNo: { [require('sequelize').Op.ne]: ADMIN_EMPNO } } });
}

// Snapshot generator: random counts per relevant status bucket.
const snapshotArb = fc.record({
  extraUsers: fc.integer({ min: 0, max: 6 }),
  publishedPosts: fc.integer({ min: 0, max: 8 }),
  blockedPosts: fc.integer({ min: 0, max: 5 }),
  draftPosts: fc.integer({ min: 0, max: 5 }),
  deletedPosts: fc.integer({ min: 0, max: 5 }),
  activeComments: fc.integer({ min: 0, max: 8 }),
  blockedComments: fc.integer({ min: 0, max: 5 }),
  deletedComments: fc.integer({ min: 0, max: 5 }),
  rootCategories: fc.integer({ min: 0, max: 4 }),
  childCategories: fc.integer({ min: 0, max: 4 }),
  pendingReports: fc.integer({ min: 0, max: 5 }),
  resolvedReports: fc.integer({ min: 0, max: 5 }),
  rejectedReports: fc.integer({ min: 0, max: 5 }),
});

let userSeq = 0;
async function seedSnapshot(s) {
  const { User, Post, Comment, Category, Report } = getModels();

  // Always create at least one category so posts/comments have a valid FK.
  const baseCat = await Category.create({ name: `p34-base-${++userSeq}`, sort: 0, enabled: true });

  // Categories beyond the base cat.
  let extraCategoriesCreated = 0;
  for (let i = 0; i < s.rootCategories; i++) {
    await Category.create({ name: `p34-root-${++userSeq}-${i}`, sort: i, enabled: true });
    extraCategoriesCreated++;
  }
  for (let i = 0; i < s.childCategories; i++) {
    await Category.create({ name: `p34-child-${++userSeq}-${i}`, sort: i, parentId: baseCat.id, enabled: true });
    extraCategoriesCreated++;
  }

  // Extra users (admin already exists).
  for (let i = 0; i < s.extraUsers; i++) {
    await User.create({
      empNo: `E-P34-${++userSeq}`,
      name: `u${userSeq}`,
      role: 'user',
      status: 'active',
      passwordHash: 'x',
    });
  }

  // Posts per status.
  const statusBuckets = [
    ['published', s.publishedPosts],
    ['blocked', s.blockedPosts],
    ['draft', s.draftPosts],
    ['deleted', s.deletedPosts],
  ];
  for (const [status, n] of statusBuckets) {
    for (let i = 0; i < n; i++) {
      await Post.create({
        title: `p34-${status}-${i}`,
        content: 'content',
        summary: '',
        authorId: adminId,
        categoryId: baseCat.id,
        status,
      });
    }
  }

  // Make sure we have at least one post for comments to attach to.
  let anyPost = await Post.findOne();
  if (!anyPost) {
    anyPost = await Post.create({
      title: 'p34-comments-host',
      content: 'host',
      summary: '',
      authorId: adminId,
      categoryId: baseCat.id,
      status: 'published',
    });
  }

  const commentBuckets = [
    ['active', s.activeComments],
    ['blocked', s.blockedComments],
    ['deleted', s.deletedComments],
  ];
  for (const [status, n] of commentBuckets) {
    for (let i = 0; i < n; i++) {
      await Comment.create({
        postId: anyPost.id,
        authorId: adminId,
        content: `c-${status}-${i}`,
        status,
      });
    }
  }

  const reportBuckets = [
    ['pending', s.pendingReports],
    ['resolved', s.resolvedReports],
    ['rejected', s.rejectedReports],
  ];
  for (const [status, n] of reportBuckets) {
    for (let i = 0; i < n; i++) {
      await Report.create({
        reporterId: adminId,
        targetType: 'post',
        targetId: anyPost.id,
        reason: 'r',
        status,
      });
    }
  }
}

// ============================================================================
// P34: GET /api/admin/stats matches independently-computed aggregates.
// ============================================================================

test('P34: GET /api/admin/stats matches independently-computed aggregates', async () => {
  const { User, Post, Comment, Category, Report } = getModels();

  await fc.assert(
    fc.asyncProperty(snapshotArb, async (s) => {
      await resetDataKeepAdmin();
      await seedSnapshot(s);

      // Independently aggregate the truth.
      const [users, posts, comments, categories, pending] = await Promise.all([
        User.count(),
        Post.count({ where: { status: 'published' } }),
        Comment.count({ where: { status: 'active' } }),
        Category.count(),
        Report.count({ where: { status: 'pending' } }),
      ]);

      const r = await request('GET', '/admin/stats', null, adminToken);
      assert.equal(r.status, 200, `stats failed: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 0);
      const data = r.body.data;
      assert.ok(data && typeof data === 'object', 'response.data must be an object');

      assert.equal(data.users, users, 'users count must equal User.count()');
      assert.equal(
        data.posts,
        posts,
        `posts count must equal Post.count(status='published'), expected ${posts} got ${data.posts}`
      );
      assert.equal(
        data.comments,
        comments,
        `comments count must equal Comment.count(status='active'), expected ${comments} got ${data.comments}`
      );
      assert.equal(data.categories, categories, 'categories count must equal Category.count()');
      assert.equal(
        data.pendingReports,
        pending,
        `pendingReports must equal Report.count(status='pending'), expected ${pending} got ${data.pendingReports}`
      );
    }),
    { numRuns: 100 }
  );
});
