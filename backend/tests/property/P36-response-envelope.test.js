'use strict';

// Property 36: 统一响应包络
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 27.4
//
// 不变量：后端任意响应（成功 / 失败）的响应体都必须形如
//   { code: number, message: string, data: any }
// 且顶层键集合恰为 {code, message, data}（不多不少）。
// 成功响应 code === 0；失败响应 code 为非零数字（按业务码 / HTTP 状态映射）。
//
// 本测试是纯函数测试：直接调用 src/utils/response.js 中的 `ok` / `fail`
// 与 src/middlewares/error.js 中的 `errorHandler` / `notFound`，
// 通过 mock `res` 拦截 `.status()` / `.json()` 调用以观察实际写入的响应体。
// 不启动 express、不连接数据库、不发起任何网络 / Redis 调用。
//
// 备注（gap）：当前 `response.js` 不会主动将 `message` 强制转成字符串；
// 若调用者传入非字符串 / 非数字 message，理论上会污染包络形状。
// 测试因此只生成"调用方实际可能传入"的输入空间（字符串 + 默认值），
// 这与设计文档对 message 的契约一致："message 是字符串"。

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { ok, fail } = require('../../src/utils/response');
const { errorHandler, notFound } = require('../../src/middlewares/error');

// ---------- mock res ----------

function makeRes() {
  const captured = { statusCode: 200, body: undefined, jsonCalls: 0 };
  const res = {
    status(code) {
      captured.statusCode = code;
      return this;
    },
    json(body) {
      captured.statusCode = captured.statusCode || 200;
      captured.body = body;
      captured.jsonCalls += 1;
      return this;
    },
    captured,
  };
  return res;
}

// ---------- envelope assertions ----------

function assertEnvelopeShape(body, label) {
  assert.equal(typeof body, 'object', `${label}: body must be an object`);
  assert.notEqual(body, null, `${label}: body must not be null`);
  assert.ok(!Array.isArray(body), `${label}: body must not be an array`);

  const keys = Object.keys(body).sort();
  assert.deepEqual(
    keys,
    ['code', 'data', 'message'],
    `${label}: top-level keys must be exactly {code, message, data}; got ${JSON.stringify(keys)}`
  );

  assert.equal(typeof body.code, 'number', `${label}: code must be number`);
  assert.equal(typeof body.message, 'string', `${label}: message must be string`);
  // data: any (no further constraint)
}

function assertSerializable(body, label) {
  // The envelope must round-trip through JSON.
  const json = JSON.stringify(body);
  assert.equal(typeof json, 'string', `${label}: must JSON.stringify`);
  const parsed = JSON.parse(json);
  assertEnvelopeShape(parsed, `${label} (after JSON round-trip)`);
}

// ---------- arbitraries ----------

// "Any" data the controllers might place in response.data:
//   primitives (incl. null), arrays, plain objects, nested objects.
// We exclude undefined because JSON.stringify drops undefined fields.
const dataArb = fc.letrec((tie) => ({
  any: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string({ maxLength: 64 }),
    fc.array(tie('any'), { maxLength: 6 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), tie('any'), { maxKeys: 6 })
  ),
})).any;

// Strings the caller may legitimately pass as `message`:
//   - normal Chinese / ASCII text
//   - very long strings
//   - unicode (incl. grapheme clusters, emoji)
const messageArb = fc.oneof(
  fc.string({ maxLength: 64 }),
  fc.string({ unit: 'grapheme', maxLength: 32 }),
  fc.string({ unit: 'binary', maxLength: 32 }),
  // very long
  fc.string({ minLength: 500, maxLength: 2000 }),
  // common business messages
  fc.constantFrom('ok', '操作成功', '工号或密码错误', '帖子不存在', 'AI 服务暂不可用')
);

// Business codes used across the platform (success + known failure codes from
// design.md "错误码与 HTTP 状态码的映射").
const businessCodeArb = fc.constantFrom(0, 1, 400, 401, 403, 404, 429, 500, 4001, 4002, 4003, 4004, 5001);

