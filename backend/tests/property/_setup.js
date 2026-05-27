'use strict';

// Property-test scaffolding for backend/tests/property/*.test.js
//
// Provides:
//   - In-memory SQLite Sequelize instance (reuses existing src/models registry)
//   - resetDb() / closeDb() helpers
//   - AI mock HTTP server (installAiMock / setAiHandler / restoreAiMock)
//   - Cache_Service backend switching (useCacheBackend('memory' | 'redis-mock'))
//
// File name starts with `_` so it is NOT collected by `npm run test:property`.
//
// IMPORTANT: this module sets process.env values before any require of
// `../../src/config` or `../../src/models`, so it should be required FIRST
// in any property test file:
//
//   const setup = require('./_setup');
//   const { getModels, resetDb, installAiMock, ... } = setup;

// ---------- 1. Force test-only env BEFORE config/models are loaded ----------
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = ':memory:';
// Property tests must never reach the real Redis. Default to memory backend.
delete process.env.REDIS_URL;
// Property tests must never reach the real DeepSeek API. AI mock will overwrite
// these at install time; the dummy values here are just safety defaults.
process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'local';
process.env.AI_API_KEY = process.env.AI_API_KEY || '';

const http = require('http');
const path = require('path');
const Module = require('module');

// Now safe to require config & models; they will pick up sqlite memory.
const config = require('../../src/config');
const models = require('../../src/models');

// ---------- 2. Database helpers ----------
function getSequelize() {
  return models.sequelize;
}

function getModels() {
  return models;
}

/**
 * Drop & recreate all tables. Cheap on in-memory sqlite, ≤ a few ms.
 */
async function resetDb() {
  await models.sequelize.sync({ force: true });
}

async function closeDb() {
  try {
    await models.sequelize.close();
  } catch (_e) {
    /* noop */
  }
}

// ---------- 3. AI mock server ----------
let aiServer = null;
let aiServerUrl = null;
let aiHandler = defaultAiHandler;
const aiOriginal = {
  baseUrl: null,
  provider: null,
  apiKey: null,
  installed: false,
};

/**
 * Default AI handler: respond with a benign `pass` audit JSON for
 * /v1/chat/completions. Tests can override via setAiHandler().
 */
