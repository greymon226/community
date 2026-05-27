'use strict';

// Property 27: 系统设置写入的事务性
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 21.3, 21.4, 21.8
//
// 不变量：For any PUT /api/admin/settings request:
//   (a) Unknown `key` (not in DEFAULTS whitelist) → 400 + 中文 "未知的系统设置项"
//       AND no SystemSetting row created
//       AND no AuditLog action='setting.update' written
//       AND in-memory settings cache preserved
//   (b) Valid `key` + value → 200 + body.data echoes {key, value}
//       AND SystemSetting row contains JSON.stringify(value)
//       AND exactly one AuditLog action='setting.update' added
//       AND settings cache flushed: subsequent GET /api/admin/settings
//           returns the freshly-written value
//   (c) On a simulated DB error during write (findOrCreate throws) →
//       4xx response, no SystemSetting row, no AuditLog,
//       AND cache value identical to pre-call state.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fc = require('fast-check');
const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');

const setup = require('./_setup');
const { resetDb, getModels, closeDb, config } = setup;

const apiRouter = require('../../src/routes');
const settings = require('../../src/services/settingService');

// ---------- harness ----------

let server;
let port;
let adminToken;

const ADMIN_EMPNO = 'E-ADMIN-P27';

// 7 known DEFAULTS keys with their expected primitive type.
const KNOWN_KEYS = {
  aiAuditEnabled: 'bool',
  aiExplainEnabled: 'bool',
  aiAskEnabled: 'bool',
  aiAssistEnabled: 'bool',
  aiExplainPerUserDailyLimit: 'number',
  aiAskPerUserDailyLimit: 'number',
  aiAssistPerUserDailyLimit: 'number',
};

async function seedAdmin() {
  const { User } = getModels();
  const admin = await User.create({
    empNo: ADMIN_EMPNO,
    name: 'Admin P27',
    role: 'admin',
    status: 'active',
    passwordHash: await bcrypt.hash('admin', 4),
  });
  adminToken = jwt.sign({ id: admin.id, role: 'admin' }, config.jwt.secret, { expiresIn: '7d' });
}

test.before(async () => {
  await resetDb();
  await seedAdmin();
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ code: 500, message: err.message || 'internal', data: null });
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await closeDb();
});

// ---------- helpers ----------

function request(method, path, body, token) {
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api' + path, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c.toString('utf8')));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { parsed = { __raw: raw }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function snapshotSettingsRows() {
  const { SystemSetting, AuditLog } = getModels();
  const [rows, settingAudits] = await Promise.all([
    SystemSetting.count(),
    AuditLog.count({ where: { action: 'setting.update' } }),
  ]);
  return { rows, settingAudits };
}

// ============================================================================
// P27.A: Unknown key → 400, no row, no audit, cache preserved
// ============================================================================

test('P27.A: PUT /api/admin/settings with unknown key → 400 + no row + no audit', async () => {
  const unknownKeyArb = fc
    .string({
      minLength: 3,
      maxLength: 24,
      unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
    })
    .filter((s) => s.trim().length > 0 && !Object.prototype.hasOwnProperty.call(KNOWN_KEYS, s));
  const valueArb = fc.oneof(fc.boolean(), fc.integer(), fc.string({ maxLength: 16 }));

  await fc.assert(
    fc.asyncProperty(unknownKeyArb, valueArb, async (key, value) => {
      // Pre-populate the in-memory cache so we can verify it survives.
      settings.invalidate();
      const cachedBefore = await settings.get('aiAuditEnabled');
      const before = await snapshotSettingsRows();

      const r = await request('PUT', '/admin/settings', { key, value }, adminToken);

      assert.ok(r.status >= 400 && r.status < 500, `unknown key must yield 4xx, got ${r.status}`);
      assert.notEqual(r.body.code, 0, 'failure response must have non-zero code');
      assert.match(
        String(r.body.message || ''),
        /未知的系统设置项|unknown/i,
        'message must indicate unknown setting key'
      );

      const after = await snapshotSettingsRows();
      assert.equal(after.rows, before.rows, 'no SystemSetting row may be created');
      assert.equal(after.settingAudits, before.settingAudits, 'no AuditLog setting.update may be written');

      // Cache preserved: invalidate was never called, so the same get() value is still served.
      const cachedAfter = await settings.get('aiAuditEnabled');
      assert.deepEqual(cachedAfter, cachedBefore, 'cache must be preserved on unknown-key rejection');
    }),
    { numRuns: 100 }
  );
});

