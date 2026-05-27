'use strict';

// Common fast-check arbitraries for property tests.
//
// Field length / shape constraints are derived directly from the model
// definitions in src/models/*.js so generated values are always persistable.
//
// Naming convention: <thing>Arb (suffix `Arb`).
//
// File name starts with `_` so it is NOT collected by `npm run test:property`.

const fc = require('fast-check');

// ---------- Primitive helpers ----------

/** Printable ASCII excluding control characters and HTML-significant glyphs. */
const SAFE_TEXT_CHAR = fc
  .integer({ min: 0x20, max: 0x7e })
  .map((n) => String.fromCharCode(n))
  .filter((c) => !'<>&"\''.includes(c));

const safeAsciiArb = (opts = {}) =>
  fc.string({ minLength: opts.minLength || 1, maxLength: opts.maxLength || 32, unit: SAFE_TEXT_CHAR });

/** Mixed CJK + ASCII string for realistic post titles / content. */
const cjkChunkArb = fc.stringMatching(/^[\u4e00-\u9fa5]{1,8}$/);
const asciiWordArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,15}$/);
const mixedTextArb = (opts = {}) =>
  fc
    .array(fc.oneof(cjkChunkArb, asciiWordArb), { minLength: 1, maxLength: opts.maxParts || 8 })
    .map((parts) => parts.join(' ').slice(0, opts.maxLength || 200));

// ---------- User ----------

const empNoArb = fc
  .integer({ min: 1000, max: 99999999 })
  .map((n) => `E${n}`);

const userNameArb = mixedTextArb({ maxParts: 3, maxLength: 32 }).filter((s) => s.trim().length > 0);

const techTagArb = fc.oneof(
  fc.constantFrom(
    'java', 'python', 'javascript', 'typescript', 'go', 'rust', 'react',
    'vue', 'node', 'spring', 'kafka', 'docker', 'k8s', 'redis', 'mysql',
    'AI', '前端', '后端', '运维', '数据库'
  ),
  asciiWordArb,
  cjkChunkArb
);

/**
 * A user object suitable for `User.create(...)`.
 * NOTE: Does not pre-stringify `moderatorCategoryIds` – callers should call
 * `JSON.stringify(user.moderatorCategoryIds)` before persistence if needed.
 */
const validUserArb = fc.record({
  empNo: empNoArb,
  name: userNameArb,
  nickname: fc.option(userNameArb, { nil: undefined }),
  email: fc.option(fc.emailAddress(), { nil: undefined }),
  department: fc.option(safeAsciiArb({ maxLength: 64 }), { nil: undefined }),
  bio: fc.option(mixedTextArb({ maxLength: 200 }), { nil: '' }),
  techTags: fc
    .array(techTagArb, { minLength: 0, maxLength: 8 })
    .map((arr) => Array.from(new Set(arr)).slice(0, 8).join(',')),
  role: fc.constantFrom('user', 'moderator', 'admin'),
  status: fc.constantFrom('active', 'disabled'),
  emailNotify: fc.boolean(),
});

// ---------- Category ----------

const categoryNameArb = mixedTextArb({ maxParts: 2, maxLength: 32 }).filter((s) => s.trim().length > 0);

const validCategoryArb = fc.record({
  name: categoryNameArb,
  description: fc.option(safeAsciiArb({ maxLength: 100 }), { nil: '' }),
  parentId: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: null }),
  sort: fc.integer({ min: 0, max: 999 }),
  enabled: fc.boolean(),
});

const categoryIdArb = fc.integer({ min: 1, max: 1_000_000 });

// ---------- Post ----------

const postTitleArb = mixedTextArb({ maxParts: 6, maxLength: 200 }).filter((s) => s.trim().length > 0);

/**
 * Plain-ish post body within Post.content limits (LONGTEXT, but realistic
 * payloads never approach the upper bound).
 */
const postBodyArb = fc
  .array(fc.oneof(cjkChunkArb, asciiWordArb), { minLength: 5, maxLength: 60 })
  .map((parts) => parts.join(' '))
  .filter((s) => s.length >= 10 && s.length <= 4000);

/** A safe whitelisted-tag rich-text snippet that survives sanitize-html. */
const richTextArb = fc
  .array(
    fc.oneof(
      mixedTextArb({ maxParts: 4, maxLength: 80 }).map((t) => `<p>${escapeForHtml(t)}</p>`),
      mixedTextArb({ maxParts: 2, maxLength: 40 }).map((t) => `<strong>${escapeForHtml(t)}</strong>`),
      mixedTextArb({ maxParts: 2, maxLength: 40 }).map((t) => `<em>${escapeForHtml(t)}</em>`),
      mixedTextArb({ maxParts: 6, maxLength: 100 }).map((t) => `<blockquote>${escapeForHtml(t)}</blockquote>`),
      mixedTextArb({ maxParts: 6, maxLength: 100 }).map((t) => `<code>${escapeForHtml(t)}</code>`)
    ),
    { minLength: 1, maxLength: 8 }
  )
  .map((parts) => parts.join(''));

