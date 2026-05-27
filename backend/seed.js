'use strict';

const bcrypt = require('bcryptjs');
const db = require('./src/models');
const { User, Category, Post, Tag, PostTag, SensitiveWord } = db;

async function run() {
  await db.sequelize.sync({ alter: true });

  // 用户
  const users = [
    {
      empNo: 'admin', name: '系统管理员', nickname: 'Admin',
      email: 'admin@example.com', department: '运营组',
      role: 'admin', password: 'admin123', techTags: 'Node.js,系统架构',
    },
    {
      empNo: 'mod001', name: '张版主', nickname: 'Vue大佬',
      email: 'mod001@example.com', department: '前端组',
      role: 'moderator', password: 'mod123', techTags: 'Vue,React,前端',
      moderatorCategoryIds: [],
    },
    {
      empNo: 'user001', name: '李工程师', nickname: '后端小李',
      email: 'user001@example.com', department: '后端组',
      role: 'user', password: 'user123', techTags: 'Java,Spring,MySQL',
    },
    {
      empNo: 'user002', name: '王同学', nickname: '测试达人',
      email: 'user002@example.com', department: '测试组',
      role: 'user', password: 'user123', techTags: '自动化测试,Python',
    },
  ];

  for (const u of users) {
    const passwordHash = await bcrypt.hash(u.password, 8);
    await User.findOrCreate({
      where: { empNo: u.empNo },
      defaults: {
        empNo: u.empNo,
        name: u.name,
        nickname: u.nickname,
        email: u.email,
        department: u.department,
        role: u.role,
        passwordHash,
        techTags: u.techTags,
        moderatorCategoryIds: JSON.stringify(u.moderatorCategoryIds || []),
      },
    });
  }

  // 分类
  const cats = [
    { name: '前端开发', sort: 1, children: [{ name: 'React/Vue' }, { name: '工程化' }] },
    { name: '后端开发', sort: 2, children: [{ name: 'Java/Spring' }, { name: 'Node.js' }, { name: 'Go' }] },
    { name: '测试与运维', sort: 3, children: [{ name: '自动化测试' }, { name: 'DevOps' }] },
    { name: '产品 & 设计', sort: 4 },
    { name: '公司公告', sort: 0 },
  ];

  const catMap = new Map();
  for (const c of cats) {
    const [parent] = await Category.findOrCreate({
      where: { name: c.name, parentId: null },
      defaults: { name: c.name, sort: c.sort, description: `${c.name}相关讨论` },
    });
    catMap.set(c.name, parent.id);
    for (const child of c.children || []) {
      const [sub] = await Category.findOrCreate({
        where: { name: child.name, parentId: parent.id },
        defaults: { name: child.name, parentId: parent.id, description: `${child.name}相关讨论` },
      });
      catMap.set(child.name, sub.id);
    }
  }

  // 给 mod001 设置板块
  const mod = await User.findOne({ where: { empNo: 'mod001' } });
  if (mod) {
    mod.moderatorCategoryIds = JSON.stringify([catMap.get('React/Vue'), catMap.get('工程化')].filter(Boolean));
    await mod.save();
  }

  // 标签
  const tagNames = ['Vue', 'React', 'Node.js', '微服务', '性能优化', 'CI/CD', '面试', 'AI'];
  const tags = [];
  for (const name of tagNames) {
    const [t] = await Tag.findOrCreate({ where: { name } });
    tags.push(t);
  }

  // 敏感词
  const words = [
    { word: '推广广告', strategy: 'block' },
    { word: '测试敏感词', strategy: 'mask' },
  ];
  for (const w of words) {
    await SensitiveWord.findOrCreate({ where: { word: w.word }, defaults: w });
  }

  // 示例帖子
  const sampleAuthor = await User.findOne({ where: { empNo: 'user001' } });
  if (sampleAuthor) {
    const cnt = await Post.count();
    if (cnt === 0) {
      const post1 = await Post.create({
        title: '欢迎来到企业技术交流社区',
        content: '<h2>欢迎</h2><p>在这里分享你的技术心得，提问交流。</p><pre><code class="language-js">console.log("hello community");</code></pre>',
        summary: '欢迎新人帖：分享技术心得，提问交流。',
        authorId: (await User.findOne({ where: { empNo: 'admin' } })).id,
        categoryId: catMap.get('公司公告'),
        pinned: 2,
        featured: true,
      });
      const t = await Tag.findOne({ where: { name: 'AI' } });
      if (t) await PostTag.create({ postId: post1.id, tagId: t.id });

      const post2 = await Post.create({
        title: 'Vue3 在大型项目中的实践经验',
        content: '<p>Composition API、Pinia、SSR 等关键经验梳理。</p><ul><li>状态管理</li><li>路由按需加载</li></ul>',
        summary: 'Vue3 在大型项目中的实践经验。',
        authorId: sampleAuthor.id,
        categoryId: catMap.get('React/Vue'),
        likeCount: 10,
        viewCount: 88,
      });
      const t2 = await Tag.findOne({ where: { name: 'Vue' } });
      if (t2) await PostTag.create({ postId: post2.id, tagId: t2.id });
    }
  }

  console.log('Seed 完成。账号：');
  console.log('  admin / admin123 (超级管理员)');
  console.log('  mod001 / mod123 (版主)');
  console.log('  user001 / user123 (普通用户)');
  console.log('  user002 / user123 (普通用户)');
  await db.sequelize.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
