'use strict';

// Property 4: 登录失败的反枚举一致性
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 1.4
//
// 不变量：For any login failure variant — (a) non-existent empNo,
// (b) existing empNo + wrong password, (c) disabled user with the right
// password — `POST /api/auth/login` must return an identical response
// envelope: same HTTP status (401), same business code (401), same
// message ("工号或密码错误"). The data field must be null.
//
// This is the "anti-enumeration" guarantee: attackers must not be able to
// discriminate between "user does not exist" and "wrong password" by
// observing the response.
//
// Implementation strategy:
//   - Boot a tiny in-memory express app inline that mounts the auth
//     controller routes only (we do NOT mount the full /api router because
//     it pulls in unrelated controllers and complicates seeding).
//   - Listen on port 0; drive requests via Node's http.request.
//   - Seed exactly one valid user (empNo, password) and one disabled user
//     once before the property loop; resetDb is called in test.before.
//   - Generate non-existent empNos / wrong passwords with fast-check.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fc = require('fast-check');
const bcrypt = require('bcryptjs');
const express = require('express');

const setup = require('./_setup');
const { resetDb, getModels, closeDb } = setup;

const authController = require('../../src/controllers/authController');

// ---------- helper: tiny app ----------

function buildApp() {
  const app = express();
  app.use(express.json());
  const wrap = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
  app.post('/api/auth/login', wrap(authController.localLogin));
  // Default error handler ensures unexpected throws don't leak HTML.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ code: 500, message: 'internal', data: null });
  });
  return app;
}

let server;
let port;

const VALID_EMPNO = 'E-VALID-001';
const VALID_PASSWORD = 'correct-horse-battery';
const DISABLED_EMPNO = 'E-DISABLED-001';
const DISABLED_PASSWORD = 'still-correct-but-disabled';

test.before(async () => {
  await resetDb();
  const { User } = getModels();
  await User.create({
    empNo: VALID_EMPNO,
    name: 'Valid User',
    role: 'user',
    status: 'active',
    passwordHash: await bcrypt.hash(VALID_PASSWORD, 4),
  });
  await User.create({
    empNo: DISABLED_EMPNO,
    name: 'Disabled User',
    role: 'user',
    status: 'disabled',
    passwordHash: await bcrypt.hash(DISABLED_PASSWORD, 4),
  });
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

// ---------- helper: post JSON body ----------

function postJson(path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
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
    req.write(payload);
    req.end();
  });
}

// ---------- arbitraries ----------

// Non-existent empNo: random ASCII strings that are very unlikely to match
// the seeded valid/disabled empNos.
const nonExistentEmpNoArb = fc
  .string({
    minLength: 4,
    maxLength: 16,
    unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
  })
  .map((s) => `Z-${s}`)
  .filter((s) => s !== VALID_EMPNO && s !== DISABLED_EMPNO);

// Non-empty wrong password.
const wrongPasswordArb = fc
  .string({ minLength: 1, maxLength: 32 })
  .filter((s) => s !== VALID_PASSWORD && s !== DISABLED_PASSWORD && s.trim().length > 0);

// ---------- properties ----------

// Reference response that all failures must match.
const EXPECTED_FAIL = {
  status: 401,
  code: 401,
  message: '工号或密码错误',
  data: null,
};

function assertFailureEnvelope(label, resp) {
  assert.equal(resp.status, EXPECTED_FAIL.status, `${label}: HTTP status must be ${EXPECTED_FAIL.status}, got ${resp.status}`);
  assert.ok(resp.body && typeof resp.body === 'object', `${label}: body must be JSON object`);
  // Top-level keys must be exactly the standard envelope.
  const keys = Object.keys(resp.body).sort();
  assert.deepEqual(keys, ['code', 'data', 'message'], `${label}: envelope keys`);
  assert.equal(resp.body.code, EXPECTED_FAIL.code, `${label}: code must be ${EXPECTED_FAIL.code}`);
  assert.equal(resp.body.message, EXPECTED_FAIL.message, `${label}: message must equal anti-enumeration text`);
  assert.equal(resp.body.data, EXPECTED_FAIL.data, `${label}: data must be null`);
}

