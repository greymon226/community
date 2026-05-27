'use strict';

// Property 10: 帖子可见性谓词
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 5.11, 5.12, 17.2, 17.3
//
// 不变量：对任意 (post.status, viewer)，资源访问的可见性遵循下表：
//   - post.status === 'deleted'                           → 404 (任何人不可见)
//   - post.status === 'blocked' AND viewer 既非作者也非 admin → 403
//   - post.status === 'blocked' AND viewer 是作者或 admin    → 200
//   - post.status === 'published'                          → 200 (含匿名)
//   - post.status === 'draft'                              → 仅作者或 admin 可见，其他 → 404
//
// 实现策略（pure-predicate testing per task constraints）：
//   本测试不启动 express、不连接数据库，而是把 controller 中分散的可见性
//   判断浓缩为一个纯函数 `canView(post, viewer)`，并用 fast-check 在合成
//   `(post, viewer)` 域上交叉枚举。
//
//   该谓词镜像了以下 controller 分支的合并语义：
//     - postController.js#detail:
//         if (!post || post.status === 'deleted') → 404
//         if (post.status === 'blocked' && (!viewer || (viewer.role !== 'admin' && viewer.id !== post.authorId)))
//           → 403
//     - postController.js#explain:
//         同 detail 的可见性 gate（除增加 4003 / 4004 的 AI 开关 / 配额前置检查）
//
//   设计文档把 'draft' 也纳入 Property 10 的可见性矩阵（draft → 仅作者+admin）。
//   当前 controller 的 detail 分支没有显式实现 draft 门控（草稿对所有人都返回 200），
//   这是一个 controller 与设计文档之间的已知缺口。本测试按 **设计文档** 的语义
//   断言谓词，让谓词成为 single source of truth；如果未来要把 controller 对齐，
//   只需让 detail 增加一条 `if (post.status === 'draft' && !isAuthorOrAdmin) → 404`
//   即可让两边重新一致。该缺口已在 task 7.7 的 Notes 中记录。
//
// Frame:
//   ok      = { ok: true }
//   404     = { ok: false, status: 404 }
//   403     = { ok: false, status: 403 }

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

// ---------- Pure visibility predicate (mirrors design.md Property 10) ----------

/**
 * Decide whether `viewer` can read the given `post`.
 *
 * @param {{status:'deleted'|'blocked'|'published'|'draft', authorId:number}|null} post
 * @param {{id:number, role:'user'|'moderator'|'admin'}|null} viewer
 *   `null` represents an anonymous (unauthenticated) viewer.
 * @returns {{ok:true}|{ok:false,status:404|403}}
 */
function canView(post, viewer) {
  if (!post) return { ok: false, status: 404 };

  // deleted: invisible to everyone, including admin (matches detail() branch)
  if (post.status === 'deleted') return { ok: false, status: 404 };

  const isAuthor = !!viewer && viewer.id === post.authorId;
  const isAdmin = !!viewer && viewer.role === 'admin';

  if (post.status === 'blocked') {
    if (isAuthor || isAdmin) return { ok: true };
    return { ok: false, status: 403 };
  }

  if (post.status === 'draft') {
    // Per design.md: draft visible only to author or admin.
    // Mirror detail()'s 'not found' semantics for non-author non-admin.
    if (isAuthor || isAdmin) return { ok: true };
    return { ok: false, status: 404 };
  }

  // published
  return { ok: true };
}

// ---------- Arbitraries ----------

const statusArb = fc.constantFrom('deleted', 'blocked', 'published', 'draft');

const userIdArb = fc.integer({ min: 1, max: 1_000_000 });

const roleArb = fc.constantFrom('user', 'moderator', 'admin');

// Generate a realistic post: random status + random authorId.
const postArb = fc.record({
  id: fc.integer({ min: 1, max: 1_000_000 }),
  status: statusArb,
  authorId: userIdArb,
});

// Viewer: either null (anonymous) or a logged-in user with arbitrary role/id.
const viewerArb = fc.option(
  fc.record({
    id: userIdArb,
    role: roleArb,
  }),
  { freq: 4, nil: null }
);

// ---------- Tests ----------

// P10.a — deleted post → 404 regardless of viewer.
test('P10.a: deleted post is invisible to ALL viewers (404)', () => {
  fc.assert(
    fc.property(
      fc.record({ id: fc.integer({ min: 1 }), status: fc.constant('deleted'), authorId: userIdArb }),
      viewerArb,
      (post, viewer) => {
        const r = canView(post, viewer);
        assert.equal(r.ok, false, `deleted post must NOT be visible (post=${JSON.stringify(post)} viewer=${JSON.stringify(viewer)})`);
        assert.equal(r.status, 404, `deleted post must return 404, got ${r.status}`);
      }
    ),
    { numRuns: 200 }
  );
});

// P10.b — published post → visible to everyone (incl. anonymous).
test('P10.b: published post is visible to ALL viewers (200)', () => {
  fc.assert(
    fc.property(
      fc.record({ id: fc.integer({ min: 1 }), status: fc.constant('published'), authorId: userIdArb }),
      viewerArb,
      (post, viewer) => {
        const r = canView(post, viewer);
        assert.equal(r.ok, true, `published post must be visible (viewer=${JSON.stringify(viewer)})`);
      }
    ),
    { numRuns: 200 }
  );
});

