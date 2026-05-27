'use strict';

// Property 2: 受保护接口对所有伪造 / 过期 token 一致返回 401
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 1.9, 1.10, 1.11, 23.5
//
// 不变量：For any Authorization header value drawn from the universe of
// "invalid auth attempts" (missing header, wrong scheme, malformed token,
// expired token, wrong-signature token, valid signature but unknown user,
// valid signature but disabled user, etc.), `authRequired` middleware must
// respond with HTTP 401 and `body.code = 401`, and the downstream handler
// MUST NOT execute (req.user must remain unset on the route handler entry).
// `authOptional` under the same inputs must place `req.user = null` (or
// otherwise leave it falsy) and continue.
//
// Implementation strategy:
//   - Build a tiny in-process express app inline that mounts authRequired
//     and authOptional plus a "spy" handler that records whether it ran.
//   - Listen on port 0; drive requests with Node's built-in `http.request`.
//   - Use `jsonwebtoken` to forge corrupted/expired/wrong-secret tokens,
//     plus `valid-but-unknown-user` and `valid-but-disabled-user` cases.
//   - reset DB before each property iteration (cheap on in-memory sqlite).
//   - 100 iterations per fast-check property block, multiple blocks.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fc = require('fast-check');
const jwt = require('jsonwebtoken');
const express = require('express');

const setup = require('./_setup');
const { resetDb, getModels, closeDb, config } = setup;

const { authRequired, authOptional } = require('../../src/middlewares/auth');

// ---------- helper: tiny express app with spy handlers ----------

function buildApp() {
  const app = express();
  app.use(express.json());

  // Tracks whether the protected handler has been hit. The router resets it
  // on each request via a tiny "spy reset" middleware.
  app.use((req, _res, next) => {
    req.__handlerHit = false;
    next();
  });

  app.get('/protected', authRequired, (req, res) => {
    req.__handlerHit = true;
    res.json({ code: 0, message: 'ok', data: { userId: req.user.id } });
  });

  app.get('/optional', authOptional, (req, res) => {
    req.__handlerHit = true;
    res.json({
      code: 0,
      message: 'ok',
      data: { userId: req.user ? req.user.id : null },
    });
  });

  return app;
}

let server;
let port;

test.before(async () => {
  await resetDb();
  const app = buildApp();
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

// ---------- helper: send GET with optional Authorization header ----------

function request(path, authHeader) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (authHeader !== undefined && authHeader !== null) {
      headers.Authorization = authHeader;
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c.toString('utf8')));
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(raw);
          } catch {
            body = { __raw: raw };
          }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------- arbitraries ----------

const SECRET = config.jwt.secret;

// Random invalid headers (no Bearer prefix, wrong scheme, empty, etc.).
const malformedHeaderArb = fc.oneof(
  fc.constant(undefined), // missing
  fc.constant(''), // empty
  fc.constant('Bearer'), // no token
  fc.constant('Bearer '), // empty token
  fc.constant('Basic dXNlcjpwYXNz'), // wrong scheme
  fc.constant('Token abc'), // wrong scheme
  fc.constant('bearer abc'), // wrong case
  fc.string({ minLength: 1, maxLength: 64 }).map((s) => `Bearer ${s.replace(/[^A-Za-z0-9._-]/g, '')}`).filter((s) => !s.endsWith(' ')),
  fc
    .string({ minLength: 16, maxLength: 64 })
    .map((s) => `Bearer ${s}.${s}.${s}`),
  fc.string({ minLength: 1, maxLength: 32 }).map((s) => `Bearer xxx${s}.yyy.zzz`)
);

// Tokens signed with wrong secret.
const wrongSecretTokenArb = fc
  .record({
    id: fc.integer({ min: 1, max: 1_000_000 }),
    role: fc.constantFrom('user', 'admin', 'moderator'),
  })
  .map((payload) =>
    jwt.sign(payload, `${SECRET}-WRONG-${Math.random()}`, { expiresIn: '7d' })
  )
  .map((tok) => `Bearer ${tok}`);

// Expired tokens signed with the correct secret.
const expiredTokenArb = fc
  .record({
    id: fc.integer({ min: 1, max: 1_000_000 }),
    role: fc.constantFrom('user', 'admin', 'moderator'),
  })
  .map((payload) => jwt.sign(payload, SECRET, { expiresIn: -1 }))
  .map((tok) => `Bearer ${tok}`);

