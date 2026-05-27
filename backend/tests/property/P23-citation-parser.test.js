'use strict';

// Property 23: 引用编号解析的纯函数性
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 18.9, 19.6
//
// 不变量（来自 design.md）：
//   给定 (answerText, candidates) →
//     - 抽取 `[n]` 模式（其中 1 ≤ n ≤ candidates.length 视为合法上下文编号）
//     - 同时兼容"真实帖子 id"语义：若 n 恰好等于某个 candidate.id，亦采纳
//     - 按首次出现顺序去重
//     - 映射到 candidates[n-1].id（或 真实 id）
//     - 越界 / 非法编号被忽略
//     - 纯函数：相同输入 → 相同输出，不修改入参
//
// 本测试为纯函数测试：不连接 DB、不调 LLM、不启动 server。
// 直接调用 src/services/aiService.js 暴露的 __test.parseCitations。

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { __test } = require('../../src/services/aiService');
const { parseCitations } = __test;

// ---------- helpers ----------

/** Disjoint candidate id pool: ensures candidate.id values are distinct. */
const candidateArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 999 }), { minLength: 0, maxLength: 10 })
  .chain((ids) =>
    fc
      .array(fc.string({ minLength: 1, maxLength: 30 }), {
        minLength: ids.length,
        maxLength: ids.length,
      })
      .map((titles) => ids.map((id, i) => ({ id, title: titles[i] || `t${id}` })))
  );

/** Generate a marker token: a valid 1..N ordinal, an out-of-range ordinal, a real id, or junk text. */
function makeMarkerArb(candidates) {
  const N = candidates.length;
  const realIds = candidates.map((c) => c.id);
  const choices = [];
  // Out-of-range high
  choices.push(fc.integer({ min: Math.max(N + 1, 1), max: 99 }).map((n) => `[${n}]`));
  // Bracket noise that should NOT match the regex (no digits inside)
  choices.push(fc.constantFrom('[abc]', '[]', '[ ]', '[1.5]', '[1,2]', '[ 1 ]'));
  // Plain text noise
  choices.push(fc.string({ minLength: 0, maxLength: 8 }).map((s) => s.replace(/[\[\]]/g, '')));
  if (N > 0) {
    choices.push(fc.integer({ min: 1, max: N }).map((n) => `[${n}]`));
    choices.push(fc.constantFrom(...realIds).map((id) => `[${id}]`));
  }
  return fc.oneof(...choices);
}

/** Build an answer text by interleaving safe filler with marker tokens. */
function makeAnswerArb(candidates) {
  return fc
    .array(makeMarkerArb(candidates), { minLength: 0, maxLength: 12 })
    .chain((tokens) =>
      fc
        .array(fc.string({ minLength: 0, maxLength: 12 }).map((s) => s.replace(/[\[\]]/g, ' ')), {
          minLength: tokens.length + 1,
          maxLength: tokens.length + 1,
        })
        .map((fillers) => {
          let out = '';
          for (let i = 0; i < tokens.length; i++) out += `${fillers[i]} ${tokens[i]} `;
          out += fillers[fillers.length - 1] || '';
          return out;
        })
    );
}

/** Naïve, independent reference implementation derived from the spec text. */
function expectedCitations(answerText, candidates) {
  if (typeof answerText !== 'string' || !Array.isArray(candidates)) return [];
  const ids = candidates.map((c) => Number(c && c.id)).filter((n) => Number.isFinite(n));
  const idSet = new Set(ids);
  const seen = new Set();
  const result = [];
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(answerText)) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    let id = null;
    if (idSet.has(n)) {
      id = n;
    } else if (n >= 1 && n <= candidates.length) {
      const cid = Number(candidates[n - 1] && candidates[n - 1].id);
      if (Number.isFinite(cid)) id = cid;
    }
    if (id === null) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

// ============================================================================
// P23.a: Determinism / Pure
//   parseCitations(text, candidates) === parseCitations(text, candidates)
// ============================================================================

