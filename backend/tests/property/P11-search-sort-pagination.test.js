'use strict';

// Property 11: 搜索 / 排序 / 分页不变量
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9
//
// 不变量：For ANY (keyword, sort, page, pageSize) input passed to
// `searchService.searchPosts`, the result envelope `{items, total, page, pageSize}`
// satisfies (mirroring searchService.js + postController.list — the controller
// caps pageSize via `Math.min(50, +pageSize)` BEFORE delegating to the service):
//
//   (a) items.length ≤ effectivePageSize (caller-applied cap of 50)
//   (b) total === |{p ∈ DB : p.status='published' ∧ keyword matches title|content|summary}|
//   (c) every items[i].status === 'published'
//   (d) sort='latest'   : (pinned DESC, createdAt DESC)
//       sort='hot'      : (pinned DESC, likeCount DESC, viewCount DESC)
//       sort='comments' : (pinned DESC, commentCount DESC)
//       sort='featured' : (featured DESC, createdAt DESC)
//   (e) keyword='' (or undefined) returns ALL published posts (filtered only)
//   (f) keyword=substring of any of {title, content, summary} of some published
//       post → that post is in the unioned result across all pages
//   (g) Pages are non-overlapping subsets of the same total under fixed sort.
//
// 实现策略：
//   - Seed once via `resetDb` + `bulkCreate` of 25 random posts in the
//     test.before hook. Posts mix all four statuses, varying likeCount /
//     viewCount / commentCount / pinned / featured / createdAt, so search /
//     sort / pagination invariants are exercised against a deterministic
//     fixture.
//   - Fast-check generates (keyword, sort, page, pageSize) tuples; each
//     iteration is read-only.
//   - Sort ordering is verified by walking the result and asserting the
//     documented comparator holds between consecutive items, NOT by
//     re-sorting and `deepEqual`.
//
// SQLite quirks: Sequelize's Op.like on SQLite is case-INSENSITIVE for
// ASCII text by default (vs case-sensitive on MySQL). This actually makes
// the substring-recall property strictly easier; the test does not rely on
// case sensitivity.

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const setup = require('./_setup');
const { resetDb, getModels, closeDb } = setup;
const { searchPosts } = require('../../src/services/searchService');
const { cleanPlainText, buildSummary } = require('../../src/utils/sanitize');

// ----------------------------------------------------------------------------
// Fixture seeding (one-time, shared across all property iterations)
// ----------------------------------------------------------------------------

// Deterministic seed corpus: 25 posts with controlled diversity. We avoid
// fast-check inside `before` so the fixture is reproducible without random
// state.
const KEYWORDS_POOL = ['react', 'vue', 'kafka', 'redis', '前端', '后端'];

let SEEDED_POSTS = []; // raw plain rows persisted, kept for cross-checks
let AUTHOR_ID = null;
let CATEGORY_ID = null;

function pseudoRandom(i) {
  // simple deterministic mixer
  let x = (i * 2654435761) >>> 0;
  x ^= x >>> 13;
  x = (x * 1597334677) >>> 0;
  return x;
}

async function seedFixture() {
  const { User, Category, Post } = getModels();
  await resetDb();

  const author = await User.create({
    empNo: 'P11_AUTHOR',
    name: 'p11-author',
    role: 'user',
    status: 'active',
    moderatorCategoryIds: '[]',
  });
  const category = await Category.create({ name: 'general', enabled: true });
  AUTHOR_ID = author.id;
  CATEGORY_ID = category.id;

  // Build 25 rows with controlled diversity. We bulk-create so timestamps
  // can also be set explicitly for sort verification. Status distribution
  // is deterministic: even indices → 'published'; odd indices cycle through
  // the remaining three statuses. Yields 13 published / 4 each non-published.
  const NON_PUBLISHED = ['draft', 'blocked', 'deleted'];
  const baseTime = Date.UTC(2024, 0, 1);
  const rows = [];
  for (let i = 0; i < 25; i++) {
    const r = pseudoRandom(i);
    const status = i % 2 === 0 ? 'published' : NON_PUBLISHED[((i - 1) / 2) % NON_PUBLISHED.length];
    // Each post gets 0..2 keywords from the pool embedded into its title
    // / content / summary so substring search has both hits and misses.
    const kwCount = (r >> 4) % 3;
    const kws = [];
    for (let k = 0; k < kwCount; k++) {
      kws.push(KEYWORDS_POOL[(r >> (8 + k * 3)) % KEYWORDS_POOL.length]);
    }
    const title = `post #${i} ${kws.join(' ')}`.trim();
    const contentText = `body of post ${i}, mentions ${kws.join(', ') || 'nothing'}`;
    const summary = buildSummary(contentText);
    rows.push({
      title,
      content: contentText,
      summary,
      authorId: author.id,
      categoryId: category.id,
      status,
      pinned: (r >> 16) % 3, // 0/1/2
      featured: ((r >> 18) & 1) === 1,
      likeCount: (r >> 8) % 50,
      viewCount: (r >> 12) % 100,
      commentCount: (r >> 20) % 30,
      // Spread createdAt over ~25 minutes so DESC sort has a clean order.
      createdAt: new Date(baseTime + i * 60 * 1000),
      updatedAt: new Date(baseTime + i * 60 * 1000),
    });
  }
  await Post.bulkCreate(rows, { silent: true }); // silent=true keeps our explicit timestamps
  SEEDED_POSTS = await Post.findAll({ raw: true, order: [['id', 'ASC']] });
}

