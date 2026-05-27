'use strict';

// Property 8: 帖子标签集合不变量
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 6.1, 6.2, 6.3, 6.4
//
// For ANY input array of tag names, after processing through the post tag
// pipeline, the post's tag set must satisfy:
//   (a) total count ≤ 10                                   (R6.1)
//   (b) every tag name is non-empty after cleanPlainText
//       and ≤ 32 chars                                     (R6.2)
//   (c) no duplicate tag names attached to the same post   (R6.2)
//   (d) any non-existing Tag row is auto-created           (R6.3)
//   (e) Tag.usageCount ≥ 1 for every associated tag        (R6.4)
//   (f) old PostTag rows are deleted then recreated; the
//       resulting PostTag set for the post equals the
//       normalized tag set (no orphan rows)                (R6.4)
//
// The test is split in two tiers:
//
//   (A) Pure invariants of the helper `normalizeTags(input) -> string[]`
//       extracted from postController.js (exposed via __test). Cheap,
//       runs at 100 iterations.
//
//   (B) DB-side invariants of `attachTags(post, rawTags)` integration
//       against the in-memory sqlite Sequelize models. DB-heavy, runs at
//       30 iterations per task instructions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const setup = require('./_setup');
const { __test: pcTest } = require('../../src/controllers/postController');
const { cleanPlainText } = require('../../src/utils/sanitize');
const { xssVectorArb } = require('./_arbitraries');

const { normalizeTags, attachTags } = pcTest;

// ---------- Adversarial tag-input generator ----------
//
// Mixes well-formed tags, empty / whitespace strings, overlong strings
// (> 32 chars to exercise truncation), HTML / XSS payloads, and arrays
// long enough to trip the 10-tag cap. Sometimes inserts duplicates by
// drawing from a small constant pool.

const messyTagArb = fc.oneof(
  // common, well-formed tag (likely to repeat across iterations and within
  // the same array)
  fc.constantFrom(
    'java',
    'python',
    'go',
    'react',
    'AI',
    '前端',
    '后端',
    'k8s',
    'redis',
    'docker'
  ),
  // arbitrary short string
  fc.string({ minLength: 0, maxLength: 30 }),
  // overlong string > 32 chars to exercise the truncation rule
  fc.string({ minLength: 33, maxLength: 100 }),
  // empty / whitespace edge cases
  fc.constantFrom('', '   ', '\t', '\n'),
  // HTML / XSS payloads – cleanPlainText must strip these
  xssVectorArb
);

// Up to 25 elements so the 10-cap rule actually has work to do.
const tagInputArb = fc.array(messyTagArb, { minLength: 0, maxLength: 25 });

// ---------- (A) Pure helper invariants ----------

test('P08.a normalizeTags: length ≤ 10, non-empty, ≤32 chars, deduplicated', () => {
  fc.assert(
    fc.property(tagInputArb, (input) => {
      const out = normalizeTags(input);
      assert.ok(Array.isArray(out), 'normalizeTags must return an array');
      assert.ok(
        out.length <= 10,
        `expected ≤ 10 normalized tags, got ${out.length}: ${JSON.stringify(out)}`
      );
      const seen = new Set();
      for (const t of out) {
        assert.equal(typeof t, 'string', 'each element must be a string');
        assert.ok(t.length > 0, 'normalized tag must be non-empty');
        assert.ok(
          t.length <= 32,
          `normalized tag exceeds 32 chars: len=${t.length} val=${JSON.stringify(t)}`
        );
        assert.ok(!seen.has(t), `duplicate tag name in output: ${JSON.stringify(t)}`);
        seen.add(t);
      }
    }),
    { numRuns: 100 }
  );
});

test('P08.a normalizeTags handles non-array input safely', () => {
  for (const v of [null, undefined, 'not-an-array', 42, { foo: 1 }, true]) {
    assert.deepEqual(
      normalizeTags(v),
      [],
      `non-array input ${JSON.stringify(v)} should yield []`
    );
  }
});

test('P08.a normalizeTags is idempotent on its own output', () => {
  fc.assert(
    fc.property(tagInputArb, (input) => {
      const once = normalizeTags(input);
      const twice = normalizeTags(once);
      assert.deepEqual(twice, once, 'normalizeTags must be idempotent');
    }),
    { numRuns: 100 }
  );
});

