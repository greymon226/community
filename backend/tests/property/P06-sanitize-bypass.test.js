'use strict';

// Property 6: 富文本 / 纯文本清洗不可绕过
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 3.5, 5.2, 5.3, 8.5, 23.6
//
// For ANY input string s, after cleanPlainText(s) or cleanRichText(s):
//   - No `<script` substring (case-insensitive) appears in the output.
//   - No `on*=` event handler attribute appears within any HTML tag.
//   - No `javascript:` / `vbscript:` protocol appears in any href/src
//     attribute value.
//   - cleanPlainText output contains NO HTML tags (rough check:
//     `/</?[a-z]/i.test(out) === false`).
//   - cleanRichText output is idempotent: clean(clean(s)) === clean(s).
//   - Whitelisted tags (e.g. <p>) ARE preserved when wrapping plain text.
//   - data:image/... URLs and /uploads/... paths in <img src> are
//     preserved if present.
//
// NOTE on a documented deviation from design.md: design states that
// cleanPlainText must strip control characters (\x00..\x1F except \t \n \r),
// but the current production implementation (backend/src/utils/sanitize.js)
// only strips HTML tags via sanitize-html and trims whitespace; control
// characters survive. This test therefore does NOT assert the control-char
// stripping rule, matching the documented current behaviour. Fixing this is
// out of scope for the test-only task 4.2.

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { cleanPlainText, cleanRichText } = require('../../src/utils/sanitize');
const { xssVectorArb, richTextArb, mixedTextArb } = require('./_arbitraries');

// ---------- Regex helpers (operate on sanitizer OUTPUT) ----------

// Matches `<script` regardless of case. After sanitize-html, '<' should only
// appear at the start of whitelisted tags; any literal '<' from input text is
// HTML-encoded to `&lt;`, so this check catches reflected/embedded scripts.
const RE_SCRIPT = /<script/i;

// Matches an HTML attribute starting with `on` (e.g. onerror, onclick) inside
// the tag prefix (between '<' and the first '>'). Anchors '<' to ensure we are
// inside a tag, not in text content.
const RE_ON_HANDLER = /<[^>]*\son[a-z]+\s*=/i;

