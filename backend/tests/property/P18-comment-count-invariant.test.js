'use strict';

// Property 18: commentCount 不变量
// Validates: Requirements 8.7, 8.8, 8.9, 8.10
//
// 不变量：For any sequence of comment operations on a published post (create
// pass, create review-blocked, soft-delete), at every observable step the
// post's denormalised counter must agree with the database:
//
//     Post.commentCount === count(Comment WHERE postId = P.id AND status = 'active')
//
// Per design.md Property 18 and commentController.js:
//   - create + AI 'pass'     → Comment.status='active',  post.commentCount++
//   - create + AI 'review'   → Comment.status='blocked', post.commentCount NOT incremented
//   - delete (any prior)     → Comment.status='deleted', post.commentCount--
//
// Tests:
//   18.A: AI=pass, create-only sequences. Invariant holds after every step.
//   18.B: AI=pass, create+delete sequences (deletes pick existing active
//         comments only). Invariant holds after every step.
//   18.C: AI returns 'review' for the iteration's content. Asserts that
//         creating a review comment does NOT bump commentCount and the
//         persisted Comment.status === 'blocked'.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fc = require('fast-check');
const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');

const setup = require('./_setup');
const {
  resetDb,
  getModels,
  closeDb,
  config,
  installAiMock,
  restoreAiMock,
  setAiHandler,
  useCacheBackend,
} = setup;

const apiRouter = require('../../src/routes');

// ---------- harness ----------

let server;
let port;
const USERS = []; // [{ id, token }]
let categoryId;

function passReply() {
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

function reviewReply() {
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
            content: JSON.stringify({ status: 'review', reason: 'mock review', categories: [] }),
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  };
}

async function seedFixture() {
  const { User, Category } = getModels();
  const cat = await Category.create({ name: 'p18-cat', sort: 0, enabled: true });
  categoryId = cat.id;
  for (let i = 0; i < 4; i++) {
    const u = await User.create({
      empNo: `E-P18-${i}`,
      name: `p18u${i}`,
      role: 'user',
      status: 'active',
      passwordHash: await bcrypt.hash('x', 4),
    });
    const token = jwt.sign({ id: u.id, role: 'user' }, config.jwt.secret, { expiresIn: '7d' });
    USERS.push({ id: u.id, token });
  }
}

test.before(async () => {
  await resetDb();
  await useCacheBackend('memory');
  await installAiMock();
  setAiHandler(passReply);
  await seedFixture();

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
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
  await restoreAiMock();
  await closeDb();
});

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
    if (payload) req.write(payload);
    req.end();
  });
}

async function freshPost(authorIdx = 0) {
  const { Post } = getModels();
  return Post.create({
    title: 'P18 fixture post',
    content: 'fixture content body for P18 tests, > 5 chars',
    summary: '',
    authorId: USERS[authorIdx].id,
    categoryId,
    status: 'published',
  });
}

async function loadCommentCount(postId) {
  const { Post, Comment } = getModels();
  const fresh = await Post.findByPk(postId);
  const active = await Comment.count({ where: { postId, status: 'active' } });
  return { stored: fresh.commentCount, active };
}

// ============================================================================
// 18.A: AI=pass, create-only sequence
// ============================================================================

