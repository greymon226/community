'use strict';

// Tests for src/services/searchService.js (tokenize / extractSnippet)
// Validates: Requirements 18.5, 18.6 (RAG 召回前置：中英文分词与片段提取)
//
// `tokenize` and `extractSnippet` are pure helpers used inside searchForRAG.
// They are exposed via `module.exports.__test = { tokenize, extractSnippet }`
// purely for unit testing — do NOT use them from production code.

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../../src/services/searchService');
const { tokenize, extractSnippet } = __test;

// ---------- tokenize: structural guarantees ----------

test('tokenize: empty / nullish input returns []', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('   '), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
});

test('tokenize: filters out short English/numeric tokens (<3 chars)', () => {
  const out = tokenize('a bc abc d ef ghij');
  assert.ok(!out.includes('a'));
  assert.ok(!out.includes('bc'));
  assert.ok(!out.includes('d'));
  assert.ok(!out.includes('ef'));
  assert.ok(out.includes('abc'));
  assert.ok(out.includes('ghij'));
});

test('tokenize: lowercases English tokens', () => {
  const out = tokenize('REACT Vue Angular');
  // 'vue' is < 3 chars after lowercasing? No, "vue" is 3 chars — kept by regex {3,}
  assert.ok(out.includes('react'));
  assert.ok(out.includes('vue'));
  assert.ok(out.includes('angular'));
});

test('tokenize: handles Chinese 2-4 char segments as whole words', () => {
  // Per implementation: a contiguous Chinese run of length 2-4 is added as-is.
  const out = tokenize('前端 性能优化');
  assert.ok(out.includes('前端'), 'expected "前端" token');
  assert.ok(out.includes('性能优化'), 'expected "性能优化" token');
});

test('tokenize: mixed Chinese + English yields both kinds of tokens', () => {
  const out = tokenize('前端 React 性能优化');
  assert.ok(out.includes('react'), 'English token "react" should be present');
  assert.ok(out.includes('前端'), 'Chinese 2-char token "前端" should be present');
  assert.ok(out.includes('性能优化'), 'Chinese 4-char token "性能优化" should be present');
});

test('tokenize: long Chinese run uses sliding 2-gram + full segment', () => {
  // 5+ char Chinese segment: implementation slides a 2-char window AND
  // adds the entire segment as a token.
  const out = tokenize('Vue3的响应式原理是什么');
  // sliding 2-grams should include some pairs from the segment "的响应式原理是什"
  assert.ok(out.some((t) => t.length === 2 && /[\u4e00-\u9fa5]{2}/.test(t)), 'expected at least one 2-gram');
});

test('tokenize: filters configured stop-words', () => {
  // The implementation defines STOP including: the/and/for/how/why/what/with/this/that
  // and Chinese: 怎么/如何/为什么/是不是
  const out = tokenize('how to use the react hooks for testing');
  assert.ok(!out.includes('the'));
  assert.ok(!out.includes('how'));
  assert.ok(!out.includes('for'));
  assert.ok(out.includes('react'));
  assert.ok(out.includes('hooks'));
  assert.ok(out.includes('testing'));
});

test('tokenize: filters Chinese stop-words', () => {
  const out = tokenize('如何 使用 React');
  assert.ok(!out.includes('如何'));
  assert.ok(out.includes('react'));
});

test('tokenize: result is deduplicated', () => {
  const out = tokenize('react react REACT React');
  const reactCount = out.filter((t) => t === 'react').length;
  assert.equal(reactCount, 1, 'duplicates should be removed');
});

test('tokenize: caps result at 8 tokens', () => {
  const out = tokenize('alpha beta gamma delta epsilon zeta etalong thetalong iotalong kappalong');
  assert.ok(out.length <= 8, `expected ≤8 tokens, got ${out.length}: ${out.join(',')}`);
});

test('tokenize: bounded output for pure-symbol input', () => {
  // The English-token regex includes `.`, `+`, `#`, `_`, `-` so a sequence of
  // 3+ dots can technically match. We only assert the output stays bounded
  // and never throws.
  const out = tokenize('!!!???,,,');
  assert.ok(Array.isArray(out));
  assert.ok(out.length <= 8);
});

// ---------- extractSnippet ----------

test('extractSnippet: returns full text when shorter than maxLen', () => {
  const text = 'short text here';
  assert.equal(extractSnippet(text, ['anything'], 100), text);
});

test('extractSnippet: returns "" for empty input', () => {
  assert.equal(extractSnippet('', ['x'], 100), '');
});

test('extractSnippet: when no token matches, returns the prefix slice', () => {
  const text = 'a'.repeat(200);
  const out = extractSnippet(text, ['nomatch'], 50);
  assert.equal(out.length, 50);
  assert.ok(!out.startsWith('…'));
});

test('extractSnippet: highlights window around the FIRST matching token', () => {
  // place the keyword in the middle so the window must shift around it
  const left = 'a'.repeat(80);
  const right = 'b'.repeat(80);
  const text = `${left}react${right}`;
  const out = extractSnippet(text, ['react'], 30);
  assert.ok(out.includes('react'), 'snippet should include the matched token');
  assert.ok(out.startsWith('…'), 'truncated head should prefix ellipsis');
  assert.ok(out.endsWith('…'), 'truncated tail should suffix ellipsis');
});

test('extractSnippet: case-insensitive token match', () => {
  const text = 'lorem ipsum REACT dolor sit amet '.repeat(20);
  const out = extractSnippet(text, ['react'], 60);
  // Should center around the REACT match (case-insensitive)
  assert.ok(/REACT/.test(out));
});

test('extractSnippet: chooses the FIRST listed token that matches', () => {
  const text = `${'x'.repeat(100)}vue${'y'.repeat(100)}react${'z'.repeat(100)}`;
  // 'react' appears later but is listed first; impl picks first matching token in the list
  const out = extractSnippet(text, ['react', 'vue'], 40);
  assert.ok(out.includes('react'));
});

test('extractSnippet: Chinese keyword is highlighted', () => {
  const head = '欢迎'.repeat(80);
  const tail = '社区'.repeat(80);
  const text = `${head}性能优化${tail}`;
  const out = extractSnippet(text, ['性能优化'], 30);
  assert.ok(out.includes('性能优化'));
});
