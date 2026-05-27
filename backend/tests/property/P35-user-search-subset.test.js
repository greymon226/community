'use strict';

// Property 35: 用户搜索的子集语义
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 22.2, 22.3
//
// 不变量：For any (keyword, page, pageSize), `GET /api/admin/users?keyword=K`
// satisfies:
//   (a) result.items is a subset of all User rows
//   (b) every returned user satisfies (name|empNo|department) LIKE %K%
//       (case-insensitive), OR K is empty
//   (c) every JSON-serialized user must NOT contain `passwordHash`
//   (d) items are sorted by id ASC, paginated correctly:
//         items === User.findAll(filter).orderBy(id ASC).slice(offset, offset+pageSize)
//       (i.e. equals the deterministic page slice of the filtered set)
//
// Strategy:
//   For each iteration we wipe & re-seed the user table with random users,
//   then call GET /api/admin/users?keyword=K&page=P&pageSize=N and assert
//   the returned items match the locally-computed reference set.

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

const ADMIN_EMPNO = 'E-ADMIN-P35';

async function seedAdmin() {
  const { User } = getModels();
  const admin = await User.create({
    empNo: ADMIN_EMPNO,
    name: 'AdminP35',
    role: 'admin',
    status: 'active',
    department: 'Platform',
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

// Wipe non-admin users between iterations.
async function resetUsersKeepAdmin() {
  const { User } = getModels();
  const { Op } = require('sequelize');
  await User.destroy({ where: { empNo: { [Op.ne]: ADMIN_EMPNO } } });
}

// User generator: name / empNo / department drawn from a small alphabet so
// keyword matches actually fire frequently enough to exercise the subset
// predicate.
const ALPHA = 'abcdefghij';
const tokenArb = fc.string({ minLength: 1, maxLength: 6, unit: fc.constantFrom(...ALPHA.split('')) });

const userSeedArb = fc.record({
  name: tokenArb,
  empNoSuffix: fc.string({
    minLength: 3,
    maxLength: 6,
    unit: fc.constantFrom(...'0123456789'.split('')),
  }),
  department: tokenArb,
});

let seq = 0;
async function seedUsers(seeds) {
  const { User } = getModels();
  const created = [];
  for (const s of seeds) {
    const u = await User.create({
      empNo: `E${s.empNoSuffix}-${++seq}`,
      name: s.name,
      role: 'user',
      status: 'active',
      department: s.department,
      passwordHash: 'should-never-leak',
    });
    created.push(u);
  }
  return created;
}

// Mirror the controller's case-insensitive LIKE semantics.
function matchesKeyword(u, kw) {
  if (!kw) return true;
  const k = kw.toLowerCase();
  return (
    String(u.name || '').toLowerCase().includes(k) ||
    String(u.empNo || '').toLowerCase().includes(k) ||
    String(u.department || '').toLowerCase().includes(k)
  );
}

// Recursively scan a JSON value for forbidden keys.
function containsKey(obj, forbidden) {
  if (obj == null) return false;
  if (Array.isArray(obj)) return obj.some((v) => containsKey(v, forbidden));
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (k === forbidden) return true;
      if (containsKey(obj[k], forbidden)) return true;
    }
  }
  return false;
}

// Generators for the keyword / pagination axes.
//
// NOTE: we intentionally exclude SQL LIKE wildcards (`%`, `_`) from the
// keyword space. The controller uses raw LIKE patterns, so `%` and `_`
// would match every user, breaking the "contains K" subset reading of
// Property 35. SQL-injection safety is covered separately by Property 32
// (P32-sql-injection-safety.test.js).
const keywordArb = fc.oneof(
  fc.constant(''),
  fc.constant('a'),
  fc.constant('e'),
  // SQL-injection-shaped strings (without LIKE wildcards) exercise robustness.
  fc.constantFrom("' OR 1=1 --", '"; DROP --', "x'); --"),
  // 1–4 char alphanum keywords drawn from the same pool as user fields so
  // matches actually happen.
  fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom(...ALPHA.split('')) })
);

const pageArb = fc.integer({ min: 1, max: 4 });
const pageSizeArb = fc.integer({ min: 1, max: 5 });

// ============================================================================
// P35: GET /api/admin/users?keyword=K observes the subset/sort/redact rules.
// ============================================================================

test('P35: admin user search returns sorted, paginated, redacted subset matching keyword', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(userSeedArb, { minLength: 0, maxLength: 12 }),
      keywordArb,
      pageArb,
      pageSizeArb,
      async (seeds, keyword, page, pageSize) => {
        await resetUsersKeepAdmin();
        await seedUsers(seeds);

        const path = `/admin/users?keyword=${encodeURIComponent(keyword)}&page=${page}&pageSize=${pageSize}`;
        const r = await request('GET', path, null, adminToken);
        assert.equal(r.status, 200, `admin/users failed: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, 0, 'expected success envelope');

        const data = r.body.data;
        assert.ok(data && Array.isArray(data.items), 'response.data.items must be an array');
        const items = data.items;

        // (a) Subset of all users (we compare by id, since tables can shift).
        const { User } = getModels();
        const allUsers = await User.findAll({ order: [['id', 'ASC']] });
        const allIds = new Set(allUsers.map((u) => u.id));
        for (const it of items) {
          assert.ok(allIds.has(it.id), `returned user id=${it.id} must exist in User table`);
        }

        // (b) Each returned user must match keyword (or keyword empty).
        for (const it of items) {
          assert.ok(
            matchesKeyword(it, keyword),
            `user (id=${it.id}, name=${it.name}, empNo=${it.empNo}, dept=${it.department}) ` +
              `does not match keyword=${JSON.stringify(keyword)}`
          );
        }

        // (c) No passwordHash anywhere in the response payload.
        assert.ok(
          !containsKey(r.body, 'passwordHash'),
          'response must NEVER include passwordHash'
        );

        // (d) Items are sorted by id ASC and equal the page slice of the
        // independently-filtered universe.
        for (let i = 1; i < items.length; i++) {
          assert.ok(
            items[i - 1].id < items[i].id,
            `items must be strictly increasing by id (i=${i}, prev=${items[i - 1].id}, curr=${items[i].id})`
          );
        }
        const filtered = allUsers.filter((u) => matchesKeyword(u, keyword));
        const offset = (page - 1) * pageSize;
        const expectedSlice = filtered.slice(offset, offset + pageSize).map((u) => u.id);
        const actualIds = items.map((u) => u.id);
        assert.deepEqual(
          actualIds,
          expectedSlice,
          `paged ids must equal filtered.slice(${offset}, ${offset + pageSize}); ` +
            `expected ${JSON.stringify(expectedSlice)} got ${JSON.stringify(actualIds)}`
        );

        // total in response should equal the filtered universe size (sanity).
        assert.equal(
          data.total,
          filtered.length,
          `total must equal filtered count, expected ${filtered.length} got ${data.total}`
        );
      }
    ),
    { numRuns: 100 }
  );
});