// P04.A: non-existent empNo → 401 with the canonical message.
test('P04.A: non-existent empNo returns the canonical 401 envelope', async () => {
  await fc.assert(
    fc.asyncProperty(nonExistentEmpNoArb, fc.string({ minLength: 1, maxLength: 32 }), async (empNo, password) => {
      const r = await postJson('/api/auth/login', { empNo, password });
      assertFailureEnvelope(`non-existent empNo=${empNo}`, r);
    }),
    { numRuns: 100 }
  );
});

// P04.B: existing empNo + wrong password → same envelope as above.
test('P04.B: existing empNo + wrong password returns the canonical 401 envelope', async () => {
  await fc.assert(
    fc.asyncProperty(wrongPasswordArb, async (password) => {
      const r = await postJson('/api/auth/login', { empNo: VALID_EMPNO, password });
      assertFailureEnvelope(`existing empNo + wrong pw="${password}"`, r);
    }),
    { numRuns: 100 }
  );
});

// P04.C: disabled user + correct password → same envelope as above.
test('P04.C: disabled user with correct password returns the canonical 401 envelope', async () => {
  // Same canonical message regardless of password correctness, because
  // verifyLocalPassword returns null for disabled users.
  for (let i = 0; i < 100; i++) {
    const r = await postJson('/api/auth/login', {
      empNo: DISABLED_EMPNO,
      password: DISABLED_PASSWORD,
    });
    assertFailureEnvelope('disabled user + correct pw', r);
  }
});

// P04.D: cross-variant indistinguishability — pairwise compare envelopes.
test('P04.D: response envelopes are pairwise identical across all failure variants', async () => {
  await fc.assert(
    fc.asyncProperty(
      nonExistentEmpNoArb,
      wrongPasswordArb,
      async (badEmpNo, wrongPw) => {
        const a = await postJson('/api/auth/login', { empNo: badEmpNo, password: 'whatever' });
        const b = await postJson('/api/auth/login', { empNo: VALID_EMPNO, password: wrongPw });
        const c = await postJson('/api/auth/login', { empNo: DISABLED_EMPNO, password: DISABLED_PASSWORD });
        // All three must share the exact same status + envelope.
        assert.equal(a.status, b.status);
        assert.equal(b.status, c.status);
        assert.deepEqual(a.body, b.body, 'non-existent vs wrong-password envelope must be identical');
        assert.deepEqual(b.body, c.body, 'wrong-password vs disabled envelope must be identical');
      }
    ),
    { numRuns: 100 }
  );
});

// P04.E: input-validation 400 path (missing/empty empNo or password) is
// distinct from the 401 anti-enumeration path. This documents the documented
// boundary in R1.3 and ensures our 401 invariant doesn't bleed into 400.
test('P04.E: missing fields yield 400 (distinct from 401 anti-enumeration)', async () => {
  const cases = [
    {},
    { empNo: '', password: '' },
    { empNo: VALID_EMPNO },
    { password: VALID_PASSWORD },
    { empNo: '', password: VALID_PASSWORD },
    { empNo: VALID_EMPNO, password: '' },
  ];
  for (const body of cases) {
    const r = await postJson('/api/auth/login', body);
    assert.equal(r.status, 400, `body=${JSON.stringify(body)} must yield 400`);
    assert.equal(r.body.code, 1, '400-class business code (1) per fail() default');
    assert.equal(r.body.data, null);
  }
});

// P04.F: success sanity — valid credentials reach the success path.
// Documents that the failure-envelope assertions above are non-vacuous.
test('P04.F: valid credentials succeed (sanity, non-vacuous failure tests)', async () => {
  const r = await postJson('/api/auth/login', {
    empNo: VALID_EMPNO,
    password: VALID_PASSWORD,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 0);
  assert.ok(r.body.data && typeof r.body.data.token === 'string');
  assert.equal(r.body.data.user.empNo, VALID_EMPNO);
  // R1.5: response must NOT contain passwordHash.
  assert.ok(!('passwordHash' in r.body.data.user), 'user payload must not leak passwordHash');
});
