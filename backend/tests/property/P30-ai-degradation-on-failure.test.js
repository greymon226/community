'use strict';

// Property 30: AI 失败的稳定降级
// Validates: Requirements 12.9, 12.10, 25.3, 25.4, 19.7
//
// 不变量：对任意 AI 上游失败模式（非 2xx 状态、非 JSON body、缺 status 字段、
// 超时），`aiService.auditContent({title, content})` 必须：
//   1) 不抛异常（绝不进入 unhandled rejection / uncaught exception 路径）；
//   2) 返回一个形如 { status, reason } 的对象；
//   3) status ∈ { 'pass', 'review', 'blocked' }；
//   4) reason 是字符串（不泄漏堆栈、密钥、上游 URL）。
//
// 实现策略：
//   - installAiMock 启动一个本地 mock HTTP server，并把 config.ai.* 切换到
//     mock baseUrl + 假 apiKey，让 auditContent 走 LLM 调用路径（再降级
//     到本地 RISK_KEYWORDS）。
//   - 通过 setAiHandler 在每次迭代切换上游响应：
//       * { status: 500 } 不带 body
//       * 200 + 非 JSON body
//       * 200 + JSON body 缺 status 字段
//       * 永不结束的 Promise（让客户端 AbortController 触发超时）
//     另外加入一个无效随机 status 字符串，验证模型“非合法 status”兜底。
//   - 设置 process.env.AI_TIMEOUT_MS = '500'（在 test.before 早期设置），
//     然后在 setAiHandler 注入超时变体之前临时把 config.ai.timeoutMs 调小，
//     让超时迭代总耗时受控（每条 ≤ 1s）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

// IMPORTANT: must be set before _setup loads config.
process.env.AI_TIMEOUT_MS = '500';

const setup = require('./_setup');
const { closeDb, config, installAiMock, setAiHandler, restoreAiMock } = setup;

const aiService = require('../../src/services/aiService');

// ---------- harness ----------

test.before(async () => {
  // Force the LLM path: deepseek provider + apiKey set. installAiMock will
  // override baseUrl to point at the in-process server.
  await installAiMock();
  // Cap the per-iteration timeout so timeout-injection iterations complete fast.
  config.ai.timeoutMs = 500;
});

test.after(async () => {
  await restoreAiMock();
  await closeDb();
});

// ---------- failure handler factories ----------

function handler500() {
  return () => ({ status: 500, body: '' });
}

function handlerNonJsonBody() {
  // 200 + Content-Type: application/json header but non-JSON body. The mock
  // server's `body` branch returns text/plain by default; that's fine because
  // aiService treats a !ok or non-JSON content as failure → fallback.
  return () => ({
    status: 200,
    body: 'this is not json {{{',
    headers: { 'Content-Type': 'application/json' },
  });
}

function handlerJsonMissingStatus() {
  // 200 + JSON body that lacks a `status` field. aiService.safeParseJSON
  // will succeed but downstream `parsed.status` is undefined; auditWithLLM
  // currently coerces an unknown status to 'review'. To validate the
  // "stable degrade" property in a stricter way (any failure path must yield
  // a well-formed object), we still expect a valid envelope.
  return () => ({
    status: 200,
    json: {
      id: 'mock',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            // raw model content is JSON but lacks a status key.
            content: JSON.stringify({ reason: 'no status here', categories: [] }),
          },
          finish_reason: 'stop',
        },
      ],
    },
  });
}

function handlerInvalidJsonContent() {
  // 200 + chat completion shape, but the assistant's `content` is NOT JSON.
  // safeParseJSON will return null → auditWithLLM throws → fallback path.
  return () => ({
    status: 200,
    json: {
      id: 'mock',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'plain text without any json braces' },
          finish_reason: 'stop',
        },
      ],
    },
  });
}

function handlerInvalidStatusValue() {
  // Like a normal completion but `status` is a garbage string.
  return () => ({
    status: 200,
    json: {
      id: 'mock',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({ status: 'garbage-value', reason: 'x', categories: [] }),
          },
          finish_reason: 'stop',
        },
      ],
    },
  });
}

function handlerTimeout() {
  // Returns a never-resolving promise; client AbortController fires after
  // AI_TIMEOUT_MS and aiService catches the AbortError → fallback.
  return () => new Promise(() => {});
}

const FAILURE_HANDLERS = [
  { name: '500-empty', factory: handler500 },
  { name: 'non-json-body', factory: handlerNonJsonBody },
  { name: 'json-missing-status', factory: handlerJsonMissingStatus },
  { name: 'invalid-json-content', factory: handlerInvalidJsonContent },
  { name: 'invalid-status-value', factory: handlerInvalidStatusValue },
  { name: 'timeout', factory: handlerTimeout },
];

// ---------- arbitraries ----------

const titleArb = fc
  .stringMatching(/^[A-Za-z0-9 ]{6,40}$/)
  .map((s) => s.trim())
  .filter((s) => s.length >= 6);

const contentArb = fc
  .stringMatching(/^[A-Za-z0-9 .,]{10,200}$/)
  .map((s) => s.trim())
  .filter((s) => s.length >= 10);

const failureHandlerArb = fc
  .integer({ min: 0, max: FAILURE_HANDLERS.length - 1 })
  .map((idx) => FAILURE_HANDLERS[idx]);

const iterationArb = fc.record({
  title: titleArb,
  content: contentArb,
  failure: failureHandlerArb,
});

const VALID_STATUSES = new Set(['pass', 'review', 'blocked']);

// ---------- the property ----------

test('P30: auditContent degrades to a well-formed envelope under any AI failure', async () => {
  await fc.assert(
    fc.asyncProperty(iterationArb, async ({ title, content, failure }) => {
      setAiHandler(failure.factory());

      let result;
      let threw = null;
      try {
        result = await aiService.auditContent({ title, content });
      } catch (e) {
        threw = e;
      }

      assert.equal(
        threw,
        null,
        `auditContent must NOT throw under failure mode '${failure.name}': ${threw && threw.message}`
      );
      assert.notEqual(result, undefined, `result must not be undefined under '${failure.name}'`);
      assert.notEqual(result, null, `result must not be null under '${failure.name}'`);
      assert.equal(typeof result, 'object', `result must be an object under '${failure.name}'`);

      assert.ok(
        VALID_STATUSES.has(result.status),
        `result.status must be one of {pass, review, blocked} under '${failure.name}', got ${JSON.stringify(result.status)}`
      );
      assert.equal(
        typeof result.reason,
        'string',
        `result.reason must be a string under '${failure.name}', got ${typeof result.reason}`
      );

      // The "no leakage" half of R12.10 / R25.4: the reason field must not
      // surface upstream URLs or fake API keys. We don't enforce a strict
      // string match (the local-fallback path returns Chinese text), only
      // that the leak markers are absent.
      const reasonLower = result.reason.toLowerCase();
      assert.ok(
        !reasonLower.includes('test-mock-key'),
        `reason must not leak the api key under '${failure.name}': ${result.reason}`
      );
      assert.ok(
        !reasonLower.includes('127.0.0.1'),
        `reason must not leak the upstream URL under '${failure.name}': ${result.reason}`
      );
    }),
    { numRuns: 100 }
  );
});
