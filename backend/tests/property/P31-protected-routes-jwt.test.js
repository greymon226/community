'use strict';

// Property 31: 受保护路由必须 JWT 鉴权
// See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
// Validates: Requirements 23.5
//
// 不变量：For ANY route `r` mounted under /api/* whose middleware stack
// contains the `authRequired` middleware, sending a request to `r` WITHOUT
// any Authorization header must result in HTTP 401 + body.code = 401, with
// `data: null`. The downstream handler must NOT execute.
//
// We discover the set of protected routes dynamically by walking
// `router.stack` of `src/routes/index.js`, comparing each layer's handler
// list against the `authRequired` reference. fast-check picks routes
// uniformly at random for ≥100 iterations.
//
// Implementation details:
//   - Mount the full /api router into a tiny inline express app, listen on
//     port 0, and drive requests with Node's http.request.
//   - For paths containing `:param` placeholders, substitute `1` (the
//     auth check fires before any param-dependent logic).
//   - For POST/PUT/DELETE, send an empty JSON body. authRequired runs
//     before any controller-level validation, so a 401 is the only
//     observable status for unauthenticated requests.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fc = require('fast-check');
const express = require('express');

const setup = require('./_setup');
const { resetDb, closeDb } = setup;

const apiRouter = require('../../src/routes');
const { authRequired } = require('../../src/middlewares/auth');

// ---------- discover protected routes ----------

/**
 * Walk an express Router stack and yield concrete (method, path) entries
 * whose middleware chain contains `authRequired`.
 *
 * The router from `src/routes/index.js` is flat (no nested .use(subRouter));
 * we still defensively recurse if a nested router is encountered.
 */
function discoverProtectedRoutes(router, prefix = '') {
  const out = [];
  for (const layer of router.stack || []) {
    if (layer.route) {
      const handlers = (layer.route.stack || []).map((l) => l.handle);
      const hasAuth = handlers.includes(authRequired);
      if (!hasAuth) continue;
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
      for (const method of methods) {
        out.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
      }
    } else if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
      // Defensive: in case future refactors mount nested routers.
      out.push(...discoverProtectedRoutes(layer.handle, prefix));
    }
  }
  return out;
}

const PROTECTED_ROUTES = discoverProtectedRoutes(apiRouter);

// Replace :paramName placeholders with concrete values that pass through
// authRequired. Auth check happens before param parsing, so any value is
// fine — we use '1' for numeric-flavored ids.
function substituteParams(path) {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '1');
}

const REQUEST_BODIES = {
  GET: undefined,
  POST: '{}',
  PUT: '{}',
  PATCH: '{}',
  DELETE: undefined,
};

// ---------- HTTP server ----------

let server;
let port;

test.before(async () => {
  await resetDb();
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
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

// ---------- helper: send request without Authorization header ----------

function unauthenticatedRequest(method, path) {
  const body = REQUEST_BODIES[method];
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api' + path,
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c.toString('utf8')));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = { __raw: raw };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---------- sanity check: non-empty discovery ----------

test('P31.0: at least one protected route is discovered (sanity check)', () => {
  assert.ok(
    PROTECTED_ROUTES.length >= 5,
    `expected ≥5 protected routes, found ${PROTECTED_ROUTES.length}`
  );
  // Spot-check that key endpoints from the design doc are protected.
  const hits = PROTECTED_ROUTES.map((r) => `${r.method} ${r.path}`);
  for (const expected of [
    'GET /auth/me',
    'POST /posts',
    'POST /reports',
    'GET /admin/stats',
    'GET /notifications',
  ]) {
    assert.ok(
      hits.includes(expected),
      `expected ${expected} to be protected; discovered=${JSON.stringify(hits)}`
    );
  }
});

// ---------- main property ----------

test('P31.A: every protected route returns 401 + code=401 without Authorization', async () => {
  const routeArb = fc.constantFrom(...PROTECTED_ROUTES);
  await fc.assert(
    fc.asyncProperty(routeArb, async (route) => {
      const concretePath = substituteParams(route.path);
      const r = await unauthenticatedRequest(route.method, concretePath);
      assert.equal(
        r.status,
        401,
        `expected 401 for ${route.method} /api${concretePath}, got ${r.status} body=${JSON.stringify(r.body)}`
      );
      assert.ok(r.body && typeof r.body === 'object', 'body must be JSON object');
      assert.equal(
        r.body.code,
        401,
        `body.code must be 401, got ${r.body.code} for ${route.method} /api${concretePath}`
      );
      assert.equal(r.body.data, null, `body.data must be null on auth failure`);
      assert.equal(typeof r.body.message, 'string');
    }),
    { numRuns: 150 }
  );
});

// ---------- additional property: known PUBLIC routes are NOT 401-gated ----------

test('P31.B: documented public routes do not 401 without Authorization', async () => {
  // Per design.md Property 31: GET /auth/cas/login-url, POST /auth/login,
  // GET /auth/cas/callback, GET /categories, GET /posts, GET /posts/:id,
  // GET /posts/:postId/comments, GET /users/:id are NOT protected.
  const cases = [
    { method: 'GET', path: '/auth/cas/login-url' },
    { method: 'GET', path: '/categories' },
    { method: 'GET', path: '/posts' },
  ];
  for (const c of cases) {
    const r = await unauthenticatedRequest(c.method, c.path);
    assert.notEqual(
      r.status,
      401,
      `public route ${c.method} ${c.path} must NOT 401 (got ${r.status})`
    );
  }
});

// ---------- additional property: non-existent /api routes 404, not 401 ----------

test('P31.C: unknown /api/* routes are 404 by router default (not silently 401)', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc
        .string({
          minLength: 4,
          maxLength: 32,
          unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
        })
        .map((s) => `/${s}-nope`),
      async (path) => {
        // Skip if it accidentally collides with a real route prefix.
        const collides = PROTECTED_ROUTES.some((r) => r.path === path);
        if (collides) return;
        const r = await unauthenticatedRequest('GET', path);
        // Express returns 404 by default for unmatched routes (no global
        // notFound is mounted on this minimal harness). Either 404 or
        // some other 4xx is acceptable; what matters is that we do NOT
        // observe an erroneous 401 for a non-existent route.
        assert.notEqual(
          r.status,
          401,
          `unknown route ${path} returned 401 — auth gate may be over-broad`
        );
      }
    ),
    { numRuns: 100 }
  );
});
