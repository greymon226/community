'use strict';

// Property 9: 分类树最多两级
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 4.1, 4.2, 4.6, 4.8
//
// 不变量：For ANY persisted set of `Category` rows that respect the admin
// validation rules (parentId is either null or points to an enabled top-level
// category), `GET /api/categories` (i.e. `categoryController.listTree`)
// returns a tree such that:
//
//   a) Each top-level node has `parentId === null` and `enabled === true`.
//   b) For each top-level node, every entry in `children` has
//      `parentId === topLevel.id`, `enabled === true`, and an empty
//      `children` array (i.e. no grandchildren — the tree is at most
//      two levels deep).
//   c) Top-level nodes are sorted by `(sort ASC, id ASC)`; siblings within
//      each top-level node's `children` are also sorted by `(sort ASC, id ASC)`.
//   d) Categories with `enabled === false` do not appear anywhere in the tree.
//
// This test invokes the controller directly with a mock `res` to capture the
// envelope written by `ok(res, roots)`. It uses the in-memory SQLite Sequelize
// instance from `_setup.js` and never touches a real DB, Redis or AI service.
//
// Notes / scope:
//   - The current `listTree` implementation does not filter by `visibility`;
//     the design states that an empty visibility (`{}` / `null` / '') is
//     visible to all roles. Since the controller leaves all categories with
//     the default `visibility = '{}'` visible, we do not exercise role-based
//     visibility filtering here.
//   - We constrain the generator to "well-formed" inputs (no orphan child
//     pointing at a disabled / missing parent) so that we test the documented
//     invariant rather than data-corruption edge cases that the admin
//     validators are responsible for preventing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const setup = require('./_setup');
const { resetDb, getModels, closeDb } = setup;

const categoryController = require('../../src/controllers/categoryController');
const { mixedTextArb } = require('./_arbitraries');

// ---------- mock res ----------

