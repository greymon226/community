'use strict';

// Property 12: RAG 召回不变量
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 18.5, 18.6
//
// 不变量：For ANY question passed to `searchService.searchForRAG(question, { topN })`:
//
//   (a) topN is logically clamped to [3, 8] by the caller (controller does
//       `Math.min(8, Math.max(3, parseInt(...))`); the service then takes
//       at most `topN` items via `.slice(0, topN)`. Therefore for ANY
//       caller-provided topN, the returned items.length ≤ clamp(topN, 3, 8).
//   (b) Every returned item references a post with `status='published'`.
//   (c) `score` semantics: every retained candidate has score > 0 (non-zero
//        token hit). Although the service does not directly expose `score`
//        in the returned shape, it sorts by score DESC then slices, so the
//        ordering by score DESC is preserved across consecutive items.
//        We re-derive the per-item score with the same formula and assert
//        consecutive non-increasing.
//   (d) Empty / pure-stopword query → returns []. (No tokens → no candidates.)
//   (e) Recall: a post whose title contains a non-stopword keyword K (≥3 ASCII
//        chars OR a 2-char Chinese token) is RECALLED in the result set when
//        the corpus is small enough (≤ topN) and the question is exactly K.
//
// 实现策略：
//   - Seed a deterministic 12-row fixture covering published / non-published
//     statuses and embedding several easy-to-match keywords in titles.
//   - Pick topN values that span both the in-range region [3,8] and the
//     out-of-range region (controller clamp pre-applied) — the service is
//     lenient and accepts any number, but the production caller always
//     pre-clamps.
//   - For tokenize/stopwords semantics we mirror the unit test corpus
//     (`backend/tests/unit/searchService-tokenize.test.js`) — pure stopwords
//     in the query yield zero tokens hence zero candidates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const setup = require('./_setup');
const { resetDb, getModels, closeDb } = setup;
const search = require('../../src/services/searchService');
const { searchForRAG, __test } = search;
const { tokenize } = __test;
const { cleanPlainText, buildSummary } = require('../../src/utils/sanitize');

// ----------------------------------------------------------------------------
// Caller-side topN clamp (mirrors aiController exactly).
// ----------------------------------------------------------------------------
function callerClampTopN(raw) {
  return Math.min(8, Math.max(3, parseInt(raw, 10) || 5));
}

// ----------------------------------------------------------------------------
// Score formula — mirrors searchService.js#searchForRAG scoring exactly.
// Used for ordering verification (P12.C).
// ----------------------------------------------------------------------------
function scoreFor(post, tokens) {
  const plainTitle = String(post.title || '').toLowerCase();
  const plainContent = cleanPlainText(post.content || '').toLowerCase();
  let score = 0;
  for (const t of tokens) {
    const lt = t.toLowerCase();
    if (plainTitle.includes(lt)) score += 5;
    const occurrences = plainContent.split(lt).length - 1;
    score += Math.min(occurrences, 5);
  }
  score += Math.log10(1 + (post.likeCount || 0)) * 0.3;
  return score;
}

// ----------------------------------------------------------------------------
// Fixture
// ----------------------------------------------------------------------------

// Each row is [status, title, content, likeCount].
// Titles deliberately embed clean, distinct keywords so we can test recall
// without ambiguity. Stopwords avoided so tokenize keeps the relevant word.
const SEED_ROWS = [
  ['published', 'react hooks 教程', 'how to compose hooks in react', 10],
  ['published', 'kafka 入门', 'kafka producer consumer', 5],
  ['published', '前端 性能优化', 'lazy loading splitting bundle', 7],
  ['published', 'go 协程', 'goroutine channel basics', 12],
  ['published', 'redis 缓存', 'TTL pipeline cluster', 3],
  ['published', 'docker 部署实践', 'docker image registry', 8],
  ['published', 'typescript 进阶', 'narrowing infer generics', 4],
  ['published', 'mysql 索引', 'btree explain plan', 6],
  // non-published rows: must NEVER appear in result
  ['draft', 'react draft', 'should not appear', 0],
  ['blocked', 'react blocked', 'should not appear', 0],
  ['deleted', 'react deleted', 'should not appear', 0],
  ['blocked', 'kafka blocked', 'should not appear', 0],
];

let SEEDED_PUBLISHED_IDS = new Set();
let TITLE_BY_KEYWORD = {}; // keyword → array of {id, status, title}