// HTTP status the caller might pass to `fail`:
const httpStatusArb = fc.constantFrom(400, 401, 403, 404, 413, 429, 500, 502);

// Synthesized error objects for errorHandler:
const errorArb = fc.oneof(
  // "Known business error" with explicit status + message.
  fc.record({
    status: fc.constantFrom(400, 401, 403, 404, 413, 429),
    message: messageArb,
  }).map(({ status, message }) => Object.assign(new Error(message), { status })),
  // 500 internal error (plain).
  messageArb.map((m) => new Error(m)),
  // Error with no message (defaults to '' in Node Error constructor).
  fc.constant(new Error()),
  // Error subclass with status only.
  fc.constant(Object.assign(new Error('内部错误'), { status: 500 })),
  // Error with non-numeric status (should still map cleanly).
  fc.record({
    status: fc.oneof(fc.constant(undefined), fc.constant(null)),
    message: messageArb,
  }).map(({ status, message }) => {
    const e = new Error(message);
    if (status !== undefined) e.status = status;
    return e;
  })
);

// ---------- silence error logs during this test file ----------

const realConsoleError = console.error;
test.before(() => {
  console.error = () => {};
});
test.after(() => {
  console.error = realConsoleError;
});

// ============================================================================
// P36.A: success envelope via `ok(res, data, message?)`
// ============================================================================

