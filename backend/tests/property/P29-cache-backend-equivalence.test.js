'use strict';

// Property 29: 缓存后端的可替换性
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 25.1, 25.2
//
// 不变量：For ANY (key, value, ttlSec) sequence of `get / set / del / incr`
// operations, the externally observable trace produced by `Cache_Service`
// is identical regardless of backend choice (Redis vs in-memory):
//   - 在 TTL 内对同一 key 的 `get` 必返回 `set` 写入的值
//   - 同一 key 在 `del` 之后立即 `get` 返回 null
//   - `incr` 序列在 TTL 内保持单调递增（与 set/get 共享同一存储）
//   - 未写入或已过期的 key `get` 返回 null
//
// 实现策略：
//   1. 通过 `setup.useCacheBackend('memory')` 与 `setup.useCacheBackend('redis-mock')`
//      切换 cacheService 实际依赖的后端。
//   2. 生成一段随机的 op 序列。
//   3. 在两种后端各执行一次同一序列，记录每个可观测 op 的返回值（trace）。
//   4. `assert.deepStrictEqual` 比较两个 trace。
//
// 关于 `incr`：当前 `cacheService.js` 仅暴露 `get / set / del`。生产代码（控制器）
// 通过 `(await cache.get(key)) || 0; cache.set(key, used+1, ttl)` 模拟自增。
// 本测试以同样的语义实现 op-type='incr'，使两种后端在该模式下的行为可比较。
// 当且仅当生产代码的 `cache.set + +1` 序列在两种后端语义一致时，本属性才能通过。
//
// 关于 TTL：
//   - 主等价测试统一使用 ≥ 60 秒的 TTL，避免测试运行时长触发过期，使得
//     trace 完全由 op 顺序决定。
//   - 单独的 P29.B 子测试覆盖"TTL 过期后 get 返回 null"在两种后端下都成立。

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const setup = require('./_setup');
const { useCacheBackend, clearCache, closeDb } = setup;

// ---------- Op generators ----------

// A small fixed key pool (size 5) so that collisions are likely and most
// `get` calls land on a populated key. This is what makes the equivalence
// test meaningful; uniformly random keys would mostly miss.
const KEY_POOL = ['k1', 'k2', 'k3', 'k4', 'k5'];

const keyArb = fc.constantFrom(...KEY_POOL);

// Values: JSON-serializable primitives + small structures.
const valueArb = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }),
  fc.string({ maxLength: 20 }),
  fc.boolean(),
  fc.constant(null),
  fc.record({
    a: fc.integer({ min: 0, max: 99 }),
    b: fc.string({ maxLength: 10 }),
  })
);

// TTL in seconds. Always far longer than the test duration so that no key
// expires during a single property iteration.
const ttlArb = fc.integer({ min: 60, max: 3600 });

const opArb = fc.oneof(
  fc.record({
    type: fc.constant('set'),
    key: keyArb,
    value: valueArb,
    ttl: ttlArb,
  }),
  fc.record({ type: fc.constant('get'), key: keyArb }),
  fc.record({ type: fc.constant('del'), key: keyArb }),
  // `incr` simulated as: cur = (await get(key)) || 0; set(key, cur+1, ttl)
  fc.record({
    type: fc.constant('incr'),
    key: keyArb,
    ttl: ttlArb,
  })
);

// Length 1..30. Long enough to interleave many ops on each key.
const opSeqArb = fc.array(opArb, { minLength: 1, maxLength: 30 });

// ---------- Trace executor ----------