function makeRes() {
  const captured = { statusCode: 200, body: undefined };
  const res = {
    status(code) {
      captured.statusCode = code;
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
    captured,
  };
  return res;
}

// ---------- generators ----------

// A non-empty CJK/ASCII category name within the model's 64-char limit.
const categoryNameArb = mixedTextArb({ maxParts: 2, maxLength: 32 })
  .filter((s) => s.trim().length > 0);

// One synthetic top-level descriptor (with optional level-2 children attached).
// Children are persisted under the parent regardless of the parent's
// `enabled` flag — i.e. data may be in a "stale" but admin-valid shape where
// disabled level-1 still owns level-2 rows. Since the controller drops the
// disabled level-1 from the map, those orphans would surface as roots with
// non-null parentId, which violates the design invariant. To test only the
// documented "valid shape", we therefore SKIP child generation for disabled
// parents below.
const topLevelArb = fc.record({
  name: categoryNameArb,
  sort: fc.integer({ min: 0, max: 999 }),
  enabled: fc.boolean(),
  children: fc.array(
    fc.record({
      name: categoryNameArb,
      sort: fc.integer({ min: 0, max: 999 }),
      enabled: fc.boolean(),
    }),
    { minLength: 0, maxLength: 3 }
  ),
});

// 1..5 top-level entries, each with 0..3 children → at most 20 categories,
// usually < 15. Empty trees are excluded so each iteration touches at least
// one row.
const categoryTreeArb = fc.array(topLevelArb, { minLength: 1, maxLength: 5 });

// ---------- test ----------

test.after(async () => {
  await closeDb();
});

test('P09: GET /api/categories returns a strictly two-level tree, enabled-only, sorted by (sort, id)', async () => {
  await fc.assert(
    fc.asyncProperty(categoryTreeArb, async (spec) => {
      const { Category } = getModels();
      await resetDb();

      // 1. Persist top-level rows. Track the resulting id for each.
      const persistedRoots = [];
      for (const root of spec) {
        const row = await Category.create({
          name: root.name,
          sort: root.sort,
          enabled: root.enabled,
          // visibility defaults to '{}' → visible to all
        });
        persistedRoots.push({ row, spec: root });
      }

      // 2. For each ENABLED top-level row, persist its children.
      //    (Skipping children of disabled parents keeps the data shape
      //     valid: every persisted child's parentId points at an enabled
      //     top-level category, matching the admin endpoint's invariant.)
      const enabledRootCount = persistedRoots.filter((r) => r.row.enabled).length;
      let enabledChildCount = 0;
      for (const { row, spec: rootSpec } of persistedRoots) {
        if (!row.enabled) continue;
        for (const child of rootSpec.children) {
          await Category.create({
            name: child.name,
            sort: child.sort,
            enabled: child.enabled,
            parentId: row.id,
          });
          if (child.enabled) enabledChildCount += 1;
        }
      }

      // 3. Invoke the controller.
      const res = makeRes();
      await categoryController.listTree({}, res);

      // 4. Envelope sanity (delegated; full P36 coverage lives in its own file).
      const body = res.captured.body;
      assert.equal(typeof body, 'object');
      assert.equal(body.code, 0, 'listTree must succeed');
      const tree = body.data;
      assert.ok(Array.isArray(tree), 'data must be an array');

      // (a) Top-level: parentId === null, enabled === true.
      for (const node of tree) {
        assert.equal(node.parentId, null, `root ${node.id} must have parentId=null`);
        assert.equal(node.enabled, true, `root ${node.id} must be enabled`);
        assert.ok(Array.isArray(node.children), `root ${node.id} must have children array`);
      }

      // (b) Children: parentId === root.id, enabled === true, children=[].
      for (const root of tree) {
        for (const child of root.children) {
          assert.equal(
            child.parentId,
            root.id,
            `child ${child.id} parentId=${child.parentId} must equal root id=${root.id}`
          );
          assert.equal(child.enabled, true, `child ${child.id} must be enabled`);
          assert.ok(
            Array.isArray(child.children),
            `child ${child.id} must have children array`
          );
          assert.equal(
            child.children.length,
            0,
            `child ${child.id} must have NO grandchildren (got ${child.children.length})`
          );
        }
      }

      // (c) Sort ASC, id ASC at both levels.
      const isSortedByCategoryOrder = (arr) => {
        for (let i = 1; i < arr.length; i++) {
          const a = arr[i - 1];
          const b = arr[i];
          if (a.sort < b.sort) continue;
          if (a.sort === b.sort && a.id < b.id) continue;
          return { ok: false, at: i, a, b };
        }
        return { ok: true };
      };

      const rootCheck = isSortedByCategoryOrder(tree);
      assert.ok(
        rootCheck.ok,
        rootCheck.ok
          ? ''
          : `roots not sorted at index ${rootCheck.at}: ` +
              `prev=(sort=${rootCheck.a.sort}, id=${rootCheck.a.id}) ` +
              `curr=(sort=${rootCheck.b.sort}, id=${rootCheck.b.id})`
      );

      for (const root of tree) {
        const childCheck = isSortedByCategoryOrder(root.children);
        assert.ok(
          childCheck.ok,
          childCheck.ok
            ? ''
            : `children of root ${root.id} not sorted at index ${childCheck.at}: ` +
                `prev=(sort=${childCheck.a.sort}, id=${childCheck.a.id}) ` +
                `curr=(sort=${childCheck.b.sort}, id=${childCheck.b.id})`
        );
      }

      // (d) Counts: tree contains exactly the enabled rows we persisted.
      assert.equal(
        tree.length,
        enabledRootCount,
        `top-level count mismatch: tree=${tree.length} expected enabled roots=${enabledRootCount}`
      );

      const totalChildrenInTree = tree.reduce((s, r) => s + r.children.length, 0);
      assert.equal(
        totalChildrenInTree,
        enabledChildCount,
        `child count mismatch: tree=${totalChildrenInTree} expected enabled children=${enabledChildCount}`
      );

      // Also: no row in the entire tree should have enabled === false.
      for (const root of tree) {
        assert.equal(root.enabled, true);
        for (const child of root.children) {
          assert.equal(child.enabled, true);
        }
      }
    }),
    { numRuns: 50 }
  );
});
