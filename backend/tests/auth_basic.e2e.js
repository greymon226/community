'use strict';

// 验证基础闭环：登录 → 分类 → 发帖 → 详情 → 点赞收藏 → 评论 → admin 加精 → 搜索 → admin stats → 通知
const { api, login, expectOk, assert, step, pass } = require('./_helper');

(async () => {
  step('login as user001 / admin');
  const userToken = await login('user001', 'user123');
  const adminToken = await login('admin', 'admin123');
  pass('登录成功');

  step('GET /categories');
  const tree = await expectOk(api('GET', '/categories'), 'categories');
  assert(tree.length > 0, 'categories tree non-empty');
  const sub = tree.find((c) => c.children?.length);
  assert(sub, 'should have a category with children');
  const cid = sub.children[0].id;
  pass(`找到子分类 #${cid} ${sub.children[0].name}`);

  step('POST /posts (确保 AI 关闭以避免依赖外部模型)');
  // 关闭 AI 审核，让此用例不依赖 DeepSeek 网络
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAuditEnabled', value: false }, adminToken), 'disable ai audit');

  const post = await expectOk(api('POST', '/posts', {
    title: '[e2e] 基础流程测试',
    content: '<p>hello e2e</p>',
    categoryId: cid,
    tags: ['E2E'],
  }, userToken), 'create post');
  assert(post.id, 'created post should have id');
  pass(`帖子创建 #${post.id}`);

  step('GET /posts/:id');
  const detail = await expectOk(api('GET', `/posts/${post.id}`, null, userToken), 'detail');
  assert(detail.title === post.title, 'title round trip');
  pass('详情读取正常');

  step('like + favorite');
  const liked = await expectOk(api('POST', `/posts/${post.id}/like`, {}, userToken), 'like');
  assert(liked.liked === true, 'liked=true');
  const favorited = await expectOk(api('POST', `/posts/${post.id}/favorite`, {}, userToken), 'favorite');
  assert(favorited.favorited === true, 'favorited=true');
  pass('点赞 / 收藏 OK');

  step('comment');
  const c = await expectOk(api('POST', `/posts/${post.id}/comments`, { content: '<p>很赞</p>' }, userToken), 'comment');
  assert(c.id, 'comment id');
  pass(`评论创建 #${c.id}`);

  step('admin feature');
  const featured = await expectOk(api('POST', `/admin/posts/${post.id}/feature`, {}, adminToken), 'feature');
  assert(featured.featured === true, 'featured=true');
  pass('加精成功');

  step('search by hot');
  const list = await expectOk(api('GET', '/posts?sort=hot&pageSize=5'), 'search');
  assert(Array.isArray(list.items), 'items array');
  pass(`搜索结果 ${list.items.length} 条 / 总 ${list.total}`);

  step('admin stats');
  const stats = await expectOk(api('GET', '/admin/stats', null, adminToken), 'stats');
  assert(typeof stats.users === 'number', 'stats.users');
  pass(`stats: users=${stats.users} posts=${stats.posts} comments=${stats.comments}`);

  step('notifications for user001 (likely empty since 自己点赞自己)');
  const notif = await expectOk(api('GET', '/notifications', null, userToken), 'notifications');
  assert(Array.isArray(notif.items), 'notifications.items');
  pass(`未读 ${notif.unreadCount} / 共 ${notif.items.length}`);

  // 还原 AI 开关
  await expectOk(api('PUT', '/admin/settings', { key: 'aiAuditEnabled', value: true }, adminToken), 'restore ai audit');

  console.log('\n✅ auth_basic 全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
