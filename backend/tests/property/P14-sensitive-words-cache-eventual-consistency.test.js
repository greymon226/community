'use strict';

// Property 14: 敏感词缓存与库表的最终一致性
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 11.8
//
// 不变量：For ANY sequence of write operations to the `SensitiveWord` table,
// after invoking `Moderation_Service.invalidate()` (the same hook that
// `POST/DELETE /api/admin/sensitive-words` controllers call), the next
// `applySensitiveFilter()` call must reflect the *current* table state:
//   - 一个刚被 INSERT 的词，下次 filter 必定命中（hits 包含它）
//   - 一个刚被 DELETE 的词，下次 filter 必定不再命中（hits 不再包含它，
//     且按其策略产生的副作用消失：mask 不再替换、block 不再 blocked、
//     review 不再 needReview）
//
// 实现策略（写入 → 失效 → 读取的非严格 round-trip）：
//   1. resetDb()，清空 .env 兜底词，避免污染。
//   2. 任意 seed 一段词表 W0 + 调用 invalidate()。
//   3. 验证 filter(textContaining(w in W0)) 命中所有 W0 中被嵌入的词。
//   4. 应用一段写操作序列 ops（INSERT / DELETE）→ 得到 W1。
//   5. 调用 invalidate()。
//   6. 验证 filter(textContaining(w in W1)) 与 W1 完全一致：
//      - W1 中存在的词都命中
//      - W0 中存在但已从 W1 删除的词不再命中
//
// 关于"无 invalidate 时的旧值缓存"：moderationService 用模块级 `cachedWords`
// 缓存。该测试只断言 invalidate 之后的最终一致性，不与未失效情形对照
// （未失效时返回旧值是 *允许的* 行为，并非属性 14 的违反）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const setup = require('./_setup');
const { resetDb, getModels, closeDb, config } = setup;
const moderation = require('../../src/services/moderationService');

// ---------- Test-time isolation of .env fallback words ----------

let savedFallback = null;
test.before(() => {
  savedFallback = config.sensitiveWords.slice();
  config.sensitiveWords.length = 0;
});
test.after(async () => {
  if (Array.isArray(savedFallback)) {
    config.sensitiveWords.length = 0;
    for (const w of savedFallback) config.sensitiveWords.push(w);
  }
  await closeDb();
});

