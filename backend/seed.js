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

  // 示例帖子（幂等：按 title 查重，不存在则创建）
  const sampleAuthor = await User.findOne({ where: { empNo: 'user001' } });
  const adminUser = await User.findOne({ where: { empNo: 'admin' } });
  const modUser = await User.findOne({ where: { empNo: 'mod001' } });
  const user002 = await User.findOne({ where: { empNo: 'user002' } });

  if (sampleAuthor && adminUser && modUser && user002) {
    const samplePosts = [
      // ---- 公告帖 ----
      {
        title: '欢迎来到企业技术交流社区',
        content: '<h2>欢迎</h2><p>在这里分享你的技术心得，提问交流。社区支持 AI 智能问答、帖子解读、写作助手等能力，帮助大家更高效地沉淀与消费技术知识。</p><pre><code class="language-js">console.log("hello community");</code></pre>',
        summary: '欢迎新人帖：分享技术心得，提问交流，体验 AI 辅助功能。',
        authorId: adminUser.id,
        categoryId: catMap.get('公司公告'),
        pinned: 2,
        featured: true,
        viewCount: 256,
        likeCount: 18,
        commentCount: 0,
        tagNames: ['AI'],
      },
      // ---- 前端帖子 ----
      {
        title: 'Vue3 Composition API 在大型项目中的实践经验',
        content: '<h3>背景</h3><p>我们团队从 Vue2 Options API 迁移到 Vue3 Composition API，过程中踩了不少坑。</p><h3>核心收获</h3><ul><li>状态管理：Pinia 替代 Vuex，类型推断更友好</li><li>路由按需加载：结合 defineAsyncComponent 减小首屏包体积 40%</li><li>SSR：Nuxt3 的 server component 大幅减少 hydration 开销</li></ul><h3>建议</h3><p>如果你的项目超过 50 个页面，强烈建议一步到位用 Composition API + Pinia。</p>',
        summary: 'Vue3 Composition API + Pinia + SSR 的大型项目迁移经验总结。',
        authorId: modUser.id,
        categoryId: catMap.get('React/Vue'),
        likeCount: 24,
        viewCount: 312,
        commentCount: 0,
        featured: true,
        tagNames: ['Vue'],
      },
      {
        title: 'React 18 useMemo 与 useCallback 的正确使用姿势',
        content: '<p>很多同学滥用 useMemo 和 useCallback，实际上大多数场景不需要。本文总结什么时候该用、什么时候不该用。</p><h3>不该用的场景</h3><ul><li>简单计算（如字符串拼接）</li><li>组件本身已经很轻量</li></ul><h3>该用的场景</h3><ul><li>大列表渲染时的 filter/sort 计算</li><li>传给 React.memo 包裹的子组件的回调</li><li>作为 useEffect 依赖项的对象/函数</li></ul><pre><code class="language-jsx">const filtered = useMemo(() => items.filter(i => i.active), [items]);</code></pre>',
        summary: 'React 18 中 useMemo/useCallback 的使用场景与反模式分析。',
        authorId: sampleAuthor.id,
        categoryId: catMap.get('React/Vue'),
        likeCount: 32,
        viewCount: 445,
        commentCount: 0,
        tagNames: ['React', '性能优化'],
      },
      // ---- 后端帖子 ----
      {
        title: 'Node.js 连接池优化实战：从 100ms 到 5ms',
        content: '<p>线上接口 P99 从 100ms 降到 5ms 的完整优化路径。</p><h3>问题排查</h3><p>通过 APM 发现 90% 的时间花在等待数据库连接上，Sequelize 默认连接池只有 5 个连接。</p><h3>解决方案</h3><ol><li>连接池扩容：max=20, min=5, idle=10000</li><li>慢查询日志：记录 >50ms 的查询</li><li>读写分离：读请求走从库</li></ol><pre><code class="language-js">const sequelize = new Sequelize(db, user, pass, {\n  pool: { max: 20, min: 5, idle: 10000 }\n});</code></pre><p>优化后 P99 稳定在 5ms 以内。</p>',
        summary: 'Sequelize 连接池调优，P99 从 100ms 降到 5ms 的实战经验。',
        authorId: sampleAuthor.id,
        categoryId: catMap.get('Node.js'),
        likeCount: 45,
        viewCount: 678,
        commentCount: 0,
        featured: true,
        pinned: 1,
        tagNames: ['Node.js', '性能优化'],
      },
      {
        title: 'Spring Boot 微服务拆分的 7 个原则',
        content: '<p>公司后端从单体迁移到微服务架构，总结出 7 个实用原则：</p><ol><li>按业务域拆分，不按技术层拆分</li><li>每个服务独立数据库（Database per Service）</li><li>服务间通信优先用异步消息队列</li><li>统一 API 网关做鉴权和限流</li><li>分布式事务用 Saga 模式</li><li>每个服务必须有健康检查接口</li><li>灰度发布 + 熔断降级是标配</li></ol><p>以上是我们踩了半年坑后总结的，希望能帮到大家。</p>',
        summary: '从单体到微服务的 7 个拆分原则，来自半年实战经验。',
        authorId: sampleAuthor.id,
        categoryId: catMap.get('Java/Spring'),
        likeCount: 38,
        viewCount: 520,
        commentCount: 0,
        tagNames: ['微服务'],
      },
      {
        title: 'MySQL 慢查询排查与索引优化指南',
        content: '<p>本文整理了我在排查线上慢查询时用到的工具和方法论。</p><h3>排查工具链</h3><ul><li>EXPLAIN ANALYZE：看执行计划</li><li>slow_query_log：开启慢查询日志</li><li>pt-query-digest：聚合分析慢查询</li></ul><h3>常见优化手段</h3><ul><li>覆盖索引避免回表</li><li>联合索引遵循最左匹配</li><li>避免 SELECT * ，只查需要的列</li><li>分页深度优化：用游标代替 OFFSET</li></ul><pre><code class="language-sql">-- 优化前\nSELECT * FROM posts ORDER BY id LIMIT 10000, 20;\n-- 优化后\nSELECT * FROM posts WHERE id > 10000 ORDER BY id LIMIT 20;</code></pre>',
        summary: 'MySQL 慢查询排查工具链与索引优化实战指南。',
        authorId: modUser.id,
        categoryId: catMap.get('Java/Spring'),
        likeCount: 29,
        viewCount: 390,
        commentCount: 0,
        tagNames: [],
      },
      // ---- 测试与运维帖子 ----
      {
        title: '前端自动化测试从 0 到 1：Jest + Testing Library 实战',
        content: '<p>很多团队前端没有测试，本文分享我们如何从零搭建前端测试体系。</p><h3>技术选型</h3><ul><li>单元测试：Jest + React Testing Library</li><li>组件测试：Storybook + Chromatic</li><li>E2E：Playwright</li></ul><h3>收益</h3><p>上线后 bug 率降低 60%，重构信心大增。关键是先从最核心的业务逻辑开始写测试，不要追求覆盖率 100%。</p>',
        summary: '前端自动化测试体系搭建经验：Jest + Testing Library + Playwright。',
        authorId: user002.id,
        categoryId: catMap.get('自动化测试'),
        likeCount: 21,
        viewCount: 267,
        commentCount: 0,
        tagNames: [],
      },
      {
        title: 'Docker Compose 一键部署最佳实践',
        content: '<p>用 Docker Compose 管理本地开发和生产部署的经验分享。</p><h3>核心要点</h3><ul><li>开发环境用 docker-compose.yml，生产用 docker-compose.prod.yml</li><li>环境变量通过 .env 注入，不硬编码</li><li>volume 持久化数据库和上传文件</li><li>healthcheck 配合 depends_on 确保启动顺序</li><li>多阶段构建减小镜像体积</li></ul><pre><code class="language-yaml">services:\n  backend:\n    build: ./backend\n    healthcheck:\n      test: curl -fs http://localhost:4000/health\n      interval: 10s</code></pre>',
        summary: 'Docker Compose 开发到生产的部署最佳实践与 healthcheck 配置。',
        authorId: sampleAuthor.id,
        categoryId: catMap.get('DevOps'),
        likeCount: 33,
        viewCount: 410,
        commentCount: 0,
        tagNames: ['CI/CD'],
      },
      {
        title: 'AI 辅助代码审查的实践与思考',
        content: '<p>我们团队尝试用 AI 辅助 Code Review，总结如下。</p><h3>适合 AI 审查的</h3><ul><li>代码风格一致性</li><li>潜在的空指针 / 未处理的异常</li><li>安全漏洞（SQL 注入、XSS）</li><li>性能反模式（如 N+1 查询）</li></ul><h3>不适合 AI 审查的</h3><ul><li>业务逻辑正确性（需要领域知识）</li><li>架构设计决策</li><li>代码可读性的主观判断</li></ul><p>结论：AI 审查适合做"兜底检查"，不能替代人工 Review。</p>',
        summary: 'AI 辅助 Code Review 的适用场景与局限性分析。',
        authorId: adminUser.id,
        categoryId: catMap.get('前端开发'),
        likeCount: 27,
        viewCount: 345,
        commentCount: 0,
        tagNames: ['AI'],
      },
      {
        title: '技术面试准备清单：后端方向',
        content: '<p>整理了后端面试高频考点，供大家参考。</p><h3>数据结构与算法</h3><ul><li>链表、树、图的基本操作</li><li>排序算法时间复杂度对比</li><li>动态规划入门题</li></ul><h3>系统设计</h3><ul><li>短链接系统</li><li>消息队列设计</li><li>分布式缓存一致性</li></ul><h3>项目经验</h3><ul><li>STAR 法则讲故事</li><li>量化成果（如 P99 从 x 降到 y）</li></ul>',
        summary: '后端面试高频考点清单：算法 + 系统设计 + 项目经验。',
        authorId: sampleAuthor.id,
        categoryId: catMap.get('后端开发'),
        likeCount: 55,
        viewCount: 890,
        commentCount: 0,
        featured: true,
        tagNames: ['面试'],
      },
      {
        title: 'Webpack 5 到 Vite 迁移踩坑记录',
        content: '<p>项目从 Webpack 5 迁移到 Vite，开发启动从 40s 降到 2s，但过程中遇到不少兼容性问题。</p><h3>主要问题</h3><ol><li>CommonJS 模块不兼容：需要用 vite-plugin-commonjs</li><li>环境变量前缀变化：REACT_APP_ → VITE_</li><li>CSS Modules 配置差异</li><li>monaco-editor worker 加载方式变化</li></ol><h3>迁移收益</h3><ul><li>dev 启动：40s → 2s</li><li>HMR：2s → 50ms</li><li>build：60s → 15s</li></ul>',
        summary: 'Webpack 5 到 Vite 迁移的兼容性问题与性能收益对比。',
        authorId: modUser.id,
        categoryId: catMap.get('工程化'),
        likeCount: 19,
        viewCount: 230,
        commentCount: 0,
        tagNames: [],
      },
      {
        title: 'Go 语言 goroutine 泄漏排查实战',
        content: '<p>线上服务内存持续增长，最终定位到 goroutine 泄漏。</p><h3>排查工具</h3><ul><li>pprof：/debug/pprof/goroutine</li><li>runtime.NumGoroutine() 监控</li></ul><h3>常见泄漏模式</h3><ul><li>channel 无 consumer 导致 producer 阻塞</li><li>HTTP client 未设置超时</li><li>context 未正确传递 cancel</li></ul><pre><code class="language-go">ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)\ndefer cancel()</code></pre>',
        summary: 'Go goroutine 泄漏的排查工具与常见模式。',
        authorId: user002.id,
        categoryId: catMap.get('Go'),
        likeCount: 16,
        viewCount: 180,
        commentCount: 0,
        tagNames: [],
      },
    ];

    let createdCount = 0;
    let skippedCount = 0;
    for (const data of samplePosts) {
      const { title, tagNames, ...defaults } = data;
      const [post, created] = await Post.findOrCreate({
        where: { title },
        defaults: { title, ...defaults },
      });
      if (created) createdCount++;
      else skippedCount++;

      // 同步 PostTag（已存在则跳过）
      for (const tagName of (tagNames || [])) {
        const t = await Tag.findOne({ where: { name: tagName } });
        if (t) {
          await PostTag.findOrCreate({
            where: { postId: post.id, tagId: t.id },
            defaults: { postId: post.id, tagId: t.id },
          });
        }
      }
    }
    console.log(`  帖子：新增 ${createdCount} 篇，已存在跳过 ${skippedCount} 篇`);
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