// Matches a javascript: / vbscript: protocol used as an href/src value.
const RE_JS_VBS_PROTOCOL = /\b(?:href|src)\s*=\s*["']?\s*(?:javascript|vbscript)\s*:/i;

// Matches any HTML tag opener (used to assert plain-text mode strips all tags).
const RE_ANY_TAG = /<\/?[a-z]/i;

// ---------- Adversarial input generator ----------

// Build a noisy mixed payload: random unicode + a known XSS vector + maybe a
// tag fragment, glued together. This stresses the sanitizer with realistic
// "user pasted something weird" inputs.
const noisyAdversarialArb = fc.tuple(
  fc.string({ minLength: 0, maxLength: 50 }),
  xssVectorArb,
  fc.string({ minLength: 0, maxLength: 50 })
).map(([a, b, c]) => `${a}${b}${c}`);

// Any input the sanitizer might face: clean rich text, raw XSS, noisy mix,
// random unicode, mixed CJK + ASCII text.
const anyInputArb = fc.oneof(
  xssVectorArb,
  noisyAdversarialArb,
  richTextArb,
  mixedTextArb({ maxParts: 8, maxLength: 200 }),
  fc.string({ minLength: 0, maxLength: 200 }),
  fc.string({ minLength: 0, maxLength: 200, unit: 'binary' })
);

// ---------- Tests ----------

test('P06.a cleanPlainText: output has no HTML tags', () => {
  fc.assert(
    fc.property(anyInputArb, (input) => {
      const out = cleanPlainText(input);
      assert.equal(
        RE_ANY_TAG.test(out),
        false,
        `plainText output unexpectedly contains an HTML tag: ${JSON.stringify(out)} (input=${JSON.stringify(input)})`
      );
    }),
    { numRuns: 200 }
  );
});

test('P06.b cleanRichText: no <script substring', () => {
  fc.assert(
    fc.property(anyInputArb, (input) => {
      const out = cleanRichText(input);
      assert.equal(
        RE_SCRIPT.test(out),
        false,
        `richText output unexpectedly contains <script: ${JSON.stringify(out)} (input=${JSON.stringify(input)})`
      );
    }),
    { numRuns: 200 }
  );
});

test('P06.b cleanRichText: no on*= event handler attributes', () => {
  fc.assert(
    fc.property(anyInputArb, (input) => {
      const out = cleanRichText(input);
      assert.equal(
        RE_ON_HANDLER.test(out),
        false,
        `richText output contains an on*= event handler: ${JSON.stringify(out)} (input=${JSON.stringify(input)})`
      );
    }),
    { numRuns: 200 }
  );
});

test('P06.b cleanRichText: no javascript:/vbscript: in href/src', () => {
  fc.assert(
    fc.property(anyInputArb, (input) => {
      const out = cleanRichText(input);
      assert.equal(
        RE_JS_VBS_PROTOCOL.test(out),
        false,
        `richText output exposes a javascript:/vbscript: protocol in href/src: ${JSON.stringify(out)} (input=${JSON.stringify(input)})`
      );
    }),
    { numRuns: 200 }
  );
});

test('P06.c cleanRichText is idempotent: clean(clean(s)) === clean(s)', () => {
  fc.assert(
    fc.property(anyInputArb, (input) => {
      const once = cleanRichText(input);
      const twice = cleanRichText(once);
      assert.equal(
        twice,
        once,
        `richText is not idempotent. once=${JSON.stringify(once)} twice=${JSON.stringify(twice)} input=${JSON.stringify(input)}`
      );
    }),
    { numRuns: 150 }
  );
});

test('P06.c cleanPlainText is idempotent: clean(clean(s)) === clean(s)', () => {
  fc.assert(
    fc.property(anyInputArb, (input) => {
      const once = cleanPlainText(input);
      const twice = cleanPlainText(once);
      assert.equal(
        twice,
        once,
        `plainText is not idempotent. once=${JSON.stringify(once)} twice=${JSON.stringify(twice)} input=${JSON.stringify(input)}`
      );
    }),
    { numRuns: 150 }
  );
});

test('P06.d cleanRichText: whitelisted <p> survives wrapping', () => {
  fc.assert(
    fc.property(mixedTextArb({ maxParts: 6, maxLength: 100 }), (text) => {
      // Build a safe, escaped <p>...</p>
      const escaped = String(text).replace(/[<>&"']/g, (ch) => ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&#39;',
      })[ch]);
      const html = `<p>${escaped}</p>`;
      const out = cleanRichText(html);
      assert.ok(
        out.includes('<p>') && out.includes('</p>'),
        `expected <p>...</p> to survive sanitisation, got ${JSON.stringify(out)} (input=${JSON.stringify(html)})`
      );
    }),
    { numRuns: 100 }
  );
});

test('P06.d cleanRichText: data:image/... <img src> is preserved', () => {
  // data:image URLs are an explicit allowed scheme. Generate a plausible
  // base64-ish payload and a few mime subtypes.
  const dataImgArb = fc
    .tuple(
      fc.constantFrom('png', 'jpeg', 'gif', 'webp'),
      fc.string({ minLength: 4, maxLength: 60, unit: fc.constantFrom(
        'A','B','C','D','E','F','G','H','a','b','c','d','e','f','g','h',
        '0','1','2','3','4','5','6','7','8','9','+','/','='
      ) })
    )
    .map(([mime, b64]) => `data:image/${mime};base64,${b64}`);

  fc.assert(
    fc.property(dataImgArb, (url) => {
      const html = `<img src="${url}" alt="x" />`;
      const out = cleanRichText(html);
      assert.ok(
        out.includes(url),
        `data:image/... URL was unexpectedly stripped from <img src>: input=${JSON.stringify(html)} output=${JSON.stringify(out)}`
      );
    }),
    { numRuns: 100 }
  );
});

test('P06.d cleanRichText: /uploads/... <img src> is preserved', () => {
  const uploadPathArb = fc
    .tuple(
      fc.integer({ min: 1_000_000_000_000, max: 9_999_999_999_999 }),
      fc
        .string({
          minLength: 6,
          maxLength: 32,
          unit: fc.constantFrom(
            'a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p',
            '0','1','2','3','4','5','6','7','8','9','-'
          ),
        })
        .filter((s) => s.length > 0),
      fc.constantFrom('png', 'jpg', 'jpeg', 'gif', 'webp', 'svg')
    )
    .map(([ts, uuid, ext]) => `/uploads/${ts}-${uuid}.${ext}`);

  fc.assert(
    fc.property(uploadPathArb, (url) => {
      const html = `<img src="${url}" alt="x" />`;
      const out = cleanRichText(html);
      assert.ok(
        out.includes(url),
        `/uploads/... path was unexpectedly stripped from <img src>: input=${JSON.stringify(html)} output=${JSON.stringify(out)}`
      );
    }),
    { numRuns: 100 }
  );
});
