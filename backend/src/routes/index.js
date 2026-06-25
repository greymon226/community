'use strict';

const express = require('express');
const router = express.Router();

const { authRequired, authOptional, requireRole } = require('../middlewares/auth');

const auth = require('../controllers/authController');
const user = require('../controllers/userController');
const cat = require('../controllers/categoryController');
const post = require('../controllers/postController');
const comment = require('../controllers/commentController');
const notif = require('../controllers/notificationController');
const report = require('../controllers/reportController');
const admin = require('../controllers/adminController');
const upload = require('../controllers/uploadController');
const aiCtrl = require('../controllers/aiController');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 认证
router.get('/auth/cas/login-url', wrap(auth.loginUrl));
router.post('/auth/login', wrap(auth.localLogin)); // mock 登录
router.get('/auth/cas/callback', wrap(auth.casCallback));
router.get('/auth/github/login-url', wrap(auth.githubLoginUrl));
router.get('/auth/github/callback', wrap(auth.githubCallback));
router.get('/auth/me', authRequired, wrap(auth.me));
router.post('/auth/logout', authRequired, wrap(auth.logout));

// 用户
router.get('/users/me/posts', authRequired, wrap(user.myPosts));
router.get('/users/me/favorites', authRequired, wrap(user.myFavorites));
router.get('/users/me/comments', authRequired, wrap(user.myComments));
router.put('/users/me', authRequired, wrap(user.updateMe));
router.get('/users/:id', wrap(user.getProfile));

// 分类
router.get('/categories', wrap(cat.listTree));

// 帖子
router.get('/posts', authOptional, wrap(post.list));
router.get('/posts/recommend', authRequired, wrap(post.recommend));
router.get('/posts/:id/explain', authRequired, wrap(post.explain));
router.get('/posts/:id', authOptional, wrap(post.detail));
router.post('/posts', authRequired, wrap(post.create));
router.put('/posts/:id', authRequired, wrap(post.update));
router.delete('/posts/:id', authRequired, wrap(post.remove));
router.post('/posts/:id/like', authRequired, wrap(post.toggleLike));
router.post('/posts/:id/favorite', authRequired, wrap(post.toggleFavorite));

// 评论
router.get('/posts/:postId/comments', authOptional, wrap(comment.listByPost));
router.post('/posts/:postId/comments', authRequired, wrap(comment.create));
router.delete('/comments/:id', authRequired, wrap(comment.remove));
router.post('/comments/:id/like', authRequired, wrap(comment.toggleLike));

// 通知
router.get('/notifications', authRequired, wrap(notif.list));
router.post('/notifications/read', authRequired, wrap(notif.markRead));

// 举报
router.post('/reports', authRequired, wrap(report.create));

// 上传
router.post('/upload', authRequired, upload.upload.single('file'), wrap(upload.handle));

// AI 站内问答
router.post('/ai/ask', authRequired, wrap(aiCtrl.ask));
router.post('/ai/ask/stream', authRequired, wrap(aiCtrl.askStream));
router.post('/ai/assist', authRequired, wrap(aiCtrl.assist));

// ==========  管理后台 ==========
router.get('/admin/stats', authRequired, requireRole('admin'), wrap(admin.stats));
router.get('/admin/ai-stats', authRequired, requireRole('admin'), wrap(admin.aiStats));
router.get('/admin/users', authRequired, requireRole('admin'), wrap(admin.listUsers));
router.put('/admin/users/:id/role', authRequired, requireRole('admin'), wrap(admin.updateUserRole));

router.post('/admin/categories', authRequired, requireRole('admin'), wrap(cat.create));
router.put('/admin/categories/:id', authRequired, requireRole('admin'), wrap(cat.update));
router.delete('/admin/categories/:id', authRequired, requireRole('admin'), wrap(cat.remove));

router.post('/admin/posts/:id/pin', authRequired, requireRole('admin', 'moderator'), wrap(post.pin));
router.post('/admin/posts/:id/feature', authRequired, requireRole('admin', 'moderator'), wrap(post.feature));
router.post('/admin/posts/:id/block', authRequired, requireRole('admin', 'moderator'), wrap(post.block));

router.get('/admin/reports', authRequired, requireRole('admin', 'moderator'), wrap(report.list));
router.post('/admin/reports/:id/handle', authRequired, requireRole('admin', 'moderator'), wrap(report.handle));

router.get('/admin/sensitive-words', authRequired, requireRole('admin'), wrap(admin.listWords));
router.post('/admin/sensitive-words', authRequired, requireRole('admin'), wrap(admin.addWord));
router.delete('/admin/sensitive-words/:id', authRequired, requireRole('admin'), wrap(admin.deleteWord));

router.get('/admin/audit-logs', authRequired, requireRole('admin'), wrap(admin.listAudits));

router.get('/admin/settings', authRequired, requireRole('admin'), wrap(admin.listSettings));
router.put('/admin/settings', authRequired, requireRole('admin'), wrap(admin.updateSetting));
router.post('/admin/ai/test', authRequired, requireRole('admin'), wrap(admin.testAi));

module.exports = router;
