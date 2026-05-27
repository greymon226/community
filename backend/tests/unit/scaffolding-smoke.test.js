'use strict';

// Smoke test for tests/property/_setup.js + _arbitraries.js
// Validates: Requirements 27.1 (test scaffolding loads cleanly)
//
// This test only verifies that the property-test scaffolding is wired
// correctly. It does NOT exercise any specific Property (P01..P36).

const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const setup = require('../property/_setup');
const arbs = require('../property/_arbitraries');

test('scaffolding: in-memory sqlite Sequelize boots and persists a User', async () => {
  await setup.resetDb();
  const { User } = setup.getModels();

  const u = await User.create({
    empNo: 'E10001',
    name: 'Alice',
    nickname: 'al',
    role: 'user',
    status: 'active',
    techTags: 'java,go',
    moderatorCategoryIds: '[]',
  });
  assert.equal(typeof u.id, 'number');

  const found = await User.findOne({ where: { empNo: 'E10001' } });
  assert.ok(found, 'User should be persisted');
  assert.equal(found.name, 'Alice');
});

test('scaffolding: resetDb() truncates between iterations', async () => {
  const { User } = setup.getModels();
  await setup.resetDb();
  await User.create({ empNo: 'E20001', name: 'B', moderatorCategoryIds: '[]' });
  let count = await User.count();
  assert.equal(count, 1);

  await setup.resetDb();
  count = await User.count();
  assert.equal(count, 0, 'resetDb should drop all rows');
});

test('scaffolding: AI mock server intercepts /v1/chat/completions', async () => {
  const { url } = await setup.installAiMock();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);

  setup.setAiHandler((_req, body) => ({
    status: 200,
    json: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              status: 'review',
              reason: 'mocked',
              echoModel: body && body.model,
            }),
          },
        },
      ],
    },
  }));

  const resp = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model', messages: [] }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  assert.equal(parsed.status, 'review');
  assert.equal(parsed.echoModel, 'mock-model');

  await setup.restoreAiMock();
});

test('scaffolding: useCacheBackend("memory") get/set/del round-trip', async () => {
  const cache = await setup.useCacheBackend('memory');
  await cache.del('k1');
  assert.equal(await cache.get('k1'), null);
  await cache.set('k1', { hello: 'world' }, 60);
  assert.deepEqual(await cache.get('k1'), { hello: 'world' });
  await cache.del('k1');
  assert.equal(await cache.get('k1'), null);
});

test('scaffolding: useCacheBackend("redis-mock") get/set/del round-trip', async () => {
  const cache = await setup.useCacheBackend('redis-mock');
  await cache.del('k2');
  assert.equal(await cache.get('k2'), null);
  await cache.set('k2', { n: 42 }, 60);
  assert.deepEqual(await cache.get('k2'), { n: 42 });
  await cache.del('k2');
  assert.equal(await cache.get('k2'), null);
  // Reset to memory so other tests don't share the shim.
  await setup.useCacheBackend('memory');
});

test('arbitraries: validUserArb produces persistable rows', async () => {
  await setup.resetDb();
  const { User } = setup.getModels();
  let runs = 0;
  await fc.assert(
    fc.asyncProperty(arbs.validUserArb, async (raw) => {
      runs++;
      // Use a unique empNo to avoid UNIQUE collisions across iterations.
      const empNo = `${raw.empNo}-${runs}`;
      const row = await User.create({
        ...raw,
        empNo,
        moderatorCategoryIds: '[]',
      });
      assert.equal(typeof row.id, 'number');
      assert.equal(row.empNo, empNo);
      assert.ok(['user', 'moderator', 'admin'].includes(row.role));
      assert.ok(['active', 'disabled'].includes(row.status));
      assert.ok(row.name && row.name.length <= 64);
    }),
    { numRuns: 25 }
  );
});

test('arbitraries: validPostArb has bounded shape', () => {
  fc.assert(
    fc.property(arbs.validPostArb, (p) => {
      assert.ok(typeof p.title === 'string' && p.title.length > 0 && p.title.length <= 200);
      assert.ok(typeof p.content === 'string' && p.content.length >= 10 && p.content.length <= 4000);
      assert.ok(['draft', 'published'].includes(p.status));
      assert.ok([0, 1, 2].includes(p.pinned));
      assert.equal(typeof p.featured, 'boolean');
    }),
    { numRuns: 50 }
  );
});

test('arbitraries: xssVectorArb / sensitiveTextArb / richTextArb / sseFrameSeqArb produce strings/arrays', () => {
  fc.assert(
    fc.property(arbs.xssVectorArb, (v) => {
      assert.equal(typeof v, 'string');
      assert.ok(v.length > 0);
    }),
    { numRuns: 30 }
  );
  fc.assert(
    fc.property(arbs.sensitiveTextArb, (v) => {
      assert.equal(typeof v, 'string');
      assert.ok(v.length > 0);
    }),
    { numRuns: 30 }
  );
  fc.assert(
    fc.property(arbs.richTextArb, (v) => {
      assert.equal(typeof v, 'string');
      assert.ok(v.startsWith('<'));
    }),
    { numRuns: 30 }
  );
  fc.assert(
    fc.property(arbs.sseFrameSeqArb, (frames) => {
      assert.ok(Array.isArray(frames) && frames.length >= 2);
      assert.equal(frames[0].type, 'meta');
      const last = frames[frames.length - 1];
      assert.ok(['done', 'error'].includes(last.type));
    }),
    { numRuns: 30 }
  );
});

test.after(async () => {
  await setup.closeDb();
});