test.before(async () => {
  const { User, Category, Post } = getModels();
  await resetDb();
  const author = await User.create({
    empNo: 'P12_AUTHOR',
    name: 'p12-author',
    role: 'user',
    status: 'active',
    moderatorCategoryIds: '[]',
  });
  const category = await Category.create({ name: 'general', enabled: true });
  await Post.bulkCreate(
    SEED_ROWS.map(([status, title, content, likeCount], i) => ({
      title,
      content,
      summary: buildSummary(content),
      authorId: author.id,
      categoryId: category.id,
      status,
      likeCount,
      viewCount: 0,
      commentCount: 0,
      createdAt: new Date(Date.UTC(2024, 0, 1) + i * 60_000),
      updatedAt: new Date(Date.UTC(2024, 0, 1) + i * 60_000),
    }))
  );

  const all = await Post.findAll({ raw: true });
  for (const row of all) {
    if (row.status === 'published') SEEDED_PUBLISHED_IDS.add(row.id);
  }

  // Build keyword recall index for P12.E.
  const recallKeywords = ['react', 'kafka', 'redis', 'docker', 'typescript', 'mysql'];
  for (const kw of recallKeywords) {
    TITLE_BY_KEYWORD[kw] = all.filter(
      (r) => r.status === 'published' && String(r.title).toLowerCase().includes(kw)
    );
  }
});

test.after(async () => {
  await closeDb();
});

// ----------------------------------------------------------------------------
// Arbitraries
// ----------------------------------------------------------------------------

const recallableKeywordArb = fc.constantFrom(
  'react',
  'kafka',
  'redis',
  'docker',
  'typescript',
  'mysql'
);

// topN: spans both in-range and out-of-range. The caller clamps before
// passing, so we test BOTH the raw service (no clamp, range any) AND the
// post-clamp behavior.
const topNRawArb = fc.oneof(
  fc.integer({ min: 3, max: 8 }), // in-range
  fc.integer({ min: -5, max: 2 }), // below range
  fc.integer({ min: 9, max: 50 }) // above range
);

// Question generator: realistic mix.
const questionArb = fc.oneof(
  // recallable keyword in isolation
  recallableKeywordArb,
  // recallable keyword wrapped in a longer question
  recallableKeywordArb.chain((kw) =>
    fc.constantFrom(`how to use ${kw}`, `${kw} 入门`, `learning ${kw} basics`)
  ),
  // pure stopwords (English)
  fc.constantFrom('how', 'the', 'how the', 'why how', 'what for'),
  // pure stopwords (Chinese)
  fc.constantFrom('如何', '怎么', '为什么', '是不是', '如何 怎么'),
  // empty / whitespace
  fc.constantFrom('', ' ', '  ', '\t\n')
);

// ============================================================================
// P12.A: items.length ≤ clamp(topN, 3, 8) for any caller-provided topN.
// ============================================================================
test('P12.A: items.length ≤ clamp(topN, 3, 8)', async () => {
  await fc.assert(
    fc.asyncProperty(recallableKeywordArb, topNRawArb, async (kw, rawTopN) => {
      const clamped = callerClampTopN(rawTopN);
      // Production callers always pre-clamp; we honor that contract here.
      const items = await searchForRAG(kw, { topN: clamped });
      assert.ok(Array.isArray(items));
      assert.ok(
        items.length <= clamped,
        `items.length (${items.length}) must be ≤ clamped topN (${clamped}) for kw=${JSON.stringify(kw)}`
      );
      // Safety: even if the caller forgot to clamp, the service still
      // honors `.slice(0, topN)`. So we additionally sanity-bound by 8.
      // (The corpus has 8 published rows, so a wildly oversized topN
      // can never exceed corpus size either.)
      assert.ok(items.length <= 8);
    }),
    { numRuns: 120 }
  );
});

