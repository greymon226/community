'use strict';

// Property 5: 入参校验必须先于副作用
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 1.3, 2.7, 2.8, 2.9, 3.3, 3.4, 3.5, 4.3, 4.4, 5.1, 5.7, 5.8, 6.1, 6.2, 13.1, 21.3, 21.8
//
// 不变量：For any write endpoint (POST/PUT/DELETE) call whose payload
// fails an input-validation gate (missing required fields, wrong type,
// unknown enum value, missing key for setting), the response must be
// 4xx with code != 0, AND no row may be created/updated in the relevant
// table. AuditLog rows must not be written either, since input failures
// short-circuit before writeAudit().
//
// We exercise a representative subset of write endpoints chosen to span
// the requirement set:
//
//   1) POST /api/posts                — R1.3 / R5.1 input gate
//   2) PUT  /api/users/me             — R3.3 / R3.4 / R3.5 (uniquely:
//                                       this endpoint accepts ANY payload
//                                       and only changes whitelisted
//                                       fields, so we test the
//                                       "no-side-effect for empty payload"
//                                       direction here)
//   3) POST /api/admin/categories     — R4.3 missing name → 400
//   4) POST /api/reports              — R13.1 missing fields → 400
//   5) PUT  /api/admin/settings       — R21.3 unknown key → 400
//
// For each iteration the DB is reset to a known fixture, an invalid
// payload is generated, the request is sent, and we assert:
//   (a) status 4xx + body.code != 0 (or code == 0 with NO state change
//       for the PUT /users/me corner case)
//   (b) the relevant table's row count is identical to its pre-call value
//   (c) AuditLog count for the matching action is unchanged

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

const ADMIN_EMPNO = 'E-ADMIN-P05';
const USER_EMPNO = 'E-USER-P05';

let adminToken;
let userToken;
let adminId;
let userId;
let categoryId;

async function seedFixture() {
  const { User, Category } = getModels();
  const admin = await User.create({
    empNo: ADMIN_EMPNO,
    name: 'Admin Fixture',
    role: 'admin',
    status: 'active',
    passwordHash: await bcrypt.hash('admin', 4),
  });
  const user = await User.create({
    empNo: USER_EMPNO,
    name: 'User Fixture',
    role: 'user',
    status: 'active',
    passwordHash: await bcrypt.hash('user', 4),
  });
  const cat = await Category.create({ name: 'p05-fixture', sort: 0, enabled: true });
  adminId = admin.id;
  userId = user.id;
  categoryId = cat.id;
  adminToken = jwt.sign({ id: admin.id, role: 'admin' }, config.jwt.secret, { expiresIn: '7d' });
  userToken = jwt.sign({ id: user.id, role: 'user' }, config.jwt.secret, { expiresIn: '7d' });
}

