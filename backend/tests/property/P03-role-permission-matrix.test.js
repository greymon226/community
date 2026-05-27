'use strict';

// Property 3: 角色权限矩阵作为纯函数
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.6, 4.7, 5.8, 8.11, 14.6
//
// 不变量：
//   1) `canModerateCategory(user, categoryId)` 是一个纯函数：
//        - admin 且 status=active        → 永真（任意 categoryId）
//        - moderator 且 status=active 且 categoryId ∈ moderatorCategoryIds → true
//        - 其它任意组合（含 null user / disabled user / role=user）       → false
//      由于 controller 中读取的是 `user.moderatorCategoryIds`（JSON 字符串），
//      实现层使用 `JSON.parse + includes` 做判定。Property 3 也覆盖该解析的纯函数性。
//   2) `requireRole(...allowed)` 是一个纯映射：
//        - 无 req.user → 401 + code=401
//        - req.user.role ∉ allowed → 403 + code=403
//        - req.user.role ∈ allowed → 调用 next() 一次
//
// 实现策略：纯函数测试，不启动 express 也不连数据库。直接 require 中间件并以
// mock res/next 拦截行为。canModerateCategory 是同步纯函数；requireRole
// 是返回 (req, res, next) → void 的纯映射，内部通过 utils/response.fail 写
// envelope。

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  canModerateCategory,
  requireRole,
} = require('../../src/middlewares/auth');

// ---------- mock res ----------

function makeRes() {
  const captured = { statusCode: 200, body: undefined, jsonCalls: 0 };
  const res = {
    status(code) {
      captured.statusCode = code;
      return this;
    },
    json(body) {
      captured.body = body;
      captured.jsonCalls += 1;
      return this;
    },
    captured,
  };
  return res;
}

// ---------- arbitraries ----------

const categoryIdArb = fc.integer({ min: 1, max: 10_000 });

// A non-empty unique array of integer category ids.
const moderatorCategoryIdsArb = fc
  .array(categoryIdArb, { minLength: 0, maxLength: 12 })
  .map((arr) => Array.from(new Set(arr)));

// User-like records used by canModerateCategory. We mirror the production
// shape: moderatorCategoryIds is a JSON-serialized string.
const userArb = fc.record({
  id: fc.integer({ min: 1, max: 1_000_000 }),
  role: fc.constantFrom('user', 'moderator', 'admin'),
  status: fc.constantFrom('active', 'disabled'),
  moderatorCategoryIds: moderatorCategoryIdsArb.map((ids) => JSON.stringify(ids)),
});

// ============================================================================
// P03.A: canModerateCategory matches the documented truth table (active users)
// ============================================================================

test('P03.A: canModerateCategory truth table for active users', () => {
  fc.assert(
    fc.property(userArb, categoryIdArb, (user, categoryId) => {
      // Force status=active to isolate the role+categoryId axis.
      const u = { ...user, status: 'active' };
      const ids = JSON.parse(u.moderatorCategoryIds);
      const got = canModerateCategory(u, categoryId);

      if (u.role === 'admin') {
        assert.equal(got, true, `admin must always return true, got ${got}`);
      } else if (u.role === 'moderator') {
        const expected = ids.includes(categoryId);
        assert.equal(
          got,
          expected,
          `moderator: expected ${expected} for categoryId=${categoryId} ids=${u.moderatorCategoryIds}`
        );
      } else {
        // role = 'user' or any other role
        assert.equal(got, false, `non-admin/non-moderator must return false`);
      }
    }),
    { numRuns: 200 }
  );
});

// ============================================================================
// P03.B: canModerateCategory always returns false for null/undefined user
// ============================================================================