test('P18.A: create-only sequence (AI=pass) keeps commentCount === count(status=active)', async () => {
  setAiHandler(passReply);
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: USERS.length - 1 }), { minLength: 1, maxLength: 5 }),
      fc.array(fc.string({ minLength: 5, maxLength: 32 }), { minLength: 5, maxLength: 5 }),
      async (userIdxs, texts) => {
        const post = await freshPost(0);
        for (let i = 0; i < userIdxs.length; i++) {
          const content = (texts[i % texts.length] || 'hello content') + ' ok-marker';
          const r = await request(
            'POST',
            `/posts/${post.id}/comments`,
            { content },
            USERS[userIdxs[i]].token
          );
          assert.equal(
            r.status,
            200,
            `create comment failed at step ${i}: status=${r.status} body=${JSON.stringify(r.body)}`
          );
          const { stored, active } = await loadCommentCount(post.id);
          assert.equal(
            stored,
            active,
            `step ${i}: post.commentCount=${stored} but count(active)=${active}`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// 18.B: AI=pass, mixed create+delete sequence (delete only existing active)
// ============================================================================

test('P18.B: create+delete sequence (AI=pass) keeps commentCount === count(status=active)', async () => {
  setAiHandler(passReply);
  await fc.assert(
    fc.asyncProperty(
      // sequence of operations, each is either ('create', userIdx, contentSeed)
      // or ('delete') — actual delete target is chosen at exec time from the
      // currently-active comments owned by their author.
      fc.array(
        fc.oneof(
          fc.record({ op: fc.constant('create'), uIdx: fc.integer({ min: 0, max: USERS.length - 1 }) }),
          fc.record({ op: fc.constant('delete') })
        ),
        { minLength: 1, maxLength: 8 }
      ),
      async (ops) => {
        const post = await freshPost(0);
        const liveCommentIds = []; // [{ id, authorIdx }]

        for (let i = 0; i < ops.length; i++) {
          const op = ops[i];
          if (op.op === 'create') {
            const content = `step-${i}-content valid xyz`;
            const r = await request(
              'POST',
              `/posts/${post.id}/comments`,
              { content },
              USERS[op.uIdx].token
            );
            assert.equal(
              r.status,
              200,
              `create at step ${i} failed: status=${r.status} body=${JSON.stringify(r.body)}`
            );
            // Extract created id from response body
            const cid = r.body && r.body.data && r.body.data.id;
            assert.ok(typeof cid === 'number', `expected created comment id, got ${cid}`);
            liveCommentIds.push({ id: cid, authorIdx: op.uIdx });
          } else {
            // delete: pick the oldest live comment, deleted by its author
            if (liveCommentIds.length === 0) {
              // Nothing to delete — skip step, still verify invariant.
            } else {
              const target = liveCommentIds.shift();
              const r = await request(
                'DELETE',
                `/comments/${target.id}`,
                null,
                USERS[target.authorIdx].token
              );
              assert.equal(
                r.status,
                200,
                `delete at step ${i} failed: status=${r.status} body=${JSON.stringify(r.body)}`
              );
            }
          }
          const { stored, active } = await loadCommentCount(post.id);
          assert.equal(
            stored,
            active,
            `step ${i} (op=${op.op}): post.commentCount=${stored} count(active)=${active}`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// 18.C: AI=review path keeps commentCount unchanged AND persists status='blocked'
// ============================================================================

test('P18.C: review-path comment is persisted as blocked and does NOT bump commentCount', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: USERS.length - 1 }),
      fc.string({ minLength: 5, maxLength: 32 }),
      async (uIdx, seed) => {
        const post = await freshPost(0);
        // Establish a known baseline first — one passing comment (so count > 0).
        setAiHandler(passReply);
        const baseline = await request(
          'POST',
          `/posts/${post.id}/comments`,
          { content: `baseline ${seed} ok` },
          USERS[uIdx].token
        );
        assert.equal(baseline.status, 200, `baseline create failed: ${JSON.stringify(baseline.body)}`);
        const before = await loadCommentCount(post.id);
        assert.equal(before.stored, before.active, 'baseline invariant must hold');

        // Now flip mock to review and create a 2nd comment.
        setAiHandler(reviewReply);
        const r = await request(
          'POST',
          `/posts/${post.id}/comments`,
          { content: `review-seed ${seed} content` },
          USERS[uIdx].token
        );
        // The controller responds 200 + pending=true for review-path.
        assert.equal(r.status, 200, `review path status: ${r.status} body=${JSON.stringify(r.body)}`);
        assert.equal(r.body.data.pending, true, 'review path must respond with pending=true');
        const newId = r.body.data.id;

        const { Comment } = getModels();
        const c = await Comment.findByPk(newId);
        assert.equal(c.status, 'blocked', `review-path comment should be persisted as blocked, got ${c.status}`);

        const after = await loadCommentCount(post.id);
        // Active count must NOT have changed; commentCount must NOT have changed.
        assert.equal(after.active, before.active, 'count(active) must not change for review-path');
        assert.equal(
          after.stored,
          before.stored,
          `commentCount must NOT increment for review-path (before=${before.stored} after=${after.stored})`
        );
        assert.equal(after.stored, after.active, 'invariant must still hold after review-path');

        // Reset handler for subsequent iterations.
        setAiHandler(passReply);
      }
    ),
    { numRuns: 100 }
  );
});