function escapeForHtml(s) {
  return String(s).replace(/[<>&"']/g, (ch) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

/** Common XSS attack vectors – cleanRichText / cleanPlainText must strip these. */
const xssVectorArb = fc.constantFrom(
  '<script>alert(1)</script>',
  '<img src=x onerror="alert(1)">',
  '<a href="javascript:alert(1)">click</a>',
  '<svg/onload=alert(1)>',
  '<iframe src="https://evil.example.com"></iframe>',
  '<style>body{display:none}</style>',
  '"><script>fetch("/api/admin/users")</script>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<details open ontoggle=alert(1)>',
  '<input autofocus onfocus=alert(1)>',
  '<body onload=alert(1)>',
  '<object data="javascript:alert(1)"></object>',
  '<form action="javascript:alert(1)"><input type=submit></form>',
  '\u0000\u0001<script>alert(1)</script>',
  '<a href="vbscript:msgbox">x</a>'
);

/** Strings containing project-defined sensitive keywords. */
const sensitiveTextArb = fc
  .tuple(
    fc.constantFrom('色情', '暴力', '辱骂', '人身攻击', '广告推广', '加微信', '兼职刷单', '非法集资'),
    fc.option(mixedTextArb({ maxParts: 4, maxLength: 80 }), { nil: '' })
  )
  .map(([word, surrounding]) => `${surrounding} ${word} ${surrounding}`.trim());

const validPostArb = fc.record({
  title: postTitleArb,
  content: postBodyArb,
  summary: fc.option(safeAsciiArb({ maxLength: 200 }), { nil: '' }),
  status: fc.constantFrom('draft', 'published'),
  pinned: fc.constantFrom(0, 1, 2),
  featured: fc.boolean(),
});

// ---------- Comment ----------

const validCommentArb = fc.record({
  content: mixedTextArb({ maxParts: 6, maxLength: 200 }).filter((s) => s.trim().length > 0),
});

// ---------- Tag ----------

const validTagArb = techTagArb.map((s) => s.slice(0, 32)).filter((s) => s.length > 0);

// ---------- Pagination / Search / Sort ----------

const paginationArb = fc.record({
  page: fc.integer({ min: 1, max: 50 }),
  pageSize: fc.integer({ min: 1, max: 50 }),
});

const sortKeyArb = fc.constantFrom('latest', 'hot', 'comments', 'featured');

const searchKeywordArb = fc.oneof(
  fc.constant(''),
  mixedTextArb({ maxParts: 3, maxLength: 32 }),
  // SQL-injection style payloads for P32
  fc.constantFrom(
    "' OR 1=1 --",
    '"; DROP TABLE posts; --',
    '\\\\',
    '%',
    '_',
    '" OR ""="',
    '/*comment*/',
    "admin' --"
  )
);

// ---------- SSE frame sequences ----------

/**
 * Generates plausible SSE frame sequences emitted by /api/ai/ask/stream.
 * Per design.md Property 24:
 *   first frame: meta
 *   middle:     0..N delta frames
 *   last:       exactly one of done | error
 *   nothing after error/done.
 */
const sseFrameSeqArb = fc
  .tuple(
    // meta
    fc.record({
      candidates: fc.array(
        fc.record({ id: fc.integer({ min: 1, max: 100000 }), title: postTitleArb }),
        { minLength: 0, maxLength: 8 }
      ),
      quotaUsed: fc.integer({ min: 0, max: 100 }),
      quotaLimit: fc.integer({ min: 0, max: 100 }),
    }),
    // delta count
    fc.integer({ min: 0, max: 12 }),
    // delta payload tokens
    fc.array(safeAsciiArb({ maxLength: 8 }), { minLength: 0, maxLength: 12 }),
    // terminator
    fc.constantFrom('done', 'error')
  )
  .map(([meta, deltaCount, tokens, terminator]) => {
    const frames = [{ type: 'meta', payload: meta }];
    for (let i = 0; i < Math.min(deltaCount, tokens.length); i++) {
      frames.push({ type: 'delta', payload: { text: tokens[i] } });
    }
    if (terminator === 'done') {
      const full = tokens.slice(0, Math.min(deltaCount, tokens.length)).join('');
      frames.push({
        type: 'done',
        payload: {
          full,
          hasAnswer: full.trim().length > 0,
          citations: [],
          usage: {},
        },
      });
    } else {
      frames.push({
        type: 'error',
        payload: { message: 'mock upstream error' },
      });
    }
    return frames;
  });

/** Encoder helper: turns a frame array into the raw SSE wire format. */
function encodeSseFrames(frames) {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
}

module.exports = {
  // primitives
  safeAsciiArb,
  mixedTextArb,
  cjkChunkArb,
  asciiWordArb,
  // domain
  validUserArb,
  empNoArb,
  techTagArb,
  validCategoryArb,
  categoryIdArb,
  validPostArb,
  postTitleArb,
  postBodyArb,
  richTextArb,
  validCommentArb,
  validTagArb,
  // adversarial
  xssVectorArb,
  sensitiveTextArb,
  // search / paging
  paginationArb,
  sortKeyArb,
  searchKeywordArb,
  // sse
  sseFrameSeqArb,
  encodeSseFrames,
};