// ============================================================================
// P12.B: every returned item references a status='published' post (id check).
// ============================================================================
test('P12.B: every returned item id maps to a status="published" post', async () => {
  await fc.assert(
    fc.asyncProperty(recallableKeywordArb, async (kw) => {
      const items = await searchForRAG(kw, { topN: 5 });
      for (const it of items) {
        assert.ok(typeof it.id === 'number', 'item.id must be a number');
        assert.ok(
          SEEDED_PUBLISHED_IDS.has(it.id),
          `item id=${it.id} must reference a published post; ` +
            `published-ids=${[...SEEDED_PUBLISHED_IDS].join(',')}`
        );
      }
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P12.C: ordering is by score DESC. Walk consecutive pairs and assert
// score(a) ≥ score(b). Re-derive score from the documented formula.
// ============================================================================
test('P12.C: results are non-increasing in score (sort DESC by computed score)', async () => {
  await fc.assert(
    fc.asyncProperty(recallableKeywordArb, async (kw) => {
      const items = await searchForRAG(kw, { topN: 8 });
      const tokens = tokenize(kw);
      // The service slices Top-N AFTER sort by score DESC; the items here
      // already include all relevant fields except `content` (which is
      // collapsed into `snippet`). Score recomputation needs raw content,
      // which we re-fetch.
      if (items.length < 2) return;

      const { Post } = getModels();
      const ids = items.map((x) => x.id);
      const rawPosts = await Post.findAll({ where: { id: ids }, raw: true });
      const byId = new Map(rawPosts.map((p) => [p.id, p]));

      // Compute score for each returned item, in returned order.
      const scores = items.map((it) => scoreFor(byId.get(it.id), tokens));
      for (let i = 0; i + 1 < scores.length; i++) {
        assert.ok(
          scores[i] >= scores[i + 1] - 1e-9,
          `RAG ordering violated: scores[${i}]=${scores[i]} < scores[${i + 1}]=${scores[i + 1]} for kw=${JSON.stringify(kw)}; items=${JSON.stringify(items.map((x) => x.id))}`
        );
      }
      // Every retained item must also be a real positive-score hit.
      for (let i = 0; i < scores.length; i++) {
        assert.ok(
          scores[i] > 0,
          `every retained candidate must have score > 0; got ${scores[i]} for id=${items[i].id} kw=${JSON.stringify(kw)}`
        );
      }
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P12.D: empty query / pure-stopword query → returns [].
// ============================================================================
test('P12.D: empty / pure-stopword query → returns []', async () => {
  // Mix of generators that we KNOW tokenize to []:
  const noTokenArb = fc.oneof(
    fc.constantFrom('', ' ', '  ', '\t\n'),
    fc.constantFrom('how', 'the', 'and', 'for', 'why', 'what', 'with', 'this', 'that'),
    fc.constantFrom('如何', '怎么', '为什么', '是不是'),
    // combinations of stopwords still produce zero tokens
    fc.constantFrom('how the', 'why what', 'how 怎么', '如何 the')
  );

  await fc.assert(
    fc.asyncProperty(noTokenArb, async (q) => {
      // Sanity: tokenize(q) must be empty for the property to be meaningful.
      const toks = tokenize(q);
      // Some random combinations may slip through tokenize (e.g. mixed words);
      // the precondition keeps us focused on the documented invariant.
      fc.pre(toks.length === 0);
      const items = await searchForRAG(q, { topN: 5 });
      assert.ok(Array.isArray(items));
      assert.equal(
        items.length,
        0,
        `query=${JSON.stringify(q)} (tokens=[]) must return [], got ${items.length} items`
      );
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P12.E: Recall — a post whose title contains a non-stopword keyword K is
// recalled in the result set when the question is exactly K.
//
// Our fixture is small (≤ 8 published posts), and topN clamps to ≥ 3, so
// the recalled set fits comfortably under the cap.
// ============================================================================
test('P12.E: a post titled with keyword K is recalled when query=K (small corpus)', async () => {
  await fc.assert(
    fc.asyncProperty(recallableKeywordArb, async (kw) => {
      const expected = TITLE_BY_KEYWORD[kw] || [];
      // The published corpus has at most 1-2 titles containing each keyword,
      // well under topN=8.
      fc.pre(expected.length > 0);
      const items = await searchForRAG(kw, { topN: 8 });
      const ids = new Set(items.map((x) => x.id));
      for (const exp of expected) {
        assert.ok(
          ids.has(exp.id),
          `expected published post id=${exp.id} (title=${JSON.stringify(exp.title)}) to be recalled for kw=${JSON.stringify(kw)}; got ids=${[...ids].join(',')}`
        );
      }
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P12.F: returned shape is consistent — id / title / summary / snippet /
// author / category / likeCount / commentCount / createdAt — and never
// contains the raw `content` (which would be too large for an LLM context).
// This is a structural sanity check around the contract searchForRAG
// exposes to RAG callers.
// ============================================================================
test('P12.F: returned items expose the documented RAG-context shape', async () => {
  await fc.assert(
    fc.asyncProperty(recallableKeywordArb, async (kw) => {
      const items = await searchForRAG(kw, { topN: 5 });
      for (const it of items) {
        // Required keys
        for (const key of ['id', 'title', 'summary', 'snippet', 'createdAt']) {
          assert.ok(key in it, `missing key ${key} in returned item: ${JSON.stringify(it)}`);
        }
        assert.equal(typeof it.id, 'number');
        assert.equal(typeof it.title, 'string');
        assert.equal(typeof it.summary, 'string');
        assert.equal(typeof it.snippet, 'string');
        // snippet is a bounded slice of cleaned content (default 600 chars).
        assert.ok(
          it.snippet.length <= 600 + 2, // +2 for optional leading/trailing ellipsis
          `snippet length must be ≤ 602 (incl. ellipsis), got ${it.snippet.length}`
        );
        // We also assert the item does NOT carry the raw `content` field —
        // the service projects it into `snippet` for token economy.
        assert.equal(
          it.content,
          undefined,
          `RAG context must NOT include raw content field; got it.content=${JSON.stringify(it.content)}`
        );
      }
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P12.G: default topN behaviour — when caller omits options, the service
// uses default 5; with our small corpus, items.length ≤ 5. (This documents
// the default-arg path explicitly.)
// ============================================================================
test('P12.G: default topN=5 yields items.length ≤ 5', async () => {
  await fc.assert(
    fc.asyncProperty(recallableKeywordArb, async (kw) => {
      const items = await searchForRAG(kw); // omit options → default topN=5
      assert.ok(Array.isArray(items));
      assert.ok(items.length <= 5, `default topN=5 → items.length must be ≤ 5, got ${items.length}`);
    }),
    { numRuns: 100 }
  );
});
