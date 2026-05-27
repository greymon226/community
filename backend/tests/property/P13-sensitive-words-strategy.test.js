'use strict';

// Property 13: 敏感词策略语义
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 11.2, 11.3, 11.4, 11.5, 11.6
//
// 不变量：For ANY (text, words) input, `Moderation_Service.applySensitiveFilter(text)`
// (loaded against the seeded `SensitiveWord` rows + .env fallback) satisfies:
//
//   (a) 未命中：`{ cleanText === text, hits === [], blocked === false, needReview === false }`
//   (b) `mask` 命中：cleanText 长度等于原文长度；命中位置被替换为等长 `*`
//       序列；其它字符保持不变；blocked 仅取决于是否还命中 block 词；
//       needReview 仅取决于是否还命中 review 词
//   (c) `block` 命中：blocked === true；hits 数组包含该词
//   (d) `review` 命中：needReview === true；hits 数组包含该词
//   (e) 同一文本可同时命中多种策略；blocked 与 needReview "二者独立"，
//       即同时命中 block 与 review 词时两者都为 true
//
// 实现策略：
//   - 通过 `setup.resetDb()` + `SensitiveWord.bulkCreate(...)` 在内存 sqlite
//     里重置词库；调用 `moderation.invalidate()` 让进程内 cache 重新加载。
//   - 测试不依赖任何 .env 兜底词；为隔离影响，在 beforeEach 中临时清空
//     `config.sensitiveWords`，结束后恢复（避免污染其他文件）。
//
// 关于命中检测：moderationService 用 `gi` 正则做大小写不敏感匹配。生成器
// 因此把 word 与文本中嵌入的命中片段保持完全一致（小写）以避开大小写陷阱。

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
  // Wipe in place so loadWords() doesn't merge in any extras.
  config.sensitiveWords.length = 0;
});
test.after(async () => {
  // Restore .env fallback for any subsequent test files.
  if (Array.isArray(savedFallback)) {
    config.sensitiveWords.length = 0;
    for (const w of savedFallback) config.sensitiveWords.push(w);
  }
  await closeDb();
});

// ---------- Helpers ----------

// regex-escape (mirrors moderationService.escapeRegExp)
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Compute the expected cleanText: starting from the original text, every word
// whose strategy === 'mask' (regardless of also being block / review — those
// are independent flags per design.md) is replaced by an equal-length run of
// `*`. Order of iteration matches moderationService.applySensitiveFilter's
// for-loop, so any subsequent word matches the already-masked text.
function expectedCleanText(text, words) {
  let out = text;
  for (const { word, strategy } of words) {
    if (!word) continue;
    const re = new RegExp(escapeRegExp(word), 'gi');
    if (strategy === 'mask') {
      out = out.replace(re, '*'.repeat(word.length));
    }
  }
  return out;
}

function expectedFlags(text, words) {
  let blocked = false;
  let needReview = false;
  const hits = [];
  let scratch = text;
  for (const { word, strategy } of words) {
    if (!word) continue;
    const re = new RegExp(escapeRegExp(word), 'gi');
    if (!re.test(scratch)) continue;
    hits.push(word);
    if (strategy === 'block') blocked = true;
    if (strategy === 'review') needReview = true;
    if (strategy === 'mask') {
      scratch = scratch.replace(new RegExp(escapeRegExp(word), 'gi'), '*'.repeat(word.length));
    }
  }
  return { blocked, needReview, hits };
}

// ---------- Arbitraries ----------

// A sensitive word: short ASCII lowercase token. We restrict to letters so
// regex escaping is irrelevant and uniqueness is easy to enforce.
const wordArb = fc
  .stringMatching(/^[a-z]{3,8}$/)
  .filter((s) => s.length >= 3);

const strategyArb = fc.constantFrom('mask', 'block', 'review');

// A unique set of 0..6 sensitive-word entries. Words are deduped before
// converting to {word, strategy} records to satisfy SensitiveWord's UNIQUE
// constraint.
const wordsArb = fc
  .array(fc.tuple(wordArb, strategyArb), { minLength: 0, maxLength: 6 })
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

// A "filler" non-sensitive token to interleave around words.
const fillerArb = fc.stringMatching(/^[A-Za-z0-9 ]{0,12}$/);

// Build the input text by interleaving: optionally embed each generated word
// (with the same casing as the seed list, since the production regex uses
// /gi). We also add a "no-match" path by sometimes emitting only filler.
//
// `embedFlags` is parallel to `words`: if embedFlags[i] is true, the i-th
// word gets embedded at least once.
function buildText(words, embedFlags, fillerParts) {
  const fragments = [];
  fragments.push(fillerParts[0] || '');
  for (let i = 0; i < words.length; i++) {
    if (embedFlags[i]) {
      fragments.push(words[i].word);
    }
    fragments.push(fillerParts[i + 1] || '');
  }
  return fragments.join(' ').trim() || ' ';
}