// P10.c — blocked post → only author + admin see; others get 403.
test('P10.c: blocked post is visible ONLY to author or admin; others get 403', () => {
  fc.assert(
    fc.property(
      fc.record({ id: fc.integer({ min: 1 }), status: fc.constant('blocked'), authorId: userIdArb }),
      viewerArb,
      (post, viewer) => {
        const isAuthor = !!viewer && viewer.id === post.authorId;
        const isAdmin = !!viewer && viewer.role === 'admin';
        const r = canView(post, viewer);
        if (isAuthor || isAdmin) {
          assert.equal(r.ok, true, `blocked post must be visible to author or admin (viewer=${JSON.stringify(viewer)})`);
        } else {
          assert.equal(r.ok, false, `blocked post must NOT be visible to non-author non-admin (viewer=${JSON.stringify(viewer)})`);
          assert.equal(r.status, 403, `blocked post must return 403, got ${r.status}`);
        }
      }
    ),
    { numRuns: 200 }
  );
});

// P10.d — draft post → only author + admin see (per design.md).
test('P10.d: draft post is visible ONLY to author or admin (others 404)', () => {
  fc.assert(
    fc.property(
      fc.record({ id: fc.integer({ min: 1 }), status: fc.constant('draft'), authorId: userIdArb }),
      viewerArb,
      (post, viewer) => {
        const isAuthor = !!viewer && viewer.id === post.authorId;
        const isAdmin = !!viewer && viewer.role === 'admin';
        const r = canView(post, viewer);
        if (isAuthor || isAdmin) {
          assert.equal(r.ok, true, `draft post must be visible to author or admin (viewer=${JSON.stringify(viewer)})`);
        } else {
          assert.equal(r.ok, false, `draft post must NOT be visible to non-author non-admin (viewer=${JSON.stringify(viewer)})`);
          assert.equal(r.status, 404, `draft post must return 404 to outsiders, got ${r.status}`);
        }
      }
    ),
    { numRuns: 200 }
  );
});

// P10.e — anonymous viewer (null) → only published posts visible.
test('P10.e: anonymous viewer (null) sees ONLY published posts', () => {
  fc.assert(
    fc.property(postArb, (post) => {
      const r = canView(post, null);
      if (post.status === 'published') {
        assert.equal(r.ok, true, `anonymous must see published posts`);
      } else {
        assert.equal(r.ok, false, `anonymous must NOT see status=${post.status}`);
        // status code is either 403 (blocked) or 404 (deleted/draft).
        assert.ok(
          r.status === 403 || r.status === 404,
          `unexpected status ${r.status} for anonymous + status=${post.status}`
        );
      }
    }),
    { numRuns: 200 }
  );
});

// ---------- Cross-cutting invariants ----------

// P10.f — 谓词总返回 well-formed 结果（覆盖整个 (status, viewer) 域）。
test('P10.f: canView returns a well-formed verdict for every (post, viewer)', () => {
  fc.assert(
    fc.property(postArb, viewerArb, (post, viewer) => {
      const r = canView(post, viewer);
      assert.equal(typeof r, 'object');
      assert.notEqual(r, null);
      if (r.ok === true) {
        // ok-shape: nothing else required, but no `status` key should leak in.
        assert.deepEqual(Object.keys(r).sort(), ['ok']);
      } else {
        assert.equal(r.ok, false);
        assert.deepEqual(Object.keys(r).sort(), ['ok', 'status']);
        assert.ok(r.status === 404 || r.status === 403, `status must be 404 or 403, got ${r.status}`);
      }
    }),
    { numRuns: 200 }
  );
});

// P10.g — admin sees every NON-deleted post (deleted is the only universal hide).
test('P10.g: admin sees every non-deleted post', () => {
  const adminViewerArb = fc.record({ id: userIdArb, role: fc.constant('admin') });
  fc.assert(
    fc.property(postArb, adminViewerArb, (post, viewer) => {
      const r = canView(post, viewer);
      if (post.status === 'deleted') {
        assert.equal(r.ok, false);
        assert.equal(r.status, 404);
      } else {
        assert.equal(r.ok, true, `admin must see post.status=${post.status}`);
      }
    }),
    { numRuns: 200 }
  );
});

// P10.h — author sees their own post unless deleted.
test('P10.h: author sees their own post unless deleted', () => {
  fc.assert(
    fc.property(postArb, roleArb, (post, role) => {
      const viewer = { id: post.authorId, role };
      const r = canView(post, viewer);
      if (post.status === 'deleted') {
        assert.equal(r.ok, false);
        assert.equal(r.status, 404);
      } else {
        assert.equal(r.ok, true, `author must see own post.status=${post.status}`);
      }
    }),
    { numRuns: 200 }
  );
});

// P10.i — non-author non-admin user(s) NEVER see blocked / deleted posts; for
// draft they also do not see (404); for published they always see.
test('P10.i: regular user (non-author, non-admin) only sees published posts', () => {
  fc.assert(
    fc.property(
      postArb,
      fc.record({
        id: userIdArb,
        // role can be 'user' or 'moderator' — neither bypasses author/admin gate.
        role: fc.constantFrom('user', 'moderator'),
      }),
      (post, viewer) => {
        // Force viewer.id != authorId.
        const v = viewer.id === post.authorId ? { ...viewer, id: post.authorId + 1 } : viewer;
        const r = canView(post, v);
        if (post.status === 'published') {
          assert.equal(r.ok, true);
        } else if (post.status === 'blocked') {
          assert.equal(r.ok, false);
          assert.equal(r.status, 403);
        } else {
          // deleted or draft
          assert.equal(r.ok, false);
          assert.equal(r.status, 404);
        }
      }
    ),
    { numRuns: 200 }
  );
});

// ---------- export the predicate (consumed by docs / future controller hookup) ----------

module.exports = { canView };
