'use strict';

// Tests for src/services/aiService.js (safeParseJSON)
// Validates: Requirements 12.8 (LLM 返回 JSON 容错) — supports Property 30
//
// `safeParseJSON` is the internal helper that lets the AI service tolerate
// markdown-wrapped or prose-prefixed model outputs. It is exposed via
// `module.exports.__test = { safeParseJSON }` for unit testing only.

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../../src/services/aiService');
const { safeParseJSON } = __test;

test('safeParseJSON: parses valid JSON object', () => {
  assert.deepEqual(safeParseJSON('{"a":1}'), { a: 1 });
});

test('safeParseJSON: parses JSON with nested objects/arrays', () => {
  const obj = { nested: { x: [1, 2, 3] }, ok: true };
  assert.deepEqual(safeParseJSON(JSON.stringify(obj)), obj);
});

test('safeParseJSON: tolerates ```json fenced markdown wrapping', () => {
  const wrapped = '```json\n{"status":"pass","reason":""}\n```';
  assert.deepEqual(safeParseJSON(wrapped), { status: 'pass', reason: '' });
});

test('safeParseJSON: tolerates ``` fenced (no language hint) wrapping', () => {
  const wrapped = '```\n{"a":2}\n```';
  assert.deepEqual(safeParseJSON(wrapped), { a: 2 });
});

test('safeParseJSON: tolerates leading prose before JSON', () => {
  const out = safeParseJSON('Sure, here is the result: {"a":3}');
  assert.deepEqual(out, { a: 3 });
});

test('safeParseJSON: tolerates trailing prose after JSON', () => {
  const out = safeParseJSON('{"a":4} that is the answer');
  assert.deepEqual(out, { a: 4 });
});

test('safeParseJSON: tolerates Chinese prose around JSON', () => {
  const out = safeParseJSON('我返回 {"status":"pass","reason":""} 是有效的');
  assert.deepEqual(out, { status: 'pass', reason: '' });
});

test('safeParseJSON: returns null for empty / null / undefined', () => {
  assert.equal(safeParseJSON(''), null);
  assert.equal(safeParseJSON(null), null);
  assert.equal(safeParseJSON(undefined), null);
});

test('safeParseJSON: returns null for non-JSON prose', () => {
  assert.equal(safeParseJSON('not json at all'), null);
  assert.equal(safeParseJSON('text with no json braces'), null);
});

test('safeParseJSON: returns null for malformed JSON without recoverable braces', () => {
  // No closing brace and not a balanced { ... } block — fallback regex still
  // captures "{ broken json" greedily, JSON.parse fails → null.
  assert.equal(safeParseJSON('{ broken json'), null);
});

test('safeParseJSON: parses an audit-style schema returned by the model', () => {
  const raw = '```json\n{"status":"review","reason":"疑似广告","categories":["广告推广"]}\n```';
  const out = safeParseJSON(raw);
  assert.ok(out && typeof out === 'object');
  assert.equal(out.status, 'review');
  assert.equal(out.reason, '疑似广告');
  assert.deepEqual(out.categories, ['广告推广']);
});

test('safeParseJSON: parses an explainPost-style schema', () => {
  const raw = '{"summary":"hi","keyPoints":["a","b"],"suggestions":[],"questions":[]}';
  const out = safeParseJSON(raw);
  assert.ok(out);
  assert.equal(out.summary, 'hi');
  assert.deepEqual(out.keyPoints, ['a', 'b']);
});