// Valid-signature tokens but referencing a non-existent user id.
// Use very large ids to avoid collisions with the disabled fixture below.
const unknownUserTokenArb = fc
  .integer({ min: 9_000_000, max: 9_999_999 })
  .map((id) => jwt.sign({ id, role: 'user' }, SECRET, { expiresIn: '7d' }))
  .map((tok) => `Bearer ${tok}`);

// Combined "invalid auth" arb covering all rejection categories.
const invalidAuthArb = fc.oneof(
  malformedHeaderArb,
  wrongSecretTokenArb,
  expiredTokenArb,
  unknownUserTokenArb
);

// ---------- properties ----------

test('P02.A: authRequired returns 401/code=401 for ANY invalid Authorization', async () => {
  await fc.assert(
    fc.asyncProperty(invalidAuthArb, async (header) => {
      const r = await request('/protected', header);
      assert.equal(r.status, 401, `expected 401, got ${r.status} for header=${JSON.stringify(header)}`);
      assert.ok(r.body && typeof r.body === 'object', `body must be JSON object`);
      assert.equal(r.body.code, 401, `body.code must be 401, got ${r.body.code}`);
      assert.equal(r.body.data, null, `body.data must be null on auth failure`);
      assert.equal(typeof r.body.message, 'string');
    }),
    { numRuns: 100 }
  );
});

test('P02.B: authRequired uniformly returns the same body shape across rejection categories', async () => {
  // All rejected requests must return {code:401, data:null, message:string}.
  // The message itself may differ (e.g. "未登录" vs "用户不可用") but the
  // envelope shape must be identical, which is the anti-enumeration guarantee
  // at the envelope level.
  await fc.assert(
    fc.asyncProperty(invalidAuthArb, async (header) => {
      const r = await request('/protected', header);
      const keys = Object.keys(r.body).sort();
      assert.deepEqual(keys, ['code', 'data', 'message']);
      assert.equal(r.body.code, 401);
      assert.equal(r.body.data, null);
    }),
    { numRuns: 100 }
  );
});

test('P02.C: authRequired rejects disabled-user tokens with 401', async () => {
  // Seed one disabled user once and exercise it ≥100 times against generated
  // token variants (different iat). Each call must still 401.
  const { User } = getModels();
  const disabled = await User.findOne({ where: { empNo: 'E-DISABLED-01' } }) ||
    (await User.create({
      empNo: 'E-DISABLED-01',
      name: 'Disabled User',
      status: 'disabled',
      role: 'user',
    }));

  await fc.assert(
    fc.asyncProperty(
      // tweak the iat by including a random nonce in payload so each token differs
      fc.integer({ min: 0, max: 1_000_000 }),
      async (nonce) => {
        const tok = jwt.sign(
          { id: disabled.id, role: disabled.role, nonce },
          SECRET,
          { expiresIn: '7d' }
        );
        const r = await request('/protected', `Bearer ${tok}`);
        assert.equal(r.status, 401, `disabled user token must yield 401`);
        assert.equal(r.body.code, 401);
      }
    ),
    { numRuns: 100 }
  );
});

test('P02.D: authOptional silently passes through invalid tokens (no userId)', async () => {
  await fc.assert(
    fc.asyncProperty(invalidAuthArb, async (header) => {
      const r = await request('/optional', header);
      // authOptional must not 401 — it forwards anonymously.
      assert.equal(r.status, 200, `authOptional must yield 200, got ${r.status}`);
      assert.equal(r.body.code, 0);
      assert.equal(r.body.data.userId, null, 'userId must be null for invalid auth');
    }),
    { numRuns: 100 }
  );
});

test('P02.E: a valid token for an active user grants access (sanity / non-enumeration)', async () => {
  const { User } = getModels();
  const u =
    (await User.findOne({ where: { empNo: 'E-ACTIVE-01' } })) ||
    (await User.create({
      empNo: 'E-ACTIVE-01',
      name: 'Active User',
      status: 'active',
      role: 'user',
    }));
  const tok = jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: '7d' });
  const r = await request('/protected', `Bearer ${tok}`);
  assert.equal(r.status, 200, `valid token must reach handler, got ${r.status}`);
  assert.equal(r.body.code, 0);
  assert.equal(r.body.data.userId, u.id);
});