test('P03.B: canModerateCategory(null|undefined, *) === false', () => {
  fc.assert(
    fc.property(categoryIdArb, (categoryId) => {
      assert.equal(canModerateCategory(null, categoryId), false);
      assert.equal(canModerateCategory(undefined, categoryId), false);
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P03.C: canModerateCategory is a *pure* function (deterministic across calls)
// ============================================================================

test('P03.C: canModerateCategory is deterministic across many invocations', () => {
  fc.assert(
    fc.property(userArb, categoryIdArb, (user, categoryId) => {
      const r1 = canModerateCategory(user, categoryId);
      const r2 = canModerateCategory(user, categoryId);
      const r3 = canModerateCategory({ ...user }, categoryId);
      assert.equal(r1, r2, 'same input must yield same output');
      assert.equal(r2, r3, 'cloned user input must yield same output');
      assert.equal(typeof r1, 'boolean', 'output must be boolean');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P03.D: canModerateCategory returns false for malformed moderatorCategoryIds
// ============================================================================

test('P03.D: malformed moderatorCategoryIds JSON falls back to false (moderator)', () => {
  const malformedArb = fc.constantFrom(
    'not-json',
    '{',
    '[',
    'null',
    '{"x":1}',
    '"abc"',
    '12',
    ''
  );
  fc.assert(
    fc.property(malformedArb, categoryIdArb, (badJson, categoryId) => {
      const user = {
        id: 1,
        role: 'moderator',
        status: 'active',
        moderatorCategoryIds: badJson,
      };
      const got = canModerateCategory(user, categoryId);
      // For 'null' / '12' / '"abc"' the parse succeeds but `.includes` is
      // undefined; the implementation catches and returns false. For invalid
      // JSON, the catch likewise returns false.
      assert.equal(got, false, `expected false for malformed ids ${JSON.stringify(badJson)}`);
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P03.E: requireRole — no user → 401/code=401
// ============================================================================

test('P03.E: requireRole(...allowed) returns 401 when req.user is missing', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom('user', 'moderator', 'admin'), { minLength: 1, maxLength: 3 }),
      (allowed) => {
        const mw = requireRole(...allowed);
        const res = makeRes();
        let nextCalls = 0;
        const next = () => {
          nextCalls += 1;
        };
        mw({}, res, next);
        assert.equal(nextCalls, 0, 'next must NOT be called when user missing');
        assert.equal(res.captured.statusCode, 401);
        assert.equal(res.captured.body.code, 401);
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// P03.F: requireRole — user.role NOT in allowed → 403/code=403
// ============================================================================

test('P03.F: requireRole denies users whose role is not in the allowed set', () => {
  fc.assert(
    fc.property(
      // Always pick at least one role and ensure it's a strict subset (not all 3).
      fc
        .subarray(['user', 'moderator', 'admin'], { minLength: 1, maxLength: 2 })
        .filter((arr) => arr.length < 3),
      fc.constantFrom('user', 'moderator', 'admin'),
      (allowed, userRole) => {
        const mw = requireRole(...allowed);
        const res = makeRes();
        let nextCalls = 0;
        const next = () => {
          nextCalls += 1;
        };
        mw({ user: { id: 1, role: userRole } }, res, next);
        if (allowed.includes(userRole)) {
          assert.equal(nextCalls, 1, 'next() must be called when role allowed');
          assert.equal(res.captured.jsonCalls, 0, 'no json envelope on allowed');
        } else {
          assert.equal(nextCalls, 0, 'next() must NOT be called when role disallowed');
          assert.equal(res.captured.statusCode, 403);
          assert.equal(res.captured.body.code, 403);
        }
      }
    ),
    { numRuns: 200 }
  );
});

// ============================================================================
// P03.G: requireRole — granular guarantee that only ALLOW path calls next()
// ============================================================================

test('P03.G: requireRole calls next() exactly once iff role ∈ allowed', () => {
  fc.assert(
    fc.property(
      fc.subarray(['user', 'moderator', 'admin'], { minLength: 1, maxLength: 3 }),
      fc.constantFrom('user', 'moderator', 'admin'),
      (allowed, userRole) => {
        const mw = requireRole(...allowed);
        const res = makeRes();
        let nextCalls = 0;
        mw({ user: { role: userRole } }, res, () => (nextCalls += 1));
        if (allowed.includes(userRole)) {
          assert.equal(nextCalls, 1);
        } else {
          assert.equal(nextCalls, 0);
        }
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// P03.H: admin role bypass — for ANY moderatorCategoryIds (active admin),
//        canModerateCategory is true regardless of categoryId
// ============================================================================

test('P03.H: active admin can moderate ANY category (irrespective of moderatorCategoryIds)', () => {
  fc.assert(
    fc.property(moderatorCategoryIdsArb, categoryIdArb, (ids, categoryId) => {
      const user = {
        id: 1,
        role: 'admin',
        status: 'active',
        moderatorCategoryIds: JSON.stringify(ids),
      };
      assert.equal(canModerateCategory(user, categoryId), true);
    }),
    { numRuns: 100 }
  );
});