// ---------- Helpers ----------

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a probe text that embeds every word in `set` (separated by neutral
// filler), so that filter() will hit every word still present in W.
function probeText(set) {
  const parts = ['hello'];
  for (const w of set) {
    parts.push(w.word);
    parts.push('xyz');
  }
  return parts.join(' ');
}

// ---------- Arbitraries ----------

const wordArb = fc
  .stringMatching(/^[a-z]{3,8}$/)
  .filter((s) => s.length >= 3);

const strategyArb = fc.constantFrom('mask', 'block', 'review');

// A unique seed word-set: 0..5 entries, dedup by word.
const seedSetArb = fc
  .array(fc.tuple(wordArb, strategyArb), { minLength: 0, maxLength: 5 })
  .map((pairs) => {
    const seen = new Set();
    const out = [];
    for (const [w, s] of pairs) {
      if (seen.has(w)) continue;
      seen.add(w);
      out.push({ word: w, strategy: s });
    }
    return out;
  });

// Mutation operations that hit the same surface area as the admin endpoints:
//   - 'add'   : POST /api/admin/sensitive-words → upsert (word, strategy)
//   - 'remove': DELETE /api/admin/sensitive-words/:id → drop by word
//
// We model 'add' as `findOrCreate(word) + update strategy` (matches
// adminController.addWord) and 'remove' as `destroy({ where: { word } })`
// (the by-id lookup is the same effect at the data level).
const opArb = fc.oneof(
  fc.record({ type: fc.constant('add'), word: wordArb, strategy: strategyArb }),
  fc.record({ type: fc.constant('remove'), word: wordArb })
);

const opSeqArb = fc.array(opArb, { minLength: 0, maxLength: 6 });

// ---------- Database helpers (mirror the admin controller) ----------

async function applyOps(ops) {
  const { SensitiveWord } = getModels();
  for (const op of ops) {
    if (op.type === 'add') {
      const [row, created] = await SensitiveWord.findOrCreate({
        where: { word: op.word },
        defaults: { strategy: op.strategy },
      });
      if (!created) {
        row.strategy = op.strategy;
        await row.save();
      }
    } else if (op.type === 'remove') {
      await SensitiveWord.destroy({ where: { word: op.word } });
    }
  }
}

async function readCurrentSet() {
  const { SensitiveWord } = getModels();
  const rows = await SensitiveWord.findAll();
  return rows.map((r) => ({ word: r.word, strategy: r.strategy }));
}

async function seedWords(words) {
  const { SensitiveWord } = getModels();
  await resetDb();
  if (words.length > 0) {
    await SensitiveWord.bulkCreate(words.map((w) => ({ word: w.word, strategy: w.strategy })));
  }
  moderation.invalidate();
}

// ============================================================================
// P14.A: After insert + invalidate, the new word is observable in filter results.
// ============================================================================

test('P14.A: insert(word) + invalidate() → next filter hits that word', async () => {
  await fc.assert(
    fc.asyncProperty(seedSetArb, wordArb, strategyArb, async (seed, newWord, newStrategy) => {
      // The new word must not collide with any seeded word.
      fc.pre(!seed.some((s) => s.word === newWord));

      await seedWords(seed);

      // Insert a brand-new word, mirroring adminController.addWord.
      const { SensitiveWord } = getModels();
      const [row, created] = await SensitiveWord.findOrCreate({
        where: { word: newWord },
        defaults: { strategy: newStrategy },
      });
      if (!created) {
        row.strategy = newStrategy;
        await row.save();
      }
      moderation.invalidate();

      const text = `prefix ${newWord} suffix`;
      const r = await moderation.applySensitiveFilter(text);

      assert.ok(
        r.hits.includes(newWord),
        `newly inserted word ${JSON.stringify(newWord)} (strategy=${newStrategy}) must hit; ` +
          `hits=${JSON.stringify(r.hits)} text=${JSON.stringify(text)}`
      );
      // Strategy-specific side effects appear:
      if (newStrategy === 'block') {
        assert.equal(r.blocked, true, `block strategy must set blocked=true`);
      }
      if (newStrategy === 'review') {
        assert.equal(r.needReview, true, `review strategy must set needReview=true`);
      }
      if (newStrategy === 'mask') {
        assert.ok(
          r.cleanText.includes('*'.repeat(newWord.length)),
          `mask strategy must produce ${'*'.repeat(newWord.length)} in cleanText; got=${JSON.stringify(r.cleanText)}`
        );
      }
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P14.B: After delete + invalidate, the removed word is no longer observable.
// ============================================================================

test('P14.B: delete(word) + invalidate() → next filter no longer hits that word', async () => {
  await fc.assert(
    fc.asyncProperty(seedSetArb, async (seed) => {
      fc.pre(seed.length >= 1);
      // Choose any seeded word to remove. We always pick seed[0] for
      // deterministic shrinking.
      const target = seed[0];

      await seedWords(seed);

      // Sanity: before deletion the target hits.
      const text = `pre ${target.word} mid ${target.word} post`;
      const before = await moderation.applySensitiveFilter(text);
      assert.ok(
        before.hits.includes(target.word),
        `before deletion: target word ${JSON.stringify(target.word)} must hit; before=${JSON.stringify(before)}`
      );

      // Delete + invalidate.
      const { SensitiveWord } = getModels();
      await SensitiveWord.destroy({ where: { word: target.word } });
      moderation.invalidate();

      const after = await moderation.applySensitiveFilter(text);

      // (1) The deleted word must NOT appear in hits anymore.
      assert.ok(
        !after.hits.includes(target.word),
        `after deletion: target word ${JSON.stringify(target.word)} must NOT hit; after=${JSON.stringify(after)}`
      );

      // (2) Strategy-specific side effects must be absent for the removed word.
      // (Other remaining seed words may still trigger them — so we only assert
      //  that the *count of '*-runs of len(target.word)* is reset to whatever
      //  natural occurrences exist in the original text minus those caused by
      //  the deleted word; here, since target.word is ASCII and not in the
      //  filler, we expect cleanText to no longer contain `'*'.repeat(len)`
      //  as a substring at the *positions* where target.word appeared.
      //  Simpler: target.word itself should be present unmasked in cleanText
      //  if its strategy was 'mask'.)
      if (target.strategy === 'mask') {
        // The original word now survives un-masked at its positions (unless
        // some OTHER remaining seed word happens to be a substring of it,
        // which we filter out below).
        const otherStillMatches = seed
          .filter((s) => s.word !== target.word)
          .some((s) => text.replace(new RegExp(escapeRegExp(s.word), 'gi'), '*'.repeat(s.word.length)).includes(target.word) === false);
        if (!otherStillMatches) {
          assert.ok(
            new RegExp(escapeRegExp(target.word), 'gi').test(after.cleanText),
            `after deletion (mask): target word must survive in cleanText; cleanText=${JSON.stringify(after.cleanText)}`
          );
        }
      }
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P14.C: Full round-trip — apply an arbitrary mix of add / remove ops, then
//        the filter result is consistent with the *current* DB state.
// ============================================================================

test('P14.C: arbitrary add/remove sequence + invalidate() → filter is consistent with current DB state', async () => {
  await fc.assert(
    fc.asyncProperty(seedSetArb, opSeqArb, async (seed, ops) => {
      // Avoid op-vs-seed UNIQUE collisions on `add` of the same word with a
      // different strategy: that's a legitimate update path, allowed by the
      // controller. So no precondition needed here.

      await seedWords(seed);

      // Apply ops, then invalidate.
      await applyOps(ops);
      moderation.invalidate();

      // Read current set after ops.
      const W = await readCurrentSet();

      // Build a probe text that embeds every word in W (and also any seed
      // word that was deleted, so we can confirm absence).
      const allWordsToProbe = new Set([...seed.map((s) => s.word), ...W.map((w) => w.word)]);
      const probe = ['hello', ...Array.from(allWordsToProbe).flatMap((w) => [w, 'xyz'])].join(' ');

      const r = await moderation.applySensitiveFilter(probe);

      // (1) Every word currently in W that is embedded in probe must hit.
      for (const w of W) {
        assert.ok(
          r.hits.includes(w.word),
          `current word ${JSON.stringify(w.word)} (strategy=${w.strategy}) must hit; hits=${JSON.stringify(r.hits)}`
        );
      }

      // (2) Words that were in seed but are no longer in W (and not still
      // present via an `add`) must NOT hit.
      const currentWordSet = new Set(W.map((w) => w.word));
      for (const s of seed) {
        if (!currentWordSet.has(s.word)) {
          assert.ok(
            !r.hits.includes(s.word),
            `removed word ${JSON.stringify(s.word)} must NOT hit anymore; hits=${JSON.stringify(r.hits)}`
          );
        }
      }

      // (3) Aggregate flags reflect ONLY current set strategies.
      const expectedBlocked = W.some((w) => w.strategy === 'block');
      const expectedReview = W.some((w) => w.strategy === 'review');
      assert.equal(
        r.blocked,
        expectedBlocked,
        `blocked must reflect current DB state; W=${JSON.stringify(W)} r=${JSON.stringify(r)}`
      );
      assert.equal(
        r.needReview,
        expectedReview,
        `needReview must reflect current DB state; W=${JSON.stringify(W)} r=${JSON.stringify(r)}`
      );
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P14.D: Empty table after delete-all + invalidate → exact no-match shape.
// ============================================================================

test('P14.D: emptying the table + invalidate() → no-match shape on any input', async () => {
  await fc.assert(
    fc.asyncProperty(seedSetArb, fc.string({ maxLength: 50 }), async (seed, text) => {
      await seedWords(seed);

      // Drop everything.
      const { SensitiveWord } = getModels();
      await SensitiveWord.destroy({ where: {}, truncate: true });
      moderation.invalidate();

      const r = await moderation.applySensitiveFilter(text);

      assert.deepStrictEqual(
        r,
        {
          cleanText: text,
          hits: [],
          blocked: false,
          needReview: false,
        },
        `empty table must produce no-match shape; r=${JSON.stringify(r)}`
      );
    }),
    { numRuns: 100 }
  );
});