// ============================================================================
// P27.B: Valid key + valid value → row upsert + AuditLog +1 + cache flushed
// ============================================================================

test('P27.B: PUT /api/admin/settings with valid key → upsert row + 1 audit + cache flushed', async () => {
  const knownKeyArb = fc.constantFrom(...Object.keys(KNOWN_KEYS));

  await fc.assert(
    fc.asyncProperty(
      knownKeyArb,
      fc.boolean(),
      fc.integer({ min: 0, max: 9999 }),
      async (key, boolVal, intVal) => {
        const value = KNOWN_KEYS[key] === 'bool' ? boolVal : intVal;

        const { SystemSetting, AuditLog } = getModels();
        // Clean slate per iteration.
        await SystemSetting.destroy({ where: { key } });
        await AuditLog.destroy({ where: { action: 'setting.update' } });
        settings.invalidate();
        // Populate cache before write so we can verify invalidate happens.
        await settings.get(key);

        const beforeAudits = await AuditLog.count({ where: { action: 'setting.update' } });

        const r = await request('PUT', '/admin/settings', { key, value }, adminToken);

        assert.equal(r.status, 200, `valid setting must succeed, body=${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, 0, 'success code must be 0');
        assert.deepEqual(r.body.data, { key, value }, 'response data must echo key + value');

        // Row must exist with JSON-stringified value.
        const row = await SystemSetting.findOne({ where: { key } });
        assert.ok(row, `SystemSetting row for key=${key} must be created`);
        assert.deepEqual(JSON.parse(row.value), value, 'persisted value must round-trip via JSON');

        // Exactly one new setting.update audit.
        const afterAudits = await AuditLog.count({ where: { action: 'setting.update' } });
        assert.equal(afterAudits - beforeAudits, 1, 'exactly one setting.update AuditLog must be written');

        // Cache flushed: GET returns the new value (forces loadAll to re-read).
        const list = await request('GET', '/admin/settings', null, adminToken);
        assert.equal(list.status, 200);
        const items = list.body && list.body.data && list.body.data.items;
        assert.ok(Array.isArray(items), 'GET /admin/settings must return items[]');
        const item = items.find((it) => it.key === key);
        assert.ok(item, `GET /admin/settings must include key=${key}`);
        assert.deepEqual(item.value, value, 'GET /admin/settings must reflect newly-written value');
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// P27.C: Simulated DB error during write → no row + no audit + cache preserved
// ============================================================================

test('P27.C: simulated DB error → 4xx + no row + no audit + cache preserved', async () => {
  const { SystemSetting, AuditLog } = getModels();
  const knownKeyArb = fc.constantFrom(...Object.keys(KNOWN_KEYS));

  const originalFindOrCreate = SystemSetting.findOrCreate.bind(SystemSetting);

  await fc.assert(
    fc.asyncProperty(
      knownKeyArb,
      fc.boolean(),
      fc.integer({ min: 0, max: 9999 }),
      async (key, boolVal, intVal) => {
        const value = KNOWN_KEYS[key] === 'bool' ? boolVal : intVal;

        // Clean slate.
        await SystemSetting.destroy({ where: { key } });
        await AuditLog.destroy({ where: { action: 'setting.update' } });
        settings.invalidate();
        // Populate cache so we can verify it survives the failure.
        const cachedBefore = await settings.get(key);
        const before = await snapshotSettingsRows();

        // Inject DB error into the setting service's persistence path.
        SystemSetting.findOrCreate = () => Promise.reject(new Error('SIMULATED_DB_ERROR'));
        try {
          const r = await request('PUT', '/admin/settings', { key, value }, adminToken);
          assert.ok(r.status >= 400 && r.status < 500, `expected 4xx on DB error, got ${r.status}`);
          assert.notEqual(r.body.code, 0, 'failure response must have non-zero code');
        } finally {
          SystemSetting.findOrCreate = originalFindOrCreate;
        }

        const after = await snapshotSettingsRows();
        assert.equal(after.rows, before.rows, 'no SystemSetting row may be created on DB failure');
        assert.equal(after.settingAudits, before.settingAudits, 'no AuditLog may be written on DB failure');

        // Cache must be preserved: invalidate is only called after a successful save.
        const cachedAfter = await settings.get(key);
        assert.deepEqual(cachedAfter, cachedBefore, 'cache must be preserved on DB write failure');
      }
    ),
    { numRuns: 100 }
  );
});