// Joint generator: words + a text that may or may not embed each word.
const sceneArb = wordsArb.chain((words) =>
  fc
    .tuple(
      fc.array(fc.boolean(), { minLength: words.length, maxLength: words.length }),
      fc.array(fillerArb, { minLength: words.length + 1, maxLength: words.length + 1 })
    )
    .map(([embedFlags, fillerParts]) => ({
      words,
      embedFlags,
      text: buildText(words, embedFlags, fillerParts),
    }))
);

// ---------- Lifecycle: per-iteration DB reset + cache invalidation ----------

async function seedWords(words) {
  const { SensitiveWord } = getModels();
  await resetDb();
  if (words.length > 0) {
    await SensitiveWord.bulkCreate(words.map((w) => ({ word: w.word, strategy: w.strategy })));
  }
  moderation.invalidate();
}

// ============================================================================
// P13.A: 未命中（hits=[]）→ cleanText 原样、blocked=false、needReview=false
// ============================================================================

test('P13.A: no-match → exact shape { cleanText: 原文, hits: [], blocked: false, needReview: false }', async () => {
  await fc.assert(
    fc.asyncProperty(sceneArb, async ({ words, text }) => {
      // Force a no-match scenario: only seed words, but supply text that
      // we are confident contains none of them.
      // We accomplish this by feeding pure-ASCII filler that fast-check
      // generated independently of the words.
      // Approach: rebuild text from words and embedFlags=all-false.
      const noMatchText = text || ' ';
      // If accidentally some word still substring-matches the filler, skip
      // this iteration (fast-check will keep generating more).
      const accidentallyHits = words.some(({ word }) =>
        new RegExp(escapeRegExp(word), 'gi').test(noMatchText)
      );
      fc.pre(!accidentallyHits);

      await seedWords(words);
      const r = await moderation.applySensitiveFilter(noMatchText);

      assert.deepStrictEqual(
        r,
        {
          cleanText: noMatchText,
          hits: [],
          blocked: false,
          needReview: false,
        },
        `no-match must return exact shape; words=${JSON.stringify(words)} text=${JSON.stringify(noMatchText)} got=${JSON.stringify(r)}`
      );
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P13.B: mask 命中 → 等长 * 替换、length 不变、blocked / needReview 取决于
//        其它策略命中（mask 自身不引发 blocked / needReview）
// ============================================================================

test('P13.B: mask hits replace with same-length * and preserve overall length; blocked/needReview only set by their own strategies', async () => {
  await fc.assert(
    fc.asyncProperty(sceneArb, async ({ words, embedFlags, text }) => {
      await seedWords(words);
      const r = await moderation.applySensitiveFilter(text);

      // (a) length preserved
      assert.equal(
        r.cleanText.length,
        text.length,
        `cleanText length must equal input length; words=${JSON.stringify(words)} text=${JSON.stringify(text)} got=${JSON.stringify(r)}`
      );

      // (b) every embedded mask-strategy word should appear in cleanText as
      // an equal-length run of '*'. We don't assert the exact placement
      // (which depends on regex iteration order), but assert that the
      // substring `'*'.repeat(word.length)` is present whenever the word
      // was embedded.
      for (let i = 0; i < words.length; i++) {
        if (!embedFlags[i]) continue;
        const { word, strategy } = words[i];
        if (strategy !== 'mask') continue;
        const stars = '*'.repeat(word.length);
        assert.ok(
          r.cleanText.includes(stars),
          `mask word ${JSON.stringify(word)} (len=${word.length}) must yield ${stars} in cleanText; got=${JSON.stringify(r.cleanText)}`
        );
        // The original word must NOT survive (case-insensitive) in the
        // resulting cleanText.
        const re = new RegExp(escapeRegExp(word), 'i');
        assert.equal(
          re.test(r.cleanText),
          false,
          `mask word ${JSON.stringify(word)} must not survive in cleanText; got=${JSON.stringify(r.cleanText)}`
        );
      }

      // (c) blocked / needReview reflect non-mask strategy hits only —
      // mask itself does NOT set these flags.
      const expected = expectedFlags(text, words);
      assert.equal(r.blocked, expected.blocked, `blocked mismatch`);
      assert.equal(r.needReview, expected.needReview, `needReview mismatch`);
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P13.C: block 命中 → blocked=true 且该词出现在 hits
// ============================================================================

test('P13.C: any hit on a block word sets blocked=true and adds it to hits', async () => {
  await fc.assert(
    fc.asyncProperty(sceneArb, async ({ words, embedFlags, text }) => {
      // Restrict to scenes where at least one block word is embedded.
      const embeddedBlock = words.filter((w, i) => embedFlags[i] && w.strategy === 'block');
      fc.pre(embeddedBlock.length >= 1);

      await seedWords(words);
      const r = await moderation.applySensitiveFilter(text);

      assert.equal(r.blocked, true, `embedded block word must set blocked=true; r=${JSON.stringify(r)}`);
      for (const w of embeddedBlock) {
        assert.ok(
          r.hits.includes(w.word),
          `block word ${JSON.stringify(w.word)} must appear in hits; hits=${JSON.stringify(r.hits)}`
        );
      }
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P13.D: review 命中 → needReview=true 且该词出现在 hits
// ============================================================================

test('P13.D: any hit on a review word sets needReview=true and adds it to hits', async () => {
  await fc.assert(
    fc.asyncProperty(sceneArb, async ({ words, embedFlags, text }) => {
      const embeddedReview = words.filter((w, i) => embedFlags[i] && w.strategy === 'review');
      fc.pre(embeddedReview.length >= 1);

      await seedWords(words);
      const r = await moderation.applySensitiveFilter(text);

      assert.equal(r.needReview, true, `embedded review word must set needReview=true; r=${JSON.stringify(r)}`);
      for (const w of embeddedReview) {
        assert.ok(
          r.hits.includes(w.word),
          `review word ${JSON.stringify(w.word)} must appear in hits; hits=${JSON.stringify(r.hits)}`
        );
      }
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P13.E: blocked 与 needReview 是相互独立的标志位
//        同时命中 block 与 review 词 → 两者都为 true
// ============================================================================

test('P13.E: blocked and needReview are independent (can both be true simultaneously)', async () => {
  // Hand-craft a scenario that always exercises the joint case.
  await fc.assert(
    fc.asyncProperty(
      wordArb,
      wordArb,
      fillerArb,
      fillerArb,
      fillerArb,
      async (a, b, f1, f2, f3) => {
        // Ensure the two words are distinct to avoid UNIQUE conflicts.
        fc.pre(a !== b);
        const words = [
          { word: a, strategy: 'block' },
          { word: b, strategy: 'review' },
        ];
        const text = `${f1} ${a} ${f2} ${b} ${f3}`;

        await seedWords(words);
        const r = await moderation.applySensitiveFilter(text);

        assert.equal(r.blocked, true, `block hit must set blocked=true; r=${JSON.stringify(r)}`);
        assert.equal(r.needReview, true, `review hit must set needReview=true; r=${JSON.stringify(r)}`);
        assert.ok(r.hits.includes(a), `hits must include block word`);
        assert.ok(r.hits.includes(b), `hits must include review word`);
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// P13.F: full-shape consistency
//        For ANY scene, the result shape is exactly { cleanText, hits, blocked, needReview }
//        and `hits` ⊇ all embedded words.
// ============================================================================

test('P13.F: result shape is exact, hits superset of all embedded words', async () => {
  await fc.assert(
    fc.asyncProperty(sceneArb, async ({ words, embedFlags, text }) => {
      await seedWords(words);
      const r = await moderation.applySensitiveFilter(text);

      // Shape: exactly four documented keys.
      assert.deepStrictEqual(
        Object.keys(r).sort(),
        ['blocked', 'cleanText', 'hits', 'needReview'],
        `result shape must be exactly {cleanText, hits, blocked, needReview}; got=${JSON.stringify(Object.keys(r))}`
      );
      assert.equal(typeof r.cleanText, 'string');
      assert.equal(Array.isArray(r.hits), true);
      assert.equal(typeof r.blocked, 'boolean');
      assert.equal(typeof r.needReview, 'boolean');

      // hits superset: every embedded word must be included.
      for (let i = 0; i < words.length; i++) {
        if (!embedFlags[i]) continue;
        // skip mask words that may have been already replaced by an earlier
        // mask iteration (highly unlikely for distinct ASCII tokens but be
        // safe): assert via fresh regex over original text.
        const re = new RegExp(escapeRegExp(words[i].word), 'gi');
        if (!re.test(text)) continue;
        assert.ok(
          r.hits.includes(words[i].word),
          `embedded ${words[i].strategy} word ${JSON.stringify(words[i].word)} should appear in hits; hits=${JSON.stringify(r.hits)}`
        );
      }
    }),
    { numRuns: 100 }
  );
});