test('P36.A: ok(res, data, message?) emits {code:0, message, data} envelope', () => {
  fc.assert(
    fc.property(dataArb, fc.option(messageArb, { nil: undefined }), (data, message) => {
      const res = makeRes();
      ok(res, data, message);

      const body = res.captured.body;
      assertEnvelopeShape(body, 'ok');
      assertSerializable(body, 'ok');

      assert.equal(body.code, 0, 'success code must be 0');
      // When message is undefined, default 'ok' should kick in.
      if (message === undefined) {
        assert.equal(body.message, 'ok', 'default message must be "ok"');
      } else {
        assert.equal(body.message, message, 'message must round-trip');
      }
      // Data should be returned as-is (deep equal).
      assert.deepEqual(body.data, data, 'data must round-trip');

      // ok() does NOT call .status() — express defaults to 200.
      assert.equal(res.captured.jsonCalls, 1, 'json() called exactly once');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P36.B: failure envelope via `fail(res, message, code?, status?)`
// ============================================================================

test('P36.B: fail(res, message, code, status) emits {code, message, data:null} envelope', () => {
  fc.assert(
    fc.property(messageArb, businessCodeArb, httpStatusArb, (message, code, status) => {
      const res = makeRes();
      fail(res, message, code, status);

      const body = res.captured.body;
      assertEnvelopeShape(body, 'fail');
      assertSerializable(body, 'fail');

      assert.equal(body.code, code, 'fail code must echo input');
      assert.equal(body.message, message, 'fail message must echo input');
      assert.equal(body.data, null, 'fail data must be null');

      // status() must have been called with the http status.
      assert.equal(res.captured.statusCode, status, 'http status must be set');
      assert.equal(res.captured.jsonCalls, 1, 'json() called exactly once');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P36.C: defaults of `fail` still produce a well-formed envelope
// ============================================================================

test('P36.C: fail with default args produces envelope (code=1, status=400, message="error")', () => {
  const res = makeRes();
  fail(res);
  const body = res.captured.body;
  assertEnvelopeShape(body, 'fail-defaults');
  assert.equal(body.code, 1);
  assert.equal(body.message, 'error');
  assert.equal(body.data, null);
  assert.equal(res.captured.statusCode, 400);
});

// ============================================================================
// P36.D: errorHandler maps any thrown Error to the envelope
// ============================================================================

test('P36.D: errorHandler(err, req, res, next) emits envelope for any Error', () => {
  fc.assert(
    fc.property(errorArb, (err) => {
      const res = makeRes();
      const req = {};
      const next = () => {};
      errorHandler(err, req, res, next);

      const body = res.captured.body;
      assertEnvelopeShape(body, 'errorHandler');
      assertSerializable(body, 'errorHandler');

      // status: explicit err.status if numeric, else 500.
      const expectedStatus = typeof err.status === 'number' ? err.status : 500;
      assert.equal(res.captured.statusCode, expectedStatus, 'http status must match err.status or 500');

      // code mapping (per error.js): status===500 -> code:1, else code:status.
      const expectedCode = expectedStatus === 500 ? 1 : expectedStatus;
      assert.equal(body.code, expectedCode, 'code mapping must follow error.js');

      // message: err.message if present, else fallback '服务异常'.
      const expectedMessage = err.message || '服务异常';
      assert.equal(body.message, expectedMessage, 'message must echo err.message or fallback');

      assert.equal(body.data, null, 'errorHandler data must be null');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P36.E: errorHandler must NOT leak stack traces in the envelope
// ============================================================================

test('P36.E: errorHandler envelope never contains "stack" key', () => {
  fc.assert(
    fc.property(errorArb, (err) => {
      const res = makeRes();
      errorHandler(err, {}, res, () => {});
      const body = res.captured.body;
      assert.ok(!('stack' in body), 'envelope must not include err.stack');
      // Top-level keys are still exactly the envelope.
      assert.deepEqual(Object.keys(body).sort(), ['code', 'data', 'message']);
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P36.F: notFound emits the envelope with code===404
// ============================================================================

test('P36.F: notFound(req, res) emits {code:404, message:string, data:null} envelope', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (url) => {
      const res = makeRes();
      const req = { originalUrl: url };
      notFound(req, res);

      const body = res.captured.body;
      assertEnvelopeShape(body, 'notFound');
      assertSerializable(body, 'notFound');

      assert.equal(res.captured.statusCode, 404);
      assert.equal(body.code, 404);
      assert.equal(body.data, null);
      assert.ok(body.message.includes(url) || body.message.length > 0, 'message must reference the original url or be non-empty');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P36.G: huge / unicode / edge-case messages still preserve envelope shape
// ============================================================================

test('P36.G: extreme messages (huge / unicode / emoji) preserve envelope shape', () => {
  const extremeArb = fc.oneof(
    fc.string({ minLength: 4000, maxLength: 8000 }),
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 100 }),
    fc.constantFrom(
      '🚀💥🔥'.repeat(10),
      '中文'.repeat(500),
      '\n\t\r ',
      '"quotes" and \\backslash and \u0000 NUL'
    )
  );
  fc.assert(
    fc.property(extremeArb, (msg) => {
      const res1 = makeRes();
      ok(res1, { hello: 'world' }, msg);
      assertEnvelopeShape(res1.captured.body, 'ok-extreme');
      assertSerializable(res1.captured.body, 'ok-extreme');
      assert.equal(res1.captured.body.code, 0);
      assert.equal(res1.captured.body.message, msg);

      const res2 = makeRes();
      fail(res2, msg, 4001, 400);
      assertEnvelopeShape(res2.captured.body, 'fail-extreme');
      assertSerializable(res2.captured.body, 'fail-extreme');
      assert.equal(res2.captured.body.code, 4001);
      assert.equal(res2.captured.body.data, null);
      assert.equal(res2.captured.body.message, msg);
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P36.H: code field is always number (NaN counts as number per JS)
// ============================================================================

test('P36.H: code is always typeof "number" (incl. NaN, Infinity)', () => {
  const numberishArb = fc.oneof(
    fc.integer(),
    fc.double(),
    fc.constantFrom(0, 1, 400, 401, 403, 404, 429, 500, 4001, 4002, 4003, 4004, 5001)
  );
  fc.assert(
    fc.property(numberishArb, (code) => {
      const res = makeRes();
      fail(res, 'x', code, 400);
      assert.equal(typeof res.captured.body.code, 'number');
    }),
    { numRuns: 100 }
  );
});
