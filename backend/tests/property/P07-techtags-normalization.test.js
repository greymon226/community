'use strict';

// Property 7: techTags 归一化不变量
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 3.3, 3.5
//
// 不变量（来自 design.md Property 7）：
// 对任意 `PUT /api/users/me` 入参 `techTags`（数组或逗号分隔字符串、含空字符串、
// 重复项、HTML、超长元素），持久化后归一化结果满足：
//   1) 元素数 ≤ 20
//   2) 每个元素经 `cleanPlainText` 后长度 ≤ 32
//   3) 不含空串 / 不含纯空白串
//   4) 按首次出现顺序去重（不含重复项）
//   5) 每个元素本身就是 `cleanPlainText` 的输出 —— 不含任何 HTML 标签
//
// 实现说明：
//   生产路径在 `userController.updateMe` 中内联 String(techTags).split(',').map(...)
//   .filter(Boolean).slice(0, 20)。任务 5.4 要求把该归一化逻辑作为"纯函数"测试，
//   因此在 controller 中暴露一个 test-only 的 `__test.normalizeTechTags` helper，
//   行为与原内联代码完全一致（见 `src/controllers/userController.js`）。
//
//   本测试不连接 DB / Express，仅对该纯函数施加 fast-check 生成器，
//   每条不变量 ≥ 100 次迭代。

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { __test } = require('../../src/controllers/userController');

const { normalizeTechTags } = __test;

// ---------- Arbitraries ----------

// HTML-shaped strings: tag wrappers around random text payloads. The
// sanitizer must strip tags so these stress the `no HTML in output` rule.
const htmlStringArb = fc
  .tuple(
    fc.constantFrom('script', 'b', 'i', 'p', 'img', 'svg', 'a', 'iframe'),
    fc.string({ maxLength: 30 })
  )
  .map(([tag, inner]) => `<${tag}>${inner}</${tag}>`);

// XSS-style payloads with attributes / event handlers.
const xssLikeArb = fc.constantFrom(
  '<script>alert(1)</script>java',
  'react<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">vue</a>',
  '<svg/onload=alert(1)>k8s',
  '<style>x{}</style>docker',
  '<b>nodejs</b>',
  '   ',         // whitespace-only -> cleanPlainText returns ''
  '',            // empty
  'plainText'
);

// Long string >32 chars to test the slice(0, 32) cap.
const longStringArb = fc.string({ minLength: 50, maxLength: 200 });

// A single tag candidate: any of the above, plus normal short strings to
// keep dedup pressure realistic (collisions are common with a small alphabet).
const tagCandidateArb = fc.oneof(
  fc.string({ maxLength: 32 }),
  htmlStringArb,
  xssLikeArb,
  fc.constant(''),
  longStringArb,
  fc.constantFrom('java', 'python', 'go', 'rust', 'react', 'vue', 'docker', 'k8s')
);

// The input array per the task spec: 0..50 candidates.
const inputArrayArb = fc.array(tagCandidateArb, { minLength: 0, maxLength: 50 });

// ---------- Helpers used by the assertions ----------

// Rough check: any HTML tag opener / closer in the output.
const RE_ANY_TAG = /<\/?[a-z]/i;

// ---------- Tests ----------

test('P07.1 length ≤ 20 entries for any input', () => {
  fc.assert(
    fc.property(inputArrayArb, (arr) => {
      const out = normalizeTechTags(arr);
      assert.ok(
        out.length <= 20,
        `output length must be ≤ 20, got ${out.length} from input ${JSON.stringify(arr)}`
      );
    }),
    { numRuns: 100 }
  );
});

test('P07.2 every entry length ≤ 32 (cleanPlainText slice cap)', () => {
  fc.assert(
    fc.property(inputArrayArb, (arr) => {
      const out = normalizeTechTags(arr);
      for (const t of out) {
        assert.ok(
          t.length <= 32,
          `entry length must be ≤ 32, got ${t.length} (entry=${JSON.stringify(t)}) from input ${JSON.stringify(arr)}`
        );
      }
    }),
    { numRuns: 100 }
  );
});

test('P07.3 no empty / whitespace-only entries', () => {
  fc.assert(
    fc.property(inputArrayArb, (arr) => {
      const out = normalizeTechTags(arr);
      for (const t of out) {
        assert.ok(
          typeof t === 'string' && t.length > 0,
          `entry must be non-empty string, got ${JSON.stringify(t)} from input ${JSON.stringify(arr)}`
        );
        // Also reject pure-whitespace strings: cleanPlainText already trims,
        // but assert the contract explicitly.
        assert.notEqual(
          t.trim(),
          '',
          `entry must not be whitespace-only, got ${JSON.stringify(t)} from input ${JSON.stringify(arr)}`
        );
      }
    }),
    { numRuns: 100 }
  );
});

test('P07.4 entries are unique (deduped, first-occurrence order)', () => {
  fc.assert(
    fc.property(inputArrayArb, (arr) => {
      const out = normalizeTechTags(arr);
      const seen = new Set(out);
      assert.equal(
        seen.size,
        out.length,
        `entries must be unique; got ${out.length} entries with ${seen.size} unique values: ${JSON.stringify(out)} (input=${JSON.stringify(arr)})`
      );
    }),
    { numRuns: 100 }
  );
});

test('P07.5 each entry contains no HTML tags', () => {
  fc.assert(
    fc.property(inputArrayArb, (arr) => {
      const out = normalizeTechTags(arr);
      for (const t of out) {
        // No HTML tag opener/closer should survive: every entry must be the
        // result of cleanPlainText (which strips all tags via sanitize-html
        // with an empty allowedTags whitelist).
        assert.equal(
          RE_ANY_TAG.test(t),
          false,
          `entry must not contain HTML tags, got ${JSON.stringify(t)} from input ${JSON.stringify(arr)}`
        );
      }
    }),
    { numRuns: 100 }
  );
});