test.before(async () => {
  await resetDb();
  await seedFixture();
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  // Catch-all error handler so unexpected throws materialize as 500 rather
  // than hanging the test.
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

// ---------- helper: send request ----------

function request(method, path, body, token) {
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api' + path,
        method,
        headers,
      },
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

async function snapshotCounts() {
  const { Post, Category, Report, AuditLog, SystemSetting } = getModels();
  const [posts, categories, reports, audits, settings] = await Promise.all([
    Post.count(),
    Category.count(),
    Report.count(),
    AuditLog.count(),
    SystemSetting.count(),
  ]);
  return { posts, categories, reports, audits, settings };
}

async function snapshotUserPlus() {
  const { User } = getModels();
  const u = await User.findByPk(userId);
  return {
    nickname: u.nickname,
    bio: u.bio,
    techTags: u.techTags,
    avatar: u.avatar,
    emailNotify: u.emailNotify,
  };
}

// ============================================================================
// P05.A: POST /api/posts — invalid payloads return 4xx without persisting
// ============================================================================

test('P05.A: POST /api/posts rejects invalid payloads with no DB / AuditLog side effect', async () => {
  // Invalid payload generators: missing one or more of (title, content, categoryId).
  const invalidPayloadArb = fc.oneof(
    fc.constant({}),
    fc.record({ title: fc.string({ minLength: 1, maxLength: 32 }) }),
    fc.record({ content: fc.string({ minLength: 1, maxLength: 32 }) }),
    fc.record({ categoryId: fc.integer({ min: 1, max: 10 }) }),
    fc.record({
      title: fc.string({ minLength: 1, maxLength: 16 }),
      content: fc.string({ minLength: 1, maxLength: 16 }),
      // categoryId omitted
    }),
    fc.record({
      title: fc.constant(''),
      content: fc.string({ minLength: 1, maxLength: 16 }),
      categoryId: fc.integer({ min: 1, max: 10 }),
    }),
    fc.record({
      title: fc.string({ minLength: 1, maxLength: 16 }),
      content: fc.constant(''),
      categoryId: fc.integer({ min: 1, max: 10 }),
    })
  );

  await fc.assert(
    fc.asyncProperty(invalidPayloadArb, async (payload) => {
      const before = await snapshotCounts();
      const r = await request('POST', '/posts', payload, userToken);
      assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status} body=${JSON.stringify(r.body)}`);
      assert.notEqual(r.body.code, 0, 'body.code must be non-zero on validation failure');
      const after = await snapshotCounts();
      assert.equal(after.posts, before.posts, 'no Post row may be created');
      assert.equal(after.audits, before.audits, 'no AuditLog row may be written');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P05.B: POST /api/admin/categories — missing name → 400 with no Category row
// ============================================================================

test('P05.B: POST /api/admin/categories rejects missing-name payload with no DB side effect', async () => {
  const invalidPayloadArb = fc.oneof(
    fc.constant({}),
    fc.constant({ name: '' }),
    fc.record({ description: fc.string({ minLength: 1, maxLength: 32 }) }),
    fc.record({ name: fc.constant(undefined), sort: fc.integer({ min: 0, max: 99 }) })
  );

  await fc.assert(
    fc.asyncProperty(invalidPayloadArb, async (payload) => {
      const before = await snapshotCounts();
      const r = await request('POST', '/admin/categories', payload, adminToken);
      assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
      assert.notEqual(r.body.code, 0);
      const after = await snapshotCounts();
      assert.equal(after.categories, before.categories, 'no Category row may be created');
      assert.equal(after.audits, before.audits, 'no AuditLog row may be written');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P05.C: POST /api/reports — missing fields → 400 with no Report row
// ============================================================================

test('P05.C: POST /api/reports rejects invalid payloads with no DB side effect', async () => {
  const invalidPayloadArb = fc.oneof(
    fc.constant({}),
    fc.record({ targetType: fc.constant('post') }), // missing targetId/reason
    fc.record({ targetType: fc.constant('comment'), targetId: fc.integer({ min: 1 }) }), // missing reason
    fc.record({
      targetType: fc.constant('user'), // not in {post,comment}
      targetId: fc.integer({ min: 1 }),
      reason: fc.string({ minLength: 1, maxLength: 32 }),
    }),
    fc.record({
      targetType: fc.constant('post'),
      targetId: fc.constant(0), // falsy
      reason: fc.string({ minLength: 1, maxLength: 32 }),
    }),
    fc.record({
      targetType: fc.constant('post'),
      targetId: fc.integer({ min: 1, max: 999 }),
      reason: fc.constant(''),
    })
  );

  await fc.assert(
    fc.asyncProperty(invalidPayloadArb, async (payload) => {
      const before = await snapshotCounts();
      const r = await request('POST', '/reports', payload, userToken);
      assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status} body=${JSON.stringify(r.body)}`);
      assert.notEqual(r.body.code, 0);
      const after = await snapshotCounts();
      assert.equal(after.reports, before.reports, 'no Report row may be created');
      assert.equal(after.audits, before.audits, 'no AuditLog row may be written');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P05.D: PUT /api/admin/settings — unknown key → 400 with no row + no audit
// ============================================================================

test('P05.D: PUT /api/admin/settings rejects unknown keys with no DB / AuditLog side effect', async () => {
  // Generate keys that are NOT in DEFAULTS.
  const KNOWN_KEYS = new Set([
    'aiAuditEnabled',
    'aiExplainEnabled',
    'aiExplainPerUserDailyLimit',
    'aiAskEnabled',
    'aiAskPerUserDailyLimit',
    'aiAssistEnabled',
    'aiAssistPerUserDailyLimit',
  ]);
  const unknownKeyArb = fc
    .string({
      minLength: 3,
      maxLength: 24,
      unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
    })
    .filter((s) => s.trim().length > 0 && !KNOWN_KEYS.has(s));

  const valueArb = fc.oneof(fc.boolean(), fc.integer(), fc.string({ maxLength: 16 }));

  // Also exercise the missing-key branch.
  const payloadArb = fc.oneof(
    fc.constant({}),
    fc.record({ value: valueArb }),
    fc.record({ key: unknownKeyArb, value: valueArb })
  );

  await fc.assert(
    fc.asyncProperty(payloadArb, async (payload) => {
      const before = await snapshotCounts();
      const r = await request('PUT', '/admin/settings', payload, adminToken);
      assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
      assert.notEqual(r.body.code, 0, 'body.code must be non-zero on invalid setting key');
      const after = await snapshotCounts();
      assert.equal(after.settings, before.settings, 'no SystemSetting row may be created');
      assert.equal(after.audits, before.audits, 'no AuditLog row may be written');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P05.E: PUT /api/users/me — empty / no-op payload must not change user state
// ============================================================================

test('P05.E: PUT /api/users/me with empty payload does not mutate user fields', async () => {
  // Per R3.3, PUT /users/me only recognises the whitelisted fields. Sending
  // a payload that contains ONLY non-whitelisted keys must be a no-op on the
  // user record's whitelisted attributes. (The implementation may still call
  // `u.save()`, which is fine — we only assert observable user-facing fields.)
  const noOpPayloadArb = fc.oneof(
    fc.constant({}),
    fc.dictionary(
      fc.constantFrom('foo', 'bar', 'baz', 'role', 'status', 'empNo', 'passwordHash', 'id'),
      fc.string({ maxLength: 16 }),
      { minKeys: 1, maxKeys: 4 }
    )
  );
  await fc.assert(
    fc.asyncProperty(noOpPayloadArb, async (payload) => {
      const before = await snapshotUserPlus();
      const r = await request('PUT', '/users/me', payload, userToken);
      // Successful no-op or rejected — either is acceptable; what we assert
      // is that whitelisted fields don't drift.
      assert.ok(r.status >= 200 && r.status < 500);
      const after = await snapshotUserPlus();
      assert.deepEqual(after, before, 'whitelisted user fields must remain unchanged for no-op payload');
    }),
    { numRuns: 100 }
  );
});
