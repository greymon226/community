'use strict';

// Property 17: 仅"未赞 → 已赞"产生通知
// Validates: Requirement 9.2
//
// 不变量：For ANY interleaving of toggleLike operations on a post by various
// users, the count of `Notification` rows of type='liked' addressed to the
// post author equals the number of "unliked → liked" transitions performed
// by users OTHER THAN the post author. In particular:
//
//   - Toggling from unliked → liked   creates exactly one notification.
//   - Toggling from liked   → unliked creates NO notification AND does NOT
//     delete the previously-created one (notifications are an append-only
//     audit of the rising-edge events; the spec only forbids creating new
//     ones on the falling edge — see notificationService.js: it never deletes).
//   - Self-likes (user is the post author) NEVER produce a notification.
//
// We also verify the stronger end-to-end identity:
//   |notifications(liked)| === |{ rising-edge transitions by non-author users }|
//
// Tests:
//   17.A: Random toggle sequences by non-author users — notification count
//         tracks the rising-edge count (and falling edges add zero).
//   17.B: Self-like by the author NEVER creates a notification.
//   17.C: Mixed (author + non-author) sequences: only non-author rising edges
//         contribute to the liked-notification count.

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
  const cat = await Category.create({ name: 'p17-cat', sort: 0, enabled: true });
  categoryId = cat.id;
  for (let i = 0; i < 5; i++) {
    const u = await User.create({
      empNo: `E-P17-${i}`,
      name: `p17u${i}`,
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

async function freshPost(authorIdx) {
  const { Post } = getModels();
  return Post.create({
    title: 'P17 fixture post',
    content: 'fixture content body for P17 tests, > 5 chars',
    summary: '',
    authorId: USERS[authorIdx].id,
    categoryId,
    status: 'published',
  });
}

// Wipe notification state at the start of each property iteration so the
// observed count reflects only the rising edges produced in THIS iteration.
// (Notifications never carry the authoring iteration id, and seeded users
// are reused across iterations to keep DB churn low.)
async function resetNotifications() {
  const { Notification } = getModels();
  await Notification.destroy({ where: {} });
}

async function countLikedNotifications(authorId, _postId) {
  const { Notification } = getModels();
  return Notification.count({ where: { userId: authorId, type: 'liked' } });
}

// ============================================================================
// 17.A: Non-author rising-edge transitions equal the liked-notification count
// ============================================================================

test('P17.A: notification(liked) count equals non-author rising-edge transitions', async () => {
  await fc.assert(
    fc.asyncProperty(
      // sequence of toggle ops by non-author users (idx 1..4); author is idx 0
      fc.array(fc.integer({ min: 1, max: USERS.length - 1 }), { minLength: 1, maxLength: 12 }),
      async (toggleSeq) => {
        const authorIdx = 0;
        await resetNotifications();
        const post = await freshPost(authorIdx);

        const liked = new Set(); // simulator: which user-ids currently like
        let risingEdges = 0;

        for (let i = 0; i < toggleSeq.length; i++) {
          const u = USERS[toggleSeq[i]];
          const wasLiked = liked.has(u.id);
          const r = await request('POST', `/posts/${post.id}/like`, {}, u.token);
          assert.equal(
            r.status,
            200,
            `step ${i}: toggleLike failed status=${r.status} body=${JSON.stringify(r.body)}`
          );
          if (wasLiked) {
            liked.delete(u.id);
          } else {
            liked.add(u.id);
            risingEdges += 1;
          }

          const got = await countLikedNotifications(USERS[authorIdx].id, post.id);
          assert.equal(
            got,
            risingEdges,
            `step ${i} (uid=${u.id} ${wasLiked ? 'unlike' : 'like'}): expected ${risingEdges} liked-notifications, got ${got}`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// 17.B: Self-like by the post author NEVER creates a notification
// ============================================================================

test('P17.B: self-like (author likes own post) creates NO liked-notification', async () => {
  await fc.assert(
    fc.asyncProperty(
      // arbitrary number of self-toggles (some odd → ends liked, some even → ends unliked)
      fc.integer({ min: 1, max: 10 }),
      async (n) => {
        const authorIdx = 0;
        await resetNotifications();
        const post = await freshPost(authorIdx);
        for (let i = 0; i < n; i++) {
          const r = await request('POST', `/posts/${post.id}/like`, {}, USERS[authorIdx].token);
          assert.equal(r.status, 200, `self-toggle ${i} failed: ${JSON.stringify(r.body)}`);
        }
        const got = await countLikedNotifications(USERS[authorIdx].id, post.id);
        assert.equal(
          got,
          0,
          `self-likes must produce NO liked-notification (got ${got} after ${n} self-toggles)`
        );
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// 17.C: Mixed sequences — only non-author rising edges count
// ============================================================================

test('P17.C: mixed (author + non-author) sequence — only non-author rising edges count', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: USERS.length - 1 }), { minLength: 1, maxLength: 14 }),
      async (toggleSeq) => {
        const authorIdx = 0;
        await resetNotifications();
        const post = await freshPost(authorIdx);

        const liked = new Set();
        let nonAuthorRisingEdges = 0;

        for (let i = 0; i < toggleSeq.length; i++) {
          const uIdx = toggleSeq[i];
          const u = USERS[uIdx];
          const wasLiked = liked.has(u.id);
          const r = await request('POST', `/posts/${post.id}/like`, {}, u.token);
          assert.equal(r.status, 200, `step ${i}: toggleLike failed: ${JSON.stringify(r.body)}`);

          if (wasLiked) {
            liked.delete(u.id);
            // falling edge — no notification regardless of who
          } else {
            liked.add(u.id);
            // rising edge — only counts if user is NOT the author
            if (uIdx !== authorIdx) nonAuthorRisingEdges += 1;
          }

          const got = await countLikedNotifications(USERS[authorIdx].id, post.id);
          assert.equal(
            got,
            nonAuthorRisingEdges,
            `step ${i} (uIdx=${uIdx} ${wasLiked ? 'unlike' : 'like'}): expected ${nonAuthorRisingEdges} liked-notifications, got ${got}`
          );
        }
      }
    ),
    { numRuns: 100 }
  );
});

// ============================================================================
// 17.D: Falling-edge specifically does not delete previously-created
//        liked-notifications.
// ============================================================================

test('P17.D: falling edge (liked → unliked) does not remove prior liked-notification', async () => {
  await fc.assert(
    fc.asyncProperty(
      // single non-author user who toggles like an EVEN number of times.
      // After 2k toggles the user is back to "unliked" but k rising edges
      // happened earlier — the count must still equal k (no rollback).
      fc.integer({ min: 1, max: 4 }).map((k) => k * 2),
      fc.integer({ min: 1, max: USERS.length - 1 }),
      async (cycles, uIdx) => {
        const authorIdx = 0;
        await resetNotifications();
        const post = await freshPost(authorIdx);
        const u = USERS[uIdx];
        for (let i = 0; i < cycles; i++) {
          const r = await request('POST', `/posts/${post.id}/like`, {}, u.token);
          assert.equal(r.status, 200);
        }
        const got = await countLikedNotifications(USERS[authorIdx].id, post.id);
        assert.equal(
          got,
          cycles / 2,
          `after ${cycles} toggles ending in 'unliked', expected ${cycles / 2} surviving notifications (no rollback), got ${got}`
        );
      }
    ),
    { numRuns: 100 }
  );
});