// Normalize a value through JSON so that prototype differences (e.g.
// `Object.create(null)` from fast-check vs plain `{}` from JSON.parse on
// the redis-mock side) collapse to a canonical representation. This matches
// the production callsite semantics — controllers always JSON-serialize
// cache values for cross-process consumption.
function jsonNormalize(v) {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

async function executeOps(cache, ops) {
  const trace = [];
  for (const op of ops) {
    switch (op.type) {
      case 'set': {
        await cache.set(op.key, op.value, op.ttl);
        // `set` is non-observable on its own; we DON'T push to trace.
        break;
      }
      case 'get': {
        const v = await cache.get(op.key);
        trace.push({ op: 'get', key: op.key, value: jsonNormalize(v) });
        break;
      }
      case 'del': {
        await cache.del(op.key);
        // No return value to observe in the current API. Push a marker so
        // that the *position* of the del in the trace is fixed; later `get`s
        // observe its effect.
        trace.push({ op: 'del', key: op.key });
        break;
      }
      case 'incr': {
        const cur = await cache.get(op.key);
        const base = typeof cur === 'number' ? cur : 0;
        const next = base + 1;
        await cache.set(op.key, next, op.ttl);
        trace.push({ op: 'incr', key: op.key, value: next });
        break;
      }
      default:
        throw new Error(`unknown op: ${JSON.stringify(op)}`);
    }
  }
  return trace;
}

// ---------- Lifecycle ----------

test.after(async () => {
  // Restore the default state and release the in-memory db.
  await closeDb();
});

// ============================================================================
// P29.A: Memory and redis-mock backends produce identical traces for any
// `get / set / del / incr` sequence.
// ============================================================================

test('P29.A: memory and redis-mock backends produce identical traces for arbitrary op sequences', async () => {
  await fc.assert(
    fc.asyncProperty(opSeqArb, async (ops) => {
      // --- run on memory backend ---
      const mem = await useCacheBackend('memory');
      await clearCache(); // clear any leftover state before this iteration
      // Note: clearCache re-initialises and may swap the module reference.
      const memCache = setup.getCache();
      const memTrace = await executeOps(memCache, ops);

      // --- run on redis-mock backend ---
      const redis = await useCacheBackend('redis-mock');
      await clearCache();
      const redisCache = setup.getCache();
      const redisTrace = await executeOps(redisCache, ops);

      // Equivalence: same trace.
      assert.deepStrictEqual(
        redisTrace,
        memTrace,
        `traces differ for ops=${JSON.stringify(ops)}\n` +
          `  memory   = ${JSON.stringify(memTrace)}\n` +
          `  redis-mk = ${JSON.stringify(redisTrace)}`
      );

      // Reference fast-check that helpers stayed defined.
      assert.equal(typeof mem.get, 'function');
      assert.equal(typeof redis.get, 'function');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P29.B: TTL expiration semantics — keys written with a tiny TTL must
// return null on subsequent get after the TTL has elapsed, on BOTH backends.
// ============================================================================

test('P29.B: TTL expiration → both backends return null for expired keys', async () => {
  // Use 1 second TTL + 1.2s wait so we are comfortably past expiry.
  const TTL_SEC = 1;
  const WAIT_MS = 1200;

  for (const backend of ['memory', 'redis-mock']) {
    await useCacheBackend(backend);
    await clearCache();
    const cache = setup.getCache();

    await cache.set('expiring-key', 'will-expire', TTL_SEC);
    const before = await cache.get('expiring-key');
    assert.equal(
      before,
      'will-expire',
      `[${backend}] key must be present immediately after set`
    );

    await new Promise((r) => setTimeout(r, WAIT_MS));

    const after = await cache.get('expiring-key');
    assert.equal(
      after,
      null,
      `[${backend}] key must be null after TTL has elapsed (got ${JSON.stringify(after)})`
    );
  }
});

// ============================================================================
// P29.C: del-then-get returns null on both backends, even after multiple sets.
// ============================================================================

test('P29.C: set → del → get returns null on both backends', async () => {
  await fc.assert(
    fc.asyncProperty(keyArb, valueArb, ttlArb, async (key, value, ttl) => {
      for (const backend of ['memory', 'redis-mock']) {
        await useCacheBackend(backend);
        await clearCache();
        const cache = setup.getCache();

        await cache.set(key, value, ttl);
        const v1 = await cache.get(key);
        assert.deepStrictEqual(
          jsonNormalize(v1),
          jsonNormalize(value),
          `[${backend}] get after set must return the value`
        );

        await cache.del(key);
        const v2 = await cache.get(key);
        assert.equal(
          v2,
          null,
          `[${backend}] get after del must return null (got ${JSON.stringify(v2)})`
        );
      }
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P29.D: incr-style monotonic sequences agree on both backends.
// ============================================================================

test('P29.D: simulated incr sequence is monotonic and agrees on both backends', async () => {
  await fc.assert(
    fc.asyncProperty(
      keyArb,
      fc.integer({ min: 1, max: 20 }),
      ttlArb,
      async (key, count, ttl) => {
        const traces = {};
        for (const backend of ['memory', 'redis-mock']) {
          await useCacheBackend(backend);
          await clearCache();
          const cache = setup.getCache();

          const trace = [];
          for (let i = 0; i < count; i++) {
            const cur = await cache.get(key);
            const base = typeof cur === 'number' ? cur : 0;
            const next = base + 1;
            await cache.set(key, next, ttl);
            trace.push(next);
          }
          traces[backend] = trace;

          // Monotonic within this backend.
          for (let i = 1; i < trace.length; i++) {
            assert.ok(
              trace[i] === trace[i - 1] + 1,
              `[${backend}] incr trace must be strictly +1 monotonic, got ${JSON.stringify(trace)}`
            );
          }
        }
        // Cross-backend equivalence.
        assert.deepStrictEqual(
          traces['redis-mock'],
          traces['memory'],
          `incr traces differ between backends:\n  memory=${JSON.stringify(traces['memory'])}\n  redis-mk=${JSON.stringify(traces['redis-mock'])}`
        );
      }
    ),
    { numRuns: 100 }
  );
});
