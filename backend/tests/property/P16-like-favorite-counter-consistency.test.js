'use strict';

// Property 16: 点赞 / 收藏切换的计数一致性
// Validates: Requirements 8.12, 9.1, 9.3
//
// 不变量：For ANY interleaving of (toggleLike, toggleFavorite) operations on
// a target (Post or Comment) by various users, after every observable step:
//
//     Post.likeCount      === count(Like     WHERE targetType='post'   AND targetId=P.id)
//     Post.favoriteCount  === count(Favorite WHERE postId    = P.id)
//     Comment.likeCount   === count(Like     WHERE targetType='comment' AND targetId=C.id)
//
// Idempotency / round-trip: the same user toggling like (or favorite) twice
// returns the target to its prior state — the counter is unchanged after
// two consecutive toggles by the same user.
//
// Tests:
//   16.A: Post.likeCount round-trip + per-step DB invariant under random
//         user×post×toggle sequences.
//   16.B: Post.favoriteCount round-trip + per-step DB invariant.
//   16.C: Comment.likeCount round-trip + per-step DB invariant.

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

async function seedFixture() {
  const { User, Category } = getModels();
  const cat = await Category.create({ name: 'p16-cat', sort: 0, enabled: true });
  categoryId = cat.id;
  for (let i = 0; i < 5; i++) {
    const u = await User.create({
      empNo: `E-P16-${i}`,
      name: `p16u${i}`,
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
    title: 'P16 fixture post',
    content: 'fixture content body for P16 tests, > 5 chars',
    summary: '',
    authorId: USERS[authorIdx].id,
    categoryId,
    status: 'published',
  });
}

async function freshComment(post, authorIdx) {
  const { Comment } = getModels();
  return Comment.create({
    postId: post.id,
    authorId: USERS[authorIdx].id,
    content: 'P16 fixture comment',
    status: 'active',
  });
}

async function loadPostLikeCount(postId) {
  const { Post, Like } = getModels();
  const fresh = await Post.findByPk(postId);
  const real = await Like.count({ where: { targetType: 'post', targetId: postId } });
  return { stored: fresh.likeCount, real };
}

async function loadPostFavoriteCount(postId) {
  const { Post, Favorite } = getModels();
  const fresh = await Post.findByPk(postId);
  const real = await Favorite.count({ where: { postId } });
  return { stored: fresh.favoriteCount, real };
}

async function loadCommentLikeCount(commentId) {
  const { Comment, Like } = getModels();
  const fresh = await Comment.findByPk(commentId);
  const real = await Like.count({ where: { targetType: 'comment', targetId: commentId } });
  return { stored: fresh.likeCount, real };
}

// ============================================================================
// 16.A: Post.likeCount consistency under random toggle sequences
// ============================================================================

test('P16.A: Post.likeCount === count(Like postId=P) after every toggle step', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: USERS.length - 1 }), { minLength: 1, maxLength: 12 }),
      async (toggleSeq) => {
        const post = await freshPost(0);
        // Track expected liked-state per user (simulator).
        const liked = new Set();
        for (let i = 0; i < toggleSeq.length; i++) {
          const u = USERS[toggleSeq[i]];
          const r = await request('POST', `/posts/${post.id}/like`, {}, u.token);
          assert.equal(
            r.status,
            200,
            `step ${i}: toggleLike failed status=${r.status} body=${JSON.stringify(r.body)}`
          );
          // Update simulator
          if (liked.has(u.id)) liked.delete(u.id);
          else liked.add(u.id);

          const { stored, real } = await loadPostLikeCount(post.id);
          assert.equal(
            stored,
            real,
            `step ${i}: post.likeCount=${stored} but count(Like)=${real}`
          );
          assert.equal(
            real,
            liked.size,
            `step ${i}: real count(Like)=${real} but simulator says ${liked.size} users liked`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// 16.A': double-toggle round-trip — same user, same post, twice → no net change
// ============================================================================

test("P16.A': double-toggle by same user returns post.likeCount to baseline", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: USERS.length - 1 }),
      async (uIdx) => {
        const post = await freshPost(0);
        const baseline = await loadPostLikeCount(post.id);
        const u = USERS[uIdx];
        const r1 = await request('POST', `/posts/${post.id}/like`, {}, u.token);
        assert.equal(r1.status, 200);
        const r2 = await request('POST', `/posts/${post.id}/like`, {}, u.token);
        assert.equal(r2.status, 200);
        const after = await loadPostLikeCount(post.id);
        assert.equal(
          after.stored,
          baseline.stored,
          `double toggle by uIdx=${uIdx} should be net-zero; baseline=${baseline.stored} after=${after.stored}`
        );
        assert.equal(after.real, after.stored, 'invariant must hold');
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// 16.B: Post.favoriteCount consistency
// ============================================================================

test('P16.B: Post.favoriteCount === count(Favorite postId=P) after every toggle step', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: USERS.length - 1 }), { minLength: 1, maxLength: 12 }),
      async (toggleSeq) => {
        const post = await freshPost(0);
        const favored = new Set();
        for (let i = 0; i < toggleSeq.length; i++) {
          const u = USERS[toggleSeq[i]];
          const r = await request('POST', `/posts/${post.id}/favorite`, {}, u.token);
          assert.equal(
            r.status,
            200,
            `step ${i}: toggleFavorite failed status=${r.status} body=${JSON.stringify(r.body)}`
          );
          if (favored.has(u.id)) favored.delete(u.id);
          else favored.add(u.id);

          const { stored, real } = await loadPostFavoriteCount(post.id);
          assert.equal(
            stored,
            real,
            `step ${i}: post.favoriteCount=${stored} but count(Favorite)=${real}`
          );
          assert.equal(
            real,
            favored.size,
            `step ${i}: real count(Favorite)=${real} but simulator says ${favored.size} users favored`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// 16.B': double-toggle round-trip for favorite
// ============================================================================

test("P16.B': double-toggle by same user returns post.favoriteCount to baseline", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: USERS.length - 1 }),
      async (uIdx) => {
        const post = await freshPost(0);
        const baseline = await loadPostFavoriteCount(post.id);
        const u = USERS[uIdx];
        const r1 = await request('POST', `/posts/${post.id}/favorite`, {}, u.token);
        assert.equal(r1.status, 200);
        const r2 = await request('POST', `/posts/${post.id}/favorite`, {}, u.token);
        assert.equal(r2.status, 200);
        const after = await loadPostFavoriteCount(post.id);
        assert.equal(
          after.stored,
          baseline.stored,
          `double favorite-toggle by uIdx=${uIdx} should be net-zero; baseline=${baseline.stored} after=${after.stored}`
        );
        assert.equal(after.real, after.stored, 'invariant must hold');
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// 16.C: Comment.likeCount consistency under random toggle sequences
// ============================================================================

test('P16.C: Comment.likeCount === count(Like targetType=comment) after every toggle step', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: USERS.length - 1 }), { minLength: 1, maxLength: 12 }),
      async (toggleSeq) => {
        const post = await freshPost(0);
        const comment = await freshComment(post, 0);
        const liked = new Set();
        for (let i = 0; i < toggleSeq.length; i++) {
          const u = USERS[toggleSeq[i]];
          const r = await request('POST', `/comments/${comment.id}/like`, {}, u.token);
          assert.equal(
            r.status,
            200,
            `step ${i}: comment toggleLike failed status=${r.status} body=${JSON.stringify(r.body)}`
          );
          if (liked.has(u.id)) liked.delete(u.id);
          else liked.add(u.id);

          const { stored, real } = await loadCommentLikeCount(comment.id);
          assert.equal(
            stored,
            real,
            `step ${i}: comment.likeCount=${stored} but count(Like)=${real}`
          );
          assert.equal(
            real,
            liked.size,
            `step ${i}: real count(Like)=${real} but simulator says ${liked.size} users liked`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});