test('P23.a parseCitations is deterministic and does not mutate inputs', () => {
  fc.assert(
    fc.property(candidateArb, fc.string({ maxLength: 200 }), (cs, prefix) => {
      // Use prefix string to add free-form text into the answer
      // (markers may or may not be embedded — both branches must be deterministic).
      const candidatesSnap = JSON.parse(JSON.stringify(cs));
      const text = `${prefix} [1] [2] [99] middle [${cs[0] ? cs[0].id : 'x'}] end`;
      const textSnap = String(text);

      const a = parseCitations(text, cs);
      const b = parseCitations(text, cs);
      assert.deepEqual(a, b, 'two calls must return deep-equal results');

      // Inputs must be untouched.
      assert.equal(text, textSnap, 'answerText must not be mutated');
      assert.deepEqual(cs, candidatesSnap, 'candidates must not be mutated');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P23.b: Bounded
//   every output id ∈ candidates.map(c => c.id)
// ============================================================================

test('P23.b every output id is one of candidates.id', () => {
  fc.assert(
    fc.property(candidateArb.chain((cs) => fc.tuple(fc.constant(cs), makeAnswerArb(cs))), ([cs, text]) => {
      const out = parseCitations(text, cs);
      const ids = new Set(cs.map((c) => c.id));
      for (const id of out) {
        assert.ok(ids.has(id), `output id ${id} not in candidate id set ${[...ids].join(',')}`);
      }
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P23.c: Order matches first-occurrence order in answer text
// ============================================================================

test('P23.c output order matches first-occurrence order in text', () => {
  fc.assert(
    fc.property(candidateArb.chain((cs) => fc.tuple(fc.constant(cs), makeAnswerArb(cs))), ([cs, text]) => {
      const out = parseCitations(text, cs);
      // Expected order: walk through the regex matches, mapping each marker
      // to its target id (real-id semantics or 1-based ordinal), keep first
      // occurrence only. Then assert equality with parseCitations output.
      const expected = expectedCitations(text, cs);
      assert.deepEqual(out, expected, `order mismatch: parseCitations=${JSON.stringify(out)} expected=${JSON.stringify(expected)}`);
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P23.d: Dedup — no duplicates in output
// ============================================================================

test('P23.d output contains no duplicate ids', () => {
  fc.assert(
    fc.property(candidateArb.chain((cs) => fc.tuple(fc.constant(cs), makeAnswerArb(cs))), ([cs, text]) => {
      const out = parseCitations(text, cs);
      const set = new Set(out);
      assert.equal(set.size, out.length, `duplicates found in output: ${JSON.stringify(out)}`);
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P23.e: Out-of-range filtering
//   For candidates of length N, a marker [n] with n > N AND n ∉ candidate ids
//   contributes NO id to the output.
// ============================================================================

test('P23.e out-of-range ordinals (and not real ids) are filtered out', () => {
  fc.assert(
    fc.property(
      // Bound the candidate id pool tightly so we can reliably craft an
      // out-of-range n that is also NOT one of the real ids.
      fc
        .uniqueArray(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 5 })
        .map((ids) => ids.map((id, i) => ({ id, title: `t${id}` }))),
      fc.integer({ min: 100, max: 99999 }), // far above N (≤5) and outside id pool
      (cs, n) => {
        // Sanity: n is neither in ids nor a valid 1..N ordinal.
        const ids = new Set(cs.map((c) => c.id));
        if (ids.has(n)) return; // skip rare collision
        if (n >= 1 && n <= cs.length) return;
        const text = `before [${n}] after`;
        const out = parseCitations(text, cs);
        assert.deepEqual(out, [], `out-of-range marker [${n}] should be ignored, got ${JSON.stringify(out)}`);
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// P23.f: Semantic alternative — when [realId] appears, that id is captured
// ============================================================================

test('P23.f real-id semantics: [candidate.id] is captured even when id > N', () => {
  fc.assert(
    fc.property(
      // Force candidate ids to be > 100 so they cannot collide with the
      // 1..N ordinal interpretation (since N ≤ 6).
      fc
        .uniqueArray(fc.integer({ min: 100, max: 9999 }), { minLength: 1, maxLength: 6 })
        .map((ids) => ids.map((id) => ({ id, title: `t${id}` }))),
      (cs) => {
        const target = cs[cs.length - 1].id; // pick a real id
        const text = `prefix [${target}] suffix`;
        const out = parseCitations(text, cs);
        assert.deepEqual(out, [target], `real-id [${target}] was not captured: got ${JSON.stringify(out)}`);
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// P23.extra: empty candidates ⇒ output is always []
// ============================================================================

test('P23.extra empty candidates produces empty output regardless of text', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (text) => {
      const out = parseCitations(text, []);
      assert.deepEqual(out, []);
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P23.extra: malformed inputs degrade gracefully
// ============================================================================

test('P23.extra non-string answerText / non-array candidates ⇒ []', () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.constant(null), fc.constant(undefined), fc.integer(), fc.boolean(), fc.object()),
      fc.oneof(fc.constant(null), fc.constant(undefined), fc.integer(), fc.string()),
      (badText, badCands) => {
        // Both arms invalid → []
        assert.deepEqual(parseCitations(badText, badCands), []);
        // Valid text + invalid candidates → []
        assert.deepEqual(parseCitations('[1] [2]', badCands), []);
        // Invalid text + valid candidates → []
        assert.deepEqual(parseCitations(badText, [{ id: 1 }, { id: 2 }]), []);
      }
    ),
    { numRuns: 100 }
  );
});