test('P08.a normalizeTags preserves first-occurrence order', () => {
  fc.assert(
    fc.property(tagInputArb, (input) => {
      const out = normalizeTags(input);
      // Reproduce the expected order via a separate, simple algorithm.
      const expected = [];
      const seen = new Set();
      for (const raw of Array.isArray(input) ? input : []) {
        const cleaned = cleanPlainText(String(raw)).slice(0, 32);
        if (!cleaned) continue;
        if (seen.has(cleaned)) continue;
        seen.add(cleaned);
        expected.push(cleaned);
        if (expected.length >= 10) break;
      }
      assert.deepEqual(out, expected, 'normalizeTags must preserve first-seen order');
    }),
    { numRuns: 100 }
  );
});

// ---------- (B) DB-side integration invariants ----------

test('P08.b attachTags: post tag set satisfies all DB-side invariants', async () => {
  await setup.resetDb();
  const { User, Category, Post, Tag, PostTag } = setup.getModels();

  // One author + one category shared across iterations: FK rows only,
  // no observable state for the assertions below.
  const author = await User.create({
    empNo: 'E_TAGS_AUTHOR',
    name: 'tagger',
    role: 'user',
    status: 'active',
    moderatorCategoryIds: '[]',
  });
  const category = await Category.create({
    name: 'general',
    enabled: true,
  });

  let postSerial = 0;

  await fc.assert(
    fc.asyncProperty(tagInputArb, async (rawTags) => {
      postSerial += 1;
      const post = await Post.create({
        title: `t${postSerial}`,
        content: 'a'.repeat(20),
        summary: '',
        authorId: author.id,
        categoryId: category.id,
        status: 'published',
      });

      // Run the production pipeline.
      await attachTags(post, rawTags);

      const expected = normalizeTags(rawTags);

      // Read back PostTag rows + the corresponding Tag rows.
      const ptRows = await PostTag.findAll({ where: { postId: post.id } });
      const tagIds = ptRows.map((r) => r.tagId);
      const tagRows = tagIds.length
        ? await Tag.findAll({ where: { id: tagIds } })
        : [];
      const persistedNames = tagRows.map((t) => t.name);

      // (a) count ≤ 10
      assert.ok(
        persistedNames.length <= 10,
        `post ${post.id} has ${persistedNames.length} tags (input=${JSON.stringify(rawTags)})`
      );

      // (b) every name is non-empty + ≤ 32 chars
      for (const n of persistedNames) {
        assert.ok(typeof n === 'string', `tag name not a string: ${typeof n}`);
        assert.ok(n.length > 0, 'persisted tag name is empty');
        assert.ok(
          n.length <= 32,
          `persisted tag exceeds 32 chars: len=${n.length} val=${JSON.stringify(n)}`
        );
      }

      // (c) no duplicates within this post
      const uniq = new Set(persistedNames);
      assert.equal(
        uniq.size,
        persistedNames.length,
        `duplicate tag names attached to post ${post.id}: ${JSON.stringify(persistedNames)}`
      );

      // (d) + (f) PostTag set equals normalized input set
      assert.deepEqual(
        [...uniq].sort(),
        [...new Set(expected)].sort(),
        `attached tag set should equal normalizeTags(input). expected=${JSON.stringify(
          expected
        )} got=${JSON.stringify(persistedNames)} input=${JSON.stringify(rawTags)}`
      );

      // (e) usageCount ≥ 1 for every associated tag
      for (const t of tagRows) {
        assert.ok(
          t.usageCount >= 1,
          `tag "${t.name}" usageCount=${t.usageCount} should be ≥ 1 after association`
        );
      }

      // (d') any normalized name has exactly one Tag row in the DB
      //      (auto-create works, no duplicate Tag rows)
      if (expected.length > 0) {
        const dbTagRows = await Tag.findAll({ where: { name: expected } });
        const counts = Object.create(null);
        for (const t of dbTagRows) {
          counts[t.name] = (counts[t.name] || 0) + 1;
        }
        for (const name of expected) {
          assert.equal(
            counts[name],
            1,
            `expected exactly one Tag row with name=${JSON.stringify(name)}, got ${counts[name]}`
          );
        }
      }
    }),
    { numRuns: 30 }
  );
});

test.after(async () => {
  await setup.closeDb();
});