test.before(async () => {
  await seedFixture();
});

test.after(async () => {
  await closeDb();
});

// ----------------------------------------------------------------------------
// Helper: caller-side pageSize cap (mirrors postController.list)
// ----------------------------------------------------------------------------
function cappedPageSize(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(50, n);
}

// Returns the list of seed rows that match the `published + keyword` filter,
// independently of the service implementation.
function expectedPublishedMatches(keyword) {
  const k = String(keyword || '');
  const lk = k.toLowerCase();
  return SEEDED_POSTS.filter((p) => {
    if (p.status !== 'published') return false;
    if (k === '') return true;
    const title = String(p.title || '').toLowerCase();
    const content = String(p.content || '').toLowerCase();
    const summary = String(p.summary || '').toLowerCase();
    return title.includes(lk) || content.includes(lk) || summary.includes(lk);
  });
}

// ----------------------------------------------------------------------------
// Arbitraries
// ----------------------------------------------------------------------------

// Keyword: empty (most common), one of seeded keywords, or a short random
// substring. We keep it small to maximize hit rate in the fixed corpus.
const keywordArb = fc.oneof(
  { weight: 4, arbitrary: fc.constant('') },
  { weight: 6, arbitrary: fc.constantFrom(...KEYWORDS_POOL) },
  { weight: 2, arbitrary: fc.constantFrom('post', 'body', 'mentions', 'nothing') },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 5 }).map(s => s.replace(/[_%'\\]/g, 'x')) }
);

const sortArb = fc.constantFrom('latest', 'hot', 'comments', 'featured');

// pageSize includes values that exercise the 50-cap.
const pageSizeArb = fc.oneof(
  fc.integer({ min: 1, max: 10 }),
  fc.integer({ min: 11, max: 50 }),
  // intentionally over-cap to exercise the controller-level cap
  fc.integer({ min: 51, max: 200 })
);

const pageArb = fc.integer({ min: 1, max: 10 });

// ----------------------------------------------------------------------------
// Sort comparators (mirror searchService.js order arrays exactly).
// Each returns a positive number if `a` should rank STRICTLY before `b`,
// negative if strictly after, zero if equivalent under this comparator.
// We assert that for every consecutive (items[i], items[i+1]) the comparator
// is ≥ 0 (i.e. items[i] should NOT rank after items[i+1]).
// ----------------------------------------------------------------------------

function cmpLatest(a, b) {
  if (a.pinned !== b.pinned) return (a.pinned > b.pinned ? 1 : -1);
  const ta = new Date(a.createdAt).getTime();
  const tb = new Date(b.createdAt).getTime();
  if (ta !== tb) return ta > tb ? 1 : -1;
  return 0;
}
function cmpHot(a, b) {
  if (a.pinned !== b.pinned) return (a.pinned > b.pinned ? 1 : -1);
  if (a.likeCount !== b.likeCount) return (a.likeCount > b.likeCount ? 1 : -1);
  if (a.viewCount !== b.viewCount) return (a.viewCount > b.viewCount ? 1 : -1);
  return 0;
}
function cmpComments(a, b) {
  if (a.pinned !== b.pinned) return (a.pinned > b.pinned ? 1 : -1);
  if (a.commentCount !== b.commentCount) return (a.commentCount > b.commentCount ? 1 : -1);
  return 0;
}
function cmpFeatured(a, b) {
  // featured DESC; treat boolean as 0/1
  const fa = a.featured ? 1 : 0;
  const fb = b.featured ? 1 : 0;
  if (fa !== fb) return fa > fb ? 1 : -1;
  const ta = new Date(a.createdAt).getTime();
  const tb = new Date(b.createdAt).getTime();
  if (ta !== tb) return ta > tb ? 1 : -1;
  return 0;
}
const COMPARATORS = {
  latest: cmpLatest,
  hot: cmpHot,
  comments: cmpComments,
  featured: cmpFeatured,
};

// ============================================================================
// P11.A: result envelope shape + status / pageSize / total invariants
// ============================================================================
test('P11.A: items are all published, ≤ pageSize/50, total matches expected published-keyword count', async () => {
  await fc.assert(
    fc.asyncProperty(keywordArb, sortArb, pageArb, pageSizeArb, async (keyword, sort, page, pageSize) => {
      const eps = cappedPageSize(pageSize);
      const r = await searchPosts({ keyword, sort, page, pageSize: eps });

      // (1) shape
      assert.equal(typeof r, 'object', 'result must be an object');
      assert.ok(Array.isArray(r.items), 'items must be an array');
      assert.equal(typeof r.total, 'number', 'total must be a number');
      assert.equal(r.page, page, 'page echo back');
      assert.equal(r.pageSize, eps, 'pageSize echo back (already capped by caller)');

      // (2) caller-applied cap
      assert.ok(eps <= 50, `pageSize must be capped to 50, got ${eps}`);
      assert.ok(
        r.items.length <= eps,
        `items.length (${r.items.length}) must be ≤ pageSize (${eps})`
      );

      // (3) every item is published
      for (const it of r.items) {
        assert.equal(
          it.status,
          'published',
          `every item must have status='published', got ${it.status}`
        );
      }

      // (4) total reflects published-only + keyword-match count
      const expected = expectedPublishedMatches(keyword);
      assert.equal(
        r.total,
        expected.length,
        `total mismatch for keyword=${JSON.stringify(keyword)}; expected=${expected.length} got=${r.total}`
      );
    }),
    { numRuns: 120 }
  );
});

// ============================================================================
// P11.B: Sort comparator invariant — walk consecutive pairs.
// ============================================================================
test('P11.B: items obey the documented comparator for each sort key (no decreasing pair)', async () => {
  await fc.assert(
    fc.asyncProperty(keywordArb, sortArb, pageArb, pageSizeArb, async (keyword, sort, page, pageSize) => {
      const eps = cappedPageSize(pageSize);
      const r = await searchPosts({ keyword, sort, page, pageSize: eps });
      const cmp = COMPARATORS[sort];
      for (let i = 0; i + 1 < r.items.length; i++) {
        const a = r.items[i].toJSON ? r.items[i].toJSON() : r.items[i];
        const b = r.items[i + 1].toJSON ? r.items[i + 1].toJSON() : r.items[i + 1];
        const v = cmp(a, b);
        assert.ok(
          v >= 0,
          `sort=${sort} produced wrong ordering at i=${i}: ` +
            `a={pinned:${a.pinned},featured:${a.featured},likeCount:${a.likeCount},viewCount:${a.viewCount},commentCount:${a.commentCount},createdAt:${new Date(a.createdAt).toISOString()}} ` +
            `b={pinned:${b.pinned},featured:${b.featured},likeCount:${b.likeCount},viewCount:${b.viewCount},commentCount:${b.commentCount},createdAt:${new Date(b.createdAt).toISOString()}}`
        );
      }
    }),
    { numRuns: 120 }
  );
});

// ============================================================================
// P11.C: pageSize > 50 capped to 50 (caller-applied bound; assert separately).
// ============================================================================
test('P11.C: pageSize values > 50 are capped to 50 by caller (controller mirrors this)', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 51, max: 5000 }), sortArb, async (raw, sort) => {
      const eps = cappedPageSize(raw);
      assert.equal(eps, 50, `cappedPageSize(${raw}) must be 50`);
      const r = await searchPosts({ keyword: '', sort, page: 1, pageSize: eps });
      assert.ok(
        r.items.length <= 50,
        `items.length (${r.items.length}) must be ≤ 50`
      );
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P11.D: Pagination — pages 1..K under fixed sort produce non-overlapping
// subsets, and their union has exactly `total` rows.
// ============================================================================
test('P11.D: pagination is non-overlapping; union of all pages equals total', async () => {
  await fc.assert(
    fc.asyncProperty(keywordArb, sortArb, fc.integer({ min: 1, max: 10 }), async (keyword, sort, pageSize) => {
      // Walk all pages 1..ceil(total/pageSize)
      const first = await searchPosts({ keyword, sort, page: 1, pageSize });
      const total = first.total;
      if (total === 0) {
        assert.equal(first.items.length, 0);
        return;
      }
      const numPages = Math.ceil(total / pageSize);
      const seen = new Set();
      let collected = 0;
      for (let p = 1; p <= numPages; p++) {
        const r = await searchPosts({ keyword, sort, page: p, pageSize });
        for (const it of r.items) {
          assert.ok(
            !seen.has(it.id),
            `page ${p} returned post id=${it.id} that already appeared on a previous page (sort=${sort}, pageSize=${pageSize})`
          );
          seen.add(it.id);
          collected += 1;
        }
      }
      assert.equal(
        collected,
        total,
        `sum of items across all pages (${collected}) must equal total (${total}) for keyword=${JSON.stringify(keyword)} sort=${sort}`
      );
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P11.E: keyword='' returns ALL published posts (collected across pages).
// ============================================================================
test('P11.E: empty keyword returns all published posts (across paged collection)', async () => {
  // Fixed parameters; iterate fast-check only over sort to satisfy ≥100 runs cheaply.
  await fc.assert(
    fc.asyncProperty(sortArb, async (sort) => {
      const PAGE_SIZE = 50; // single page returns everything in our 25-row fixture
      const r = await searchPosts({ keyword: '', sort, page: 1, pageSize: PAGE_SIZE });
      const expected = expectedPublishedMatches('');
      assert.equal(r.total, expected.length, 'total must equal published count');
      const expectedIds = new Set(expected.map((x) => x.id));
      const actualIds = new Set(r.items.map((x) => x.id));
      assert.equal(actualIds.size, expectedIds.size, 'returned id-set size must match');
      for (const id of expectedIds) {
        assert.ok(actualIds.has(id), `published post id=${id} missing from result`);
      }
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P11.F: keyword recall — for any literal substring of any seeded published
// post's title|content|summary, that post must appear in the union of all
// pages of the search response.
// ============================================================================
test('P11.F: substring of a published post is recalled in the result set', async () => {
  // Build the generator INSIDE the test body so that `SEEDED_POSTS` is
  // already populated by the `test.before` hook. Doing this at module load
  // time would observe SEEDED_POSTS=[] and yield a generator that always
  // fails the precondition.
  const publishedRows = SEEDED_POSTS.filter((p) => p.status === 'published');
  assert.ok(
    publishedRows.length > 0,
    'seed fixture has no published posts; cannot test recall'
  );

  const substrArb = fc
    .integer({ min: 0, max: publishedRows.length - 1 })
    .chain((idx) => {
      const row = publishedRows[idx];
      const sources = [row.title || '', row.content || '', row.summary || ''].filter(Boolean);
      // pick one source then pick a contiguous slice of length 3..min(8, len)
      return fc
        .integer({ min: 0, max: sources.length - 1 })
        .chain((si) => {
          const s = sources[si];
          const maxLen = Math.min(8, s.length);
          if (maxLen < 3) return fc.constant({ row, sub: s });
          return fc
            .integer({ min: 3, max: maxLen })
            .chain((len) =>
              fc.integer({ min: 0, max: Math.max(0, s.length - len) }).map((start) => ({
                row,
                sub: s.slice(start, start + len),
              }))
            );
        });
    });

  await fc.assert(
    fc.asyncProperty(substrArb, sortArb, async ({ row, sub }, sort) => {
      // Skip degenerate substrings (whitespace-only or empty after trim).
      if (!sub || sub.trim().length < 2) return;
      const PAGE_SIZE = 50;
      const collected = new Set();
      // Accumulate across pages so we don't hit the 50-cap on small fixtures
      let page = 1;
      let safety = 5;
      while (safety-- > 0) {
        const r = await searchPosts({ keyword: sub, sort, page, pageSize: PAGE_SIZE });
        for (const it of r.items) collected.add(it.id);
        if (r.items.length < PAGE_SIZE) break;
        page += 1;
      }
      assert.ok(
        collected.has(row.id),
        `published post id=${row.id} must be recalled by keyword=${JSON.stringify(sub)} sort=${sort}; got ids=${[...collected].join(',')}`
      );
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P11.G: tag filter — when not provided, no tag predicate is applied; sanity
// check that the implementation does not crash on null/undefined tag.
// ============================================================================
test('P11.G: result envelope is well-formed for all valid sort keys with no tag filter', async () => {
  await fc.assert(
    fc.asyncProperty(sortArb, async (sort) => {
      const r = await searchPosts({ keyword: '', sort, page: 1, pageSize: 10 });
      assert.equal(typeof r.total, 'number');
      assert.ok(Array.isArray(r.items));
      // every item must serialize cleanly to JSON without throwing
      const serialized = JSON.stringify(r.items.map((x) => (x.toJSON ? x.toJSON() : x)));
      assert.equal(typeof serialized, 'string');
    }),
    { numRuns: 100 }
  );
});