function defaultAiHandler(_req, _body) {
  return {
    status: 200,
    json: {
      id: 'mock',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({ status: 'pass', reason: '', categories: [] }),
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  };
}

/**
 * Replace the AI handler used by the mock server.
 *
 * @param {(req, body) => (Response|Promise<Response>)} handler
 *   where Response is one of:
 *     { status: number, json: any }
 *     { status: number, body: string, headers?: object }
 *     { status: number, sse: AsyncIterable<string|object> }  // SSE stream
 *
 * The handler receives the parsed JSON body when Content-Type is JSON,
 * otherwise the raw string.
 */
function setAiHandler(handler) {
  aiHandler = typeof handler === 'function' ? handler : defaultAiHandler;
}

function resetAiHandler() {
  aiHandler = defaultAiHandler;
}

async function installAiMock() {
  if (aiOriginal.installed) {
    return { url: aiServerUrl };
  }
  await new Promise((resolve, reject) => {
    aiServer = http.createServer(async (req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c.toString('utf8');
      });
      req.on('end', async () => {
        let parsed = raw;
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/json') && raw) {
          try {
            parsed = JSON.parse(raw);
          } catch (_e) {
            parsed = raw;
          }
        }
        let result;
        try {
          result = await aiHandler(req, parsed);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: { message: String(err && err.message) } }));
          return;
        }
        if (!result) {
          res.statusCode = 404;
          res.end();
          return;
        }
        // SSE stream
        if (result.sse && typeof result.sse[Symbol.asyncIterator] === 'function') {
          res.statusCode = result.status || 200;
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          try {
            for await (const chunk of result.sse) {
              const line =
                typeof chunk === 'string'
                  ? chunk
                  : `data: ${JSON.stringify(chunk)}\n\n`;
              res.write(line);
            }
          } finally {
            res.end();
          }
          return;
        }
        // Plain JSON
        if (result.json !== undefined) {
          res.statusCode = result.status || 200;
          res.setHeader('Content-Type', 'application/json');
          if (result.headers) {
            for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
          }
          res.end(JSON.stringify(result.json));
          return;
        }
        // Plain body
        res.statusCode = result.status || 200;
        if (result.headers) {
          for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
        }
        res.end(result.body || '');
      });
      req.on('error', () => {
        try {
          res.statusCode = 400;
          res.end();
        } catch (_e) {
          /* noop */
        }
      });
    });
    aiServer.on('error', reject);
    aiServer.listen(0, '127.0.0.1', () => {
      const addr = aiServer.address();
      aiServerUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  // Mutate config so aiService.js picks up the mock URL on next call.
  aiOriginal.baseUrl = config.ai.baseUrl;
  aiOriginal.provider = config.ai.provider;
  aiOriginal.apiKey = config.ai.apiKey;
  aiOriginal.installed = true;
  config.ai.baseUrl = aiServerUrl;
  config.ai.provider = 'deepseek'; // forces LLM path in aiService.auditContent
  config.ai.apiKey = 'test-mock-key';

  // Also export via env in case downstream code re-reads it.
  process.env.AI_BASE_URL = aiServerUrl;
  process.env.AI_PROVIDER = 'deepseek';
  process.env.AI_API_KEY = 'test-mock-key';

  return { url: aiServerUrl };
}

async function restoreAiMock() {
  if (!aiOriginal.installed) return;
  resetAiHandler();
  await new Promise((resolve) => {
    if (!aiServer) return resolve();
    aiServer.close(() => resolve());
  });
  aiServer = null;
  aiServerUrl = null;
  config.ai.baseUrl = aiOriginal.baseUrl;
  config.ai.provider = aiOriginal.provider;
  config.ai.apiKey = aiOriginal.apiKey;
  aiOriginal.installed = false;
}

// ---------- 4. Cache backend switching ----------
//
// cacheService uses `require('redis').createClient(...)` (v4 client). To
// exercise the redis-mock path without touching production code, we install
// a tiny in-memory shim into Node's module cache that satisfies the subset
// of the `redis` v4 API used by cacheService (createClient + on + connect +
// get + set { EX } + del). For the 'memory' backend we simply leave
// config.redisUrl null so cacheService falls back to its built-in Map.

const cacheServicePath = require.resolve('../../src/services/cacheService');
const redisModulePath = require.resolve('redis');

let activeCacheBackend = null;

function makeRedisShim() {
  const store = new Map();
  function client() {
    const handlers = {};
    return {
      on(ev, fn) {
        handlers[ev] = fn;
        return this;
      },
      async connect() {
        return this;
      },
      async quit() {
        store.clear();
        return 'OK';
      },
      async disconnect() {
        store.clear();
      },
      async get(key) {
        const e = store.get(key);
        if (!e) return null;
        if (e.expireAt && e.expireAt < Date.now()) {
          store.delete(key);
          return null;
        }
        return e.value;
      },
      async set(key, value, opts) {
        let expireAt = null;
        if (opts && typeof opts.EX === 'number' && opts.EX > 0) {
          expireAt = Date.now() + opts.EX * 1000;
        }
        store.set(key, { value: String(value), expireAt });
        return 'OK';
      },
      async del(key) {
        return store.delete(key) ? 1 : 0;
      },
      async incr(key) {
        const e = store.get(key);
        const n = e ? Number(e.value) || 0 : 0;
        const next = n + 1;
        store.set(key, { value: String(next), expireAt: e ? e.expireAt : null });
        return next;
      },
      async expire(key, sec) {
        const e = store.get(key);
        if (!e) return 0;
        e.expireAt = Date.now() + sec * 1000;
        store.set(key, e);
        return 1;
      },
      // tests can call this to inspect state
      _store: store,
    };
  }
  return { createClient: client };
}

function clearRequireCache(...absPaths) {
  for (const p of absPaths) {
    delete require.cache[p];
  }
}

function installRedisShim() {
  const shim = makeRedisShim();
  // Replace the cached `redis` module entry. We synthesize a Module so that
  // subsequent `require('redis')` calls inside cacheService receive the shim.
  const m = new Module(redisModulePath);
  m.filename = redisModulePath;
  m.loaded = true;
  m.exports = shim;
  require.cache[redisModulePath] = m;
  return shim;
}

function uninstallRedisShim() {
  delete require.cache[redisModulePath];
}

/**
 * Switch the cache backend used by `src/services/cacheService`.
 *
 * @param {'memory'|'redis-mock'} kind
 * @returns {object} freshly required cacheService module (initialised)
 */
async function useCacheBackend(kind) {
  if (kind !== 'memory' && kind !== 'redis-mock') {
    throw new Error(`useCacheBackend: unknown backend ${kind}`);
  }
  // Drop the cached cacheService so it re-evaluates with the new backend.
  clearRequireCache(cacheServicePath);
  if (kind === 'memory') {
    config.redisUrl = null;
    delete process.env.REDIS_URL;
    uninstallRedisShim();
  } else {
    installRedisShim();
    config.redisUrl = 'redis://mock';
    process.env.REDIS_URL = 'redis://mock';
  }
  const cache = require('../../src/services/cacheService');
  await cache.init();
  activeCacheBackend = { kind, cache };
  return cache;
}

/**
 * Get the currently active cache module (after useCacheBackend has been
 * called). Returns null if not configured yet.
 */
function getCache() {
  return activeCacheBackend ? activeCacheBackend.cache : null;
}

/**
 * Force-clear all keys regardless of backend (for between-iteration cleanup).
 */
async function clearCache() {
  if (!activeCacheBackend) return;
  // Both memory + shim implementations expose internal stores we can wipe by
  // re-initialising the module. Easiest: reset the require cache + re-init.
  clearRequireCache(cacheServicePath);
  if (activeCacheBackend.kind === 'redis-mock') {
    // Reinstall a fresh shim so the in-memory map is empty.
    installRedisShim();
  }
  const cache = require('../../src/services/cacheService');
  await cache.init();
  activeCacheBackend.cache = cache;
}

module.exports = {
  // db
  getSequelize,
  getModels,
  resetDb,
  closeDb,
  // ai mock
  installAiMock,
  restoreAiMock,
  setAiHandler,
  resetAiHandler,
  getAiMockUrl: () => aiServerUrl,
  // cache backend
  useCacheBackend,
  getCache,
  clearCache,
  // misc
  config,
  paths: {
    cacheServicePath,
    redisModulePath,
  },
};
