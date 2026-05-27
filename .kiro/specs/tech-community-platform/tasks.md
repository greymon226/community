# Implementation Plan: Community_Platform 技术交流分享社区

## Overview

本计划基于 [requirements.md](./requirements.md)（27 项需求）与 [design.md](./design.md)（36 条 Correctness Properties）拆解实现路径。技术栈为 Node.js + Express + Sequelize + Redis + JWT + React 18，与既有代码（`backend/src`、`frontend/src`）对齐。

由于需求与设计是从既有代码反推得到，实现路径采用"分层对齐 + 测试补全"模式：

- 每个模块按 `功能对齐 → 属性测试 → 单元/集成测试` 展开
- 必做任务实现/对齐核心业务逻辑、错误码、审计落点
- 可选任务（带 `*` 后缀）覆盖 36 条 Correctness Properties 与单元/集成回归
- 属性测试使用 `fast-check`（每条 ≥ 100 次迭代），位于 `backend/tests/property/`

每个属性测试文件命名为 `PXX-<short-name>.test.js`，顶部注释必须引用所对应的 Property 编号与设计文档章节。

## Tasks

- [x] 1. 测试基础设施
  - [x] 1.1 安装属性测试依赖与脚本
    - 在 `backend/package.json` devDependencies 添加 `fast-check`、`ioredis-mock`、`sqlite3`
    - 添加脚本：`test:unit`（`node --test tests/unit/**/*.test.js`）、`test:property`（`node --test tests/property/**/*.test.js`）、`test:e2e`（保留既有 `tests/run-all.js`）
    - 创建目录 `backend/tests/unit/`、`backend/tests/property/` 与各自 README 命名规范
    - _Requirements: 27.1_

  - [x] 1.2 实现属性测试公共脚手架
    - 创建 `backend/tests/property/_setup.js`：sqlite 内存 Sequelize 实例、表截断 helper、AI mock 服务器注入、`Cache_Service` Redis-mock 切换
    - 创建 `backend/tests/property/_arbitraries.js`：合法用户、合法帖子、富文本、敏感文本、SSE 帧序列等常用 fast-check 生成器
    - _Requirements: 27.1_

  - [x]* 1.3 编写纯函数单元测试
    - 覆盖 `cleanPlainText` / `cleanRichText`（≥ 20 条 XSS 注入向量）、`searchService.tokenize / extractSnippet` 中英文分词、`aiService.safeParseJSON` markdown 包裹容错
    - _Requirements: 5.2, 5.3, 8.5_

- [x] 2. 统一响应包络与全局错误处理
  - [x] 2.1 对齐 `utils/response.js` 与 `middlewares/error.js`
    - 校验响应体形如 `{ code, message, data }`；成功 `code = 0`
    - 已知业务错误保留 `code/status`；未知错误返回 500、不暴露堆栈（仅 `NODE_ENV !== 'production'` 时附 `data.stack`）
    - 请求体过大兜底为 `{ code: 1, message: '请求体过大' }`
    - _Requirements: 23.9, 27.4_

  - [x] 2.2 对齐安全头、CORS 与速率限制
    - `helmet()` 启用 nosniff/HSTS/frameguard 等
    - `cors({ origin: process.env.CORS_ORIGIN || true, credentials: true })`
    - `express-rate-limit`：默认每 IP 每分钟 600 次，超出 429
    - `express.json({ limit: '5mb' })`
    - _Requirements: 23.6, 23.8, 23.9_

  - [x]* 2.3 属性测试 P36：统一响应包络
    - **Property 36: 统一响应包络**
    - **Validates: Requirements 27.4**

  - [ ]* 2.4 属性测试 P05：入参校验先于副作用
    - **Property 5: 入参校验必须先于副作用**
    - **Validates: Requirements 1.3, 2.7, 2.8, 2.9, 3.3, 3.4, 3.5, 4.3, 4.4, 5.1, 5.7, 5.8, 6.1, 6.2, 13.1, 21.3, 21.8**

- [x] 3. Auth_Service 与权限助手
  - [x] 3.1 对齐 JWT 鉴权中间件
    - `authRequired`：缺失 / 非 Bearer / 解析失败 / 用户不存在 / 用户不可用 → 401 + `code = 401`
    - `authOptional`：解析失败放行并将 `req.user = null`
    - `requireRole(...allowed)`：白名单不通过 → 403 + `code = 403`
    - _Requirements: 1.9, 1.10, 1.11, 2.6, 23.5_

  - [x] 3.2 对齐密码登录与 CAS 回调
    - `POST /api/auth/login` 入参校验、反枚举一致 401、签发 7 天 JWT、返回 user 不含 `passwordHash`
    - `GET /api/auth/cas/callback` ticket 校验、profile 同步本地用户、缺 ticket → 400、校验失败 → 401
    - `GET /api/auth/cas/login-url` 在 Mock 与真实模式分别返回 `{ mock, url }`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

  - [x] 3.3 对齐 `GET /api/auth/me` 与 `POST /api/auth/logout`
    - `me` 返回去敏 user；`logout` 返回成功响应供前端清 token
    - _Requirements: 1.12, 1.13_

  - [x] 3.4 对齐 `canModerateCategory(user, categoryId)` 助手
    - admin 永真；moderator 仅 `moderatorCategoryIds.includes(categoryId)`；其他返回 false
    - 在所有版主/管理员动作 controller 入口强制调用，禁止任何分支跳过
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 4.7, 5.8, 8.11, 14.6_

  - [ ]* 3.5 属性测试 P02：受保护接口 401 一致性
    - **Property 2: 受保护接口对所有伪造 / 过期 token 一致返回 401**
    - **Validates: Requirements 1.9, 1.10, 1.11, 23.5**

  - [-]* 3.6 属性测试 P03：角色权限矩阵作为纯函数
    - **Property 3: 角色权限矩阵作为纯函数**
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.6, 4.7, 5.8, 8.11, 14.6**

  - [ ]* 3.7 属性测试 P04：登录失败反枚举一致性
    - **Property 4: 登录失败的反枚举一致性**
    - **Validates: Requirements 1.4**

  - [ ]* 3.8 属性测试 P31：受保护路由必须 JWT 鉴权
    - **Property 31: 受保护路由必须 JWT 鉴权**
    - **Validates: Requirements 23.5**

- [x] 4. 输入清洗工具（sanitize-html）
  - [x] 4.1 对齐 `cleanPlainText` 与 `cleanRichText`
    - `cleanPlainText` 剥离 HTML 标签与控制字符
    - `cleanRichText` 使用 `sanitize-html` 白名单：标签 `p,br,strong,em,u,s,blockquote,ul,ol,li,h1-h4,code,pre,a,img,table,thead,tbody,tr,th,td`；属性 `a[href|target|rel]`、`img[src|alt|width|height|loading]`；URL 仅放行 `http(s) / data:image / /uploads/*`
    - 全部移除 `<script>` / `on*=` 事件 / `javascript:` 协议
    - _Requirements: 3.5, 5.2, 5.3, 8.5, 23.6_

  - [x]* 4.2 属性测试 P06：清洗不可绕过
    - **Property 6: 富文本 / 纯文本清洗不可绕过**
    - **Validates: Requirements 3.5, 5.2, 5.3, 8.5, 23.6**

- [x] 5. 用户资料与个人中心
  - [x] 5.1 对齐 `GET /api/users/:id` 资料聚合
    - 仅返回 `status='active'` 用户；聚合 `stats.postCount(published) / likeReceived / favoriteCount`
    - 序列化排除 `passwordHash`；不存在或被禁用 → 404
    - _Requirements: 3.1, 3.2_

  - [x] 5.2 对齐 `PUT /api/users/me` 资料更新
    - 白名单字段 `nickname / bio / techTags / avatar / emailNotify`，未列出字段忽略
    - 长度/数量校验先于持久化；保存前对 `nickname / bio / techTags 元素` 调用 `cleanPlainText`
    - `techTags` 归一化：去重 + ≤ 20 项 + 单项 ≤ 32 字
    - _Requirements: 3.3, 3.4, 3.5_

  - [x] 5.3 对齐 `GET /api/users/me/posts | favorites | comments`
    - posts 支持 `status ∈ {draft,published,blocked,all}`、`page ≥ 1`、`pageSize ∈ [1,50]`；非法 status → 400
    - favorites 仅 published 帖子，按 `Favorite.createdAt DESC`
    - comments 仅非 deleted、按 `createdAt DESC`、最多 100 条，附帖子 `{ id, title }`
    - _Requirements: 3.6, 3.7, 3.8, 3.9, 3.10_

  - [x]* 5.4 属性测试 P07：techTags 归一化不变量
    - **Property 7: techTags 归一化不变量**
    - **Validates: Requirements 3.3, 3.5**

  - [-]* 5.5 属性测试 P01：响应不泄漏 passwordHash
    - **Property 1: 任意接口响应都不泄漏 passwordHash**
    - **Validates: Requirements 1.5, 1.12, 22.3**

- [x] 6. Category 板块管理
  - [x] 6.1 对齐 `GET /api/categories` 树状返回
    - 仅 `enabled = true`，按 `sort ASC, id ASC`
    - 最多两级（一级 `parentId = null`，二级 children 固定空数组）
    - `visibility` 为空对象/空字符串/null 时对所有用户可见
    - _Requirements: 4.1, 4.2, 4.6_

  - [x] 6.2 对齐 `/api/admin/categories` CRUD
    - admin only；POST/PUT 字段白名单与长度校验
    - `parentId` 校验：等于自身 / 不存在 / 指向二级 → 400
    - DELETE 前校验"无子板块且无非 deleted 帖子"
    - 全部成功后写 AuditLog（`category.create / update / delete`）
    - _Requirements: 4.3, 4.4, 4.5, 4.7, 4.8, 4.9_

  - [x]* 6.3 属性测试 P09：分类树最多两级
    - **Property 9: 分类树最多两级**
    - **Validates: Requirements 4.1, 4.2, 4.6, 4.8**

- [x] 7. Post_Service 创建、编辑、删除
  - [x] 7.1 对齐 `POST /api/posts` 创建流程
    - 入参校验（title/content/categoryId 必填）→ `cleanPlainText(title)` 截断 200 → `cleanRichText(content)`
    - 自动生成 `summary`；`status = 'draft'` 跳过 AI 审核
    - 命中敏感词 block → 4001/400；写 AuditLog（`post.create`）
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 11.7_

  - [x] 7.2 对齐 `PUT /api/posts/:id` 编辑流程
    - 仅作者或 admin（其他 → 403）；切换至 `published` 且 title/content 变更触发重新 AI 审核
    - 写 AuditLog（`post.update`）
    - _Requirements: 5.7, 5.8, 5.9_

  - [x] 7.3 对齐 `DELETE /api/posts/:id` 软删除
    - 作者或 admin → `status = 'deleted'`；写 AuditLog（`post.delete`）
    - _Requirements: 5.10_

  - [x] 7.4 对齐 `GET /api/posts/:id` 详情与可见性
    - `deleted` → 404；`blocked` 且非作者非 admin → 403
    - 返回 `author / category / tags`；异步 `increment(viewCount)` 不阻塞
    - 已登录附加 `liked / favorited` 当前用户视角
    - _Requirements: 5.11, 5.12, 5.13, 5.14_

  - [x] 7.5 对齐标签处理
    - 单帖最多 10 标签，单标签 `cleanPlainText` 后 ≤ 32 字、过滤空串、去重
    - 不存在的 Tag 自动创建；变更时删除旧 PostTag 并对每个 Tag `increment('usageCount')`
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x]* 7.6 属性测试 P08：帖子标签集合不变量
    - **Property 8: 帖子标签集合不变量**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

  - [x]* 7.7 属性测试 P10：帖子可见性谓词
    - **Property 10: 帖子可见性谓词**
    - **Validates: Requirements 5.11, 5.12, 17.2, 17.3**

- [x] 8. Search_Service 列表、搜索与排序
  - [x] 8.1 对齐 `searchPosts`
    - 仅 `status = 'published'`；keyword 在 `title / content / summary` 上 OR LIKE
    - sort: `latest` (`pinned DESC, createdAt DESC`) / `hot` (`pinned DESC, likeCount DESC, viewCount DESC`) / `comments` (`pinned DESC, commentCount DESC`) / `featured` (`featured DESC, createdAt DESC`)
    - `pageSize` 上限 50；返回 `{ items, total, page, pageSize }`，items 含 `author / category / tags`
    - `tag` 过滤通过 `Tag.name` 关联 `required = true`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9_

  - [ ]* 8.2 属性测试 P11：搜索 / 排序 / 分页不变量
    - **Property 11: 搜索 / 排序 / 分页不变量**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9**

  - [ ]* 8.3 属性测试 P32：SQL 注入安全
    - **Property 32: SQL 注入安全**
    - **Validates: Requirements 23.7**

- [x] 9. Search_Service RAG 召回
  - [x] 9.1 实现/对齐 `searchForRAG`
    - 中英文分词 + 停用词（≤1 字符英文/数字/纯空白）过滤
    - 多关键词在 `title / content / summary` OR LIKE 召回 published 帖子
    - 评分：`title 命中 × 5 + min(content 命中次数, 5) + log10(1 + likeCount + commentCount)`
    - `topN = clamp(req.topN, 3, 8)`，默认 5
    - _Requirements: 18.5, 18.6_

  - [ ]* 9.2 属性测试 P12：RAG 召回不变量
    - **Property 12: RAG 召回不变量**
    - **Validates: Requirements 18.5, 18.6**

- [x] 10. Comment_Service 评论与引用回复
  - [x] 10.1 对齐 `GET /api/posts/:postId/comments`
    - DB 层 `where: { status: { [Op.ne]: 'deleted' } }` 优先过滤
    - 再做 `replyTo`（含原作者昵称）关联与点赞状态拼装；按 `createdAt ASC`
    - 已登录附 `liked` 当前用户视角
    - _Requirements: 8.1, 8.2_

  - [x] 10.2 对齐 `POST /api/posts/:postId/comments`
    - 帖子非 published → "帖子不可评论"
    - `cleanRichText` → Moderation_Service → AI_Audit
    - block → 4001/400；blocked → 4002/400；review → 创建并 `status = 'blocked'` + `pending = true`
    - 创建成功（非 review）：`commentCount++`、通知作者（`commented`），有 replyToId 则同时通知被引用者（`replied`）
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 11.7, 12.11_

  - [x] 10.3 对齐 `DELETE /api/comments/:id` 与点赞切换
    - 作者或可管理板块的版主 / admin → 软删 + `commentCount--`；其他 → 403
    - `POST /api/comments/:id/like` 切换 + 同步 `Comment.likeCount`，响应返回最新 `liked / likeCount`
    - _Requirements: 8.10, 8.11, 8.12_

  - [ ]* 10.4 属性测试 P18：commentCount 不变量
    - **Property 18: commentCount 不变量**
    - **Validates: Requirements 8.7, 8.8, 8.9, 8.10**

- [x] 11. Interaction_Service 点赞 / 收藏 / 分享
  - [x] 11.1 对齐 Like / Favorite 切换语义
    - `Like` 多态（postId 或 commentId 二选一非空）+ UNIQUE 复合索引保证幂等
    - 切换：`findOrCreate + destroy` 或事务内 `increment / decrement`，同步 `Post.likeCount / Post.favoriteCount`
    - 不存在的目标 → 404
    - _Requirements: 9.1, 9.3, 9.5_

  - [x] 11.2 对齐"未赞 → 已赞"通知触发
    - 仅在切换为已赞时 `notify('liked')`；自赞不发通知
    - _Requirements: 9.2_

  - [x] 11.3 对齐前端"复制链接"分享按钮
    - 帖子详情页提供按钮，调用 `navigator.clipboard.writeText`
    - _Requirements: 9.4_

  - [ ]* 11.4 属性测试 P16：点赞 / 收藏切换计数一致性
    - **Property 16: 点赞 / 收藏切换的计数一致性**
    - **Validates: Requirements 8.12, 9.1, 9.3**

  - [ ]* 11.5 属性测试 P17：仅"未赞→已赞"产生通知
    - **Property 17: 仅"未赞 → 已赞"产生通知**
    - **Validates: Requirements 9.2**

- [x] 12. 文件上传
  - [x] 12.1 对齐 `POST /api/upload` 与静态路由
    - `multer.diskStorage` + 扩展名白名单 `{.png,.jpg,.jpeg,.gif,.webp,.svg}` + `MAX_UPLOAD_MB`（默认 10）
    - 双重校验：扩展名 + 大小，任一失败 → 4xx 不返回成功响应
    - 成功响应 `{ url: '/uploads/<ts>-<uuid><ext>', originalName, size }`
    - 启用 `/uploads/*` 静态路由对外提供文件
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 23.10_

  - [-]* 12.2 属性测试 P33：文件上传双重校验
    - **Property 33: 文件上传双重校验**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 23.10**

- [x] 13. Cache_Service Redis / 内存降级
  - [x] 13.1 对齐 `Cache_Service` 接口与降级
    - `get / set / del / incr` 统一接口
    - `REDIS_URL` 已配置且连接成功 → Redis；否则 → 内存 `Map + setTimeout` 模拟 TTL
    - 切换对调用方透明
    - 配额键 `ai:<feature>:quota:<userId>:<YYYY-MM-DD>` TTL 24h
    - 解读缓存键 `ai:explain:post:<postId>:<updatedAtTs>` TTL 24h
    - 问答缓存键 `ai:ask:<sha1(question.toLowerCase()).slice(0,16)>` TTL 1h
    - _Requirements: 25.1, 25.2_

  - [-]* 13.2 属性测试 P29：缓存后端的可替换性
    - **Property 29: 缓存后端的可替换性**
    - **Validates: Requirements 25.1, 25.2**

- [x] 14. Moderation_Service 敏感词
  - [x] 14.1 实现/对齐敏感词加载与策略执行
    - 进程内 `Map<word, strategy>` 缓存；首次调用合并 `SensitiveWord` 表 + `.env SENSITIVE_WORDS` 兜底
    - mask: 等长 `*` 替换；block: `blocked = true`；review: `needReview = true`，二者独立
    - 未命中：`{ cleanText: 原文, hits: [], blocked: false, needReview: false }`
    - 输出形态固定：`{ cleanText, hits: [{ word, strategy }], blocked, needReview }`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [x] 14.2 对齐敏感词管理接口的缓存失效
    - `POST /api/admin/sensitive-words` 与 `DELETE /api/admin/sensitive-words/:id` 调用 `Moderation_Service.invalidate()`
    - _Requirements: 11.8_

  - [-]* 14.3 属性测试 P13：敏感词策略语义
    - **Property 13: 敏感词策略语义**
    - **Validates: Requirements 11.2, 11.3, 11.4, 11.5, 11.6**

  - [ ]* 14.4 属性测试 P14：敏感词缓存与库表的最终一致性
    - **Property 14: 敏感词缓存与库表的最终一致性**
    - **Validates: Requirements 11.8**

- [x] 15. AI_Service 审核（auditContent）与降级
  - [x] 15.1 实现/对齐 `auditContent`
    - DeepSeek 调用 `POST {AI_BASE_URL}/v1/chat/completions`，固定 `response_format = json_object`、`temperature = 0`
    - `AbortController + AI_TIMEOUT_MS`（默认 15000ms）
    - 解析 `{ status, reason, categories }`，非法 JSON 兜底为 `review`
    - 异常 / 超时 / 非法 JSON → 降级 `RISK_KEYWORDS` 本地规则，永远返回合法 `{ status, reason }`
    - _Requirements: 12.7, 12.8, 12.9, 12.10, 23.11, 25.3_

  - [x] 15.2 对齐帖子审核状态映射
    - `aiAuditEnabled = false` → 跳过 LLM、`aiAuditStatus = 'skipped'`、`aiAuditReason = 'AI 审核已关闭'`
    - status='draft' → 跳过 LLM、不写 `aiAuditStatus`
    - pass → published + `aiAuditStatus = 'pass'`
    - review → blocked + `aiAuditStatus = 'review'` + 响应 `pending = true`
    - blocked → 400/4002 + 写 AuditLog（`post.rejected_by_ai`）+ 不持久化
    - _Requirements: 5.6, 5.9, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.11_

  - [ ]* 15.3 属性测试 P15：AI 审核状态映射
    - **Property 15: AI 审核状态映射**
    - **Validates: Requirements 5.6, 5.9, 8.7, 8.8, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.11**

  - [ ]* 15.4 属性测试 P30：AI 失败的稳定降级
    - **Property 30: AI 失败的稳定降级**
    - **Validates: Requirements 12.9, 12.10, 25.3, 25.4, 19.7**

- [x] 16. Notification_Service 消息中心
  - [x] 16.1 实现/对齐通知写入与读取
    - 6 种 type：`commented / replied / liked / featured / pinned / system`
    - `GET /api/notifications` 按 `createdAt DESC` 分页 + `unreadCount`
    - `unreadOnly = '1' | 'true'` 过滤；`POST /api/notifications/read` 不带 ids → 全部已读，带 ids → 仅命中本人
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [x] 16.2 对齐前端轮询与未读红点
    - 页面挂载即查一次（不等待首轮），其后每 30 秒轮询 `unreadOnly = 1`
    - `emailNotify` 仅持久化偏好，不在本期发送邮件
    - _Requirements: 15.7, 15.8_

  - [ ]* 16.3 属性测试 P19：通知列表 / 已读语义
    - **Property 19: 通知列表 / 已读语义**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6**

- [x] 17. AI 智能推荐
  - [x] 17.1 对齐 `GET /api/posts/recommend`
    - 用户 `techTags` 与 `Tag` 表交集匹配
    - 命中 → 相关 published 帖子最多 10 条，按 `likeCount DESC, createdAt DESC`
    - 未命中或 techTags 为空 → 退化为热门帖子（同排序，最多 10 条）
    - _Requirements: 16.1, 16.2, 16.3_

  - [ ]* 17.2 属性测试 P20：推荐结果不变量
    - **Property 20: 推荐结果不变量**
    - **Validates: Requirements 16.1, 16.2, 16.3**

- [ ] 18. Checkpoint - 阶段一回归
  - 校验 auth / user / category / post / comment / interaction / upload / cache / moderation / audit / notification / recommend 全部对齐完成
  - Ensure all tests pass, ask the user if questions arise.

- [x] 19. AI 帖子解读（explainPost）
  - [x] 19.1 对齐 `GET /api/posts/:id/explain`
    - 开关检查（4003）；可见性检查（404 / 403）
    - 缓存键 `ai:explain:post:<postId>:<updatedAtTs>` TTL 24h；命中 → `cached = true` + 不消耗配额
    - 未命中且 `aiExplainPerUserDailyLimit > 0` 且当日已用 ≥ 上限 → 429/4004
    - 调用失败 → 502/5001 + 中文原因
    - 成功 → 写缓存 + 配额 `+1`，返回 `{ summary, keyPoints[3-6], suggestions[0-4], questions[0-4], model, usage, elapsedMs }`
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9_

  - [ ]* 19.2 属性测试 P21：AI 解读缓存键完整性
    - **Property 21: AI 解读缓存键完整性**
    - **Validates: Requirements 17.4, 17.5, 17.9**

- [x] 20. AI 站内问答（非流式 askWithRAG）
  - [x] 20.1 对齐 `POST /api/ai/ask`
    - 开关 4003；入参校验 400；敏感词 block 4001；配额 4004
    - 通过 `searchForRAG` 召回；空召回 → 引导文案 + 不调模型 + 不计配额（`hasAnswer = false, citations = [], candidates = []`）
    - 召回非空 → 调 LLM，上下文为 `[n] 帖子#id 《标题》` 头 + 元 + 正文片段 ≤ 800 字
    - 缓存键 `ai:ask:<sha1(question.toLowerCase()).slice(0,16)>` TTL 1h；命中 → `cached = true` + 不计配额
    - 失败 → 502/5001
    - 返回 `{ question, answer, hasAnswer, citations, candidates, model, elapsedMs, usage, cached, quotaUsed, quotaLimit }`
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.7, 18.8, 18.10, 18.11, 18.12_

  - [x] 20.2 实现引用编号解析与映射
    - 正则 `\[(\d{1,2})\]` 抽取；保留 `1 ≤ n ≤ candidates.length`；按首次出现去重；映射到 `candidates[n-1].id`
    - 同时按"真实帖子 id"与"上下文编号 n"两种语义解析并去重
    - `citations` 顺序与 `citedSourceIds` 保持一致
    - _Requirements: 18.9, 19.6_

  - [x] 20.3 前端：站内无相关帖子的引导
    - 把当前 question 预填到发帖标题，引导用户去对应板块发帖
    - _Requirements: 18.13_

  - [ ]* 20.4 属性测试 P22：AI 问答缓存键完整性
    - **Property 22: AI 问答缓存键完整性**
    - **Validates: Requirements 18.10**

  - [x]* 20.5 属性测试 P23：引用编号解析的纯函数性
    - **Property 23: 引用编号解析的纯函数性**
    - **Validates: Requirements 18.9, 19.6**

- [x] 21. AI 站内问答 - SSE 流式
  - [x] 21.1 对齐 `POST /api/ai/ask/stream` 握手与前置检查
    - 前置（鉴权 / 入参 / 开关 / 敏感词 / 配额）任一不通过 → 直接 HTTP 错误（400 / 403/4003 / 400/4001 / 429/4004），不发任何 SSE 帧、不计配额
    - 通过 → HTTP 200 + 头 `Content-Type: text/event-stream; charset=utf-8` / `Cache-Control: no-cache, no-transform` / `Connection: keep-alive` / `X-Accel-Buffering: no`
    - 帧格式 `data: <json>\n\n`
    - _Requirements: 19.1, 19.2_

  - [x] 21.2 实现帧序列输出 (meta / delta / done / error)
    - 第一帧 `meta`：`{ question, candidates, quotaUsed, quotaLimit }`，必先于其他帧
    - 模型 token 增量 → 0 至多帧 `delta`：`{ text }`
    - 正常完成 → 一帧 `done`：`{ hasAnswer, citations, usage, full }`，立即关闭连接
    - 异常 → 一帧 `error`：`{ message ≤ 500 字、不含堆栈/密钥/上游 URL }`，立即关闭；error 后不发任何帧
    - _Requirements: 19.3, 19.4, 19.5, 19.7_

  - [x] 21.3 实现召回为空的固定降级帧序列
    - 顺序：`meta(candidates=[])` → `delta(引导文案 ≤ 200 字)` → `done(hasAnswer=false, citations=[], usage={}, full=同 delta.text)`
    - 不调 LLM、不计配额
    - _Requirements: 18.7, 19.9_

  - [x] 21.4 实现客户端中断检测
    - 监听 `req.on('close')`；下一次 `res.write` 检测到 `res.writableEnded` 时跳出循环
    - 不再发送 done / error 帧；停止上游模型读取
    - 已 +1 配额不回滚
    - _Requirements: 19.10_

  - [x] 21.5 配额计数：仅在召回非空 + 即将向 LLM 首次请求前 +1
    - 与 `POST /api/ai/ask` 共享同一配额池
    - 召回为空、前置失败、缓存命中均不 +1；error / 中断已 +1 不回滚
    - _Requirements: 19.8_

  - [x] 21.6 前端 AskAiDrawer：fetch + reader 流式 UI
    - 使用 `fetch + reader.read()` 而非 EventSource（POST + Authorization 头），逐行解析 `data: <json>` 帧
    - 中断按钮调用 `reader.cancel()`
    - _Requirements: 19.1, 24.3_

  - [ ]* 21.7 属性测试 P24：SSE 帧协议不变量
    - **Property 24: SSE 帧协议不变量**
    - **Validates: Requirements 19.1, 19.3, 19.4, 19.5, 19.7**

  - [ ]* 21.8 属性测试 P25：AI 配额仅在真实 LLM 调用前 +1
    - **Property 25: AI 配额计数仅在真实 LLM 调用前 +1**
    - **Validates: Requirements 17.6, 17.9, 18.4, 19.2, 19.8, 19.10, 20.2, 20.7**

  - [ ]* 21.9 属性测试 P26：SSE 召回为空的固定降级
    - **Property 26: SSE 召回为空的固定降级**
    - **Validates: Requirements 18.7, 19.9**

- [x] 22. AI 写作助手（assist）
  - [x] 22.1 对齐 `POST /api/ai/assist`
    - 开关 4003；配额 4004；`kind ∈ {title, summary, explainCode}`，否则 400
    - title: 基于 `title + content` 生成 3-5 个候选标题，每个 ≤ 30 字
    - summary: 基于 `title + content` 生成 1-2 句中文摘要 ≤ 120 字
    - explainCode: 基于 `snippet + language` 返回 `{ explanation, risks[], suggestions[] }`
    - 成功 → 配额 +1，响应 `{ kind, ...result, quotaUsed, quotaLimit }`
    - 失败 → 502/5001
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8_

- [x] 23. Report_Service 举报
  - [x] 23.1 对齐 `POST /api/reports`
    - `targetType ∈ {post, comment}`、`targetId` 与 `reason` 非空（否则 400）
    - `reason` 截断 255 字保存；写 AuditLog（`report.create`）
    - _Requirements: 13.1, 13.2_

  - [x] 23.2 对齐 `/api/admin/reports` 列表与处理
    - 列表默认 `pending`，支持 `all` 或具体状态过滤；按 `createdAt DESC` 分页
    - `/handle`：`action ∈ {block, reject}`
    - block + post → 帖子 `status = 'blocked'`；block + comment → 评论 `status = 'blocked'`
    - 写 `handledBy / handledAt / remark` 与最终 status（`resolved` / `rejected`）
    - 写 AuditLog（`report.block` / `report.reject`）
    - _Requirements: 13.3, 13.4, 13.5, 13.6, 13.7_

- [x] 24. 置顶 / 加精 / 屏蔽 管理动作
  - [x] 24.1 对齐 `POST /api/admin/posts/:id/{pin,feature,block}`
    - 入口强制 `canModerateCategory` 校验，失败 → 403
    - pin: `pinned = clamp(level, 0, 2)`；> 0 时通知作者（`pinned`）
    - feature: 切换布尔；切换为 true 时通知作者（`featured`）
    - block: published ↔ blocked 切换
    - 全部成功后写 AuditLog（`post.pin / post.feature / post.block`）
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6_

- [x] 25. Setting_Service 系统设置与 AI 自检
  - [x] 25.1 对齐 `GET /api/admin/settings`
    - 返回 7 项 DEFAULTS（`aiAuditEnabled / aiExplainEnabled / aiExplainPerUserDailyLimit / aiAskEnabled / aiAskPerUserDailyLimit / aiAssistEnabled / aiAssistPerUserDailyLimit`）+ AI 状态卡片 `{ provider, model, apiKeyConfigured }`
    - _Requirements: 21.1, 21.2_

  - [x] 25.2 对齐 `PUT /api/admin/settings`
    - 仅接受 DEFAULTS 中已声明的 key，否则 400 + "未知的系统设置项"
    - JSON 序列化入 `SystemSetting.value`；仅写入成功后 `invalidate()` 缓存；失败保留旧缓存
    - 写入成功后写 AuditLog（`setting.update`），失败不写
    - _Requirements: 21.3, 21.4, 21.8_

  - [x] 25.3 对齐 `POST /api/admin/ai/test`
    - 用内置正常样本（或请求传入 `{ title, content }`）调 `auditContent`
    - 返回 `{ provider, model, apiKeyConfigured, elapsedMs, result }`
    - 异常 → 500 + `code = 500` + 中文原因
    - _Requirements: 21.6, 21.7_

  - [x] 25.4 前端 AdminPage 设置控件
    - boolean 类型 → `<Switch>`；number 类型 → `<InputNumber>`
    - _Requirements: 21.5_

  - [ ]* 25.5 属性测试 P27：系统设置写入的事务性
    - **Property 27: 系统设置写入的事务性**
    - **Validates: Requirements 21.3, 21.4, 21.8**

- [x] 26. Admin_Console 总览、用户管理与审计日志
  - [x] 26.1 对齐 `GET /api/admin/stats`
    - 返回 `{ users, posts, comments, categories, pendingReports }`
    - posts 仅 `status='published'`、comments 仅 `status='active'`、pendingReports 仅 `status='pending'`
    - _Requirements: 22.1_

  - [x] 26.2 对齐 `GET /api/admin/users`
    - keyword 在 `name / empNo / department` OR LIKE，按 `id ASC` 分页
    - 返回数据排除 `passwordHash`
    - _Requirements: 22.2, 22.3_

  - [x] 26.3 对齐 `PUT /api/admin/users/:id/role`
    - 校验 `role ∈ {user,moderator,admin}`、`status ∈ {active,disabled}`、`moderatorCategoryIds` 整数数组（≤50 项 + 每项对应已存在 Category）
    - 不允许把自身降级（自我修改时新 role 必须为 admin、新 status 必须为 active）
    - 校验失败 → 400，不持久化、不写 AuditLog
    - 校验通过 → 持久化 + 写 AuditLog（`user.update`）
    - _Requirements: 2.7, 2.8, 2.9_

  - [x] 26.4 对齐 `GET /api/admin/audit-logs`
    - 按 `createdAt DESC` 分页，附 `operator: { id, name, empNo }`
    - _Requirements: 22.4_

  - [x] 26.5 全量审计事件覆盖检查
    - 校验 R22.5 列出的全部 16 个 action 都已在对应 controller 落 `AuditLog`：`post.create / post.update / post.delete / post.pin / post.feature / post.block / post.rejected_by_ai / comment.delete / category.create / category.update / category.delete / report.create / report.block / report.reject / user.update / setting.update`
    - _Requirements: 22.5_

  - [ ]* 26.6 属性测试 P28：管理操作恰一次 AuditLog
    - **Property 28: 管理操作恰一次 AuditLog**
    - **Validates: Requirements 22.5**

  - [ ]* 26.7 属性测试 P34：管理后台统计聚合的正确性
    - **Property 34: 管理后台统计聚合的正确性**
    - **Validates: Requirements 22.1**

  - [ ]* 26.8 属性测试 P35：用户搜索的子集语义
    - **Property 35: 用户搜索的子集语义**
    - **Validates: Requirements 22.2, 22.3**

- [x] 27. 数据库启动同步与编排
  - [x] 27.1 对齐启动同步策略
    - 默认仅 `sequelize.sync()`，不修改已有表结构
    - `DB_SYNC_ALTER = '1'` 时执行一次 `sync({ alter: true })`
    - `docker-compose.yml` 提供 MySQL（host port 3316）+ Redis（host port 6380）开发依赖
    - _Requirements: 26.1, 26.2, 26.3, 26.4_

- [x] 28. 前端基础与组件
  - [x] 28.1 对齐 axios 实例 (`api/http.js`)
    - 注入 `Authorization: Bearer <token>`
    - 401 统一处理：清 token + 跳登录
    - 解包 `{ code, message, data }` 为 `data`，业务错误 throw
    - _Requirements: 27.4_

  - [x] 28.2 对齐 RichEditor IME 兼容
    - 在 `compositionstart / compositionend` 之间不触发 onChange，避免拼音过程误触
    - _Requirements: 24.3_

  - [x] 28.3 对齐 RichContent 富文本渲染
    - 代码块语法高亮（`highlight.js`）+ 图片懒加载（`loading="lazy"`）
    - 保留 `<img>` 原始属性以便前端按需加载
    - _Requirements: 10.8, 24.4_

  - [x] 28.4 对齐响应式布局
    - PC 与移动端 (H5) 双布局
    - 兼容主流现代浏览器最近两个大版本（Chrome / Edge / Firefox / Safari）
    - _Requirements: 24.1, 24.2_

  - [ ]* 28.5 组件测试：RichEditor IME 兼容
    - 模拟 `compositionstart → input → compositionend` 序列，断言中间不触发 onChange

  - [ ]* 28.6 组件测试：AskAiDrawer 流式接收与中断
    - mock fetch reader，断言文本逐帧增长 + 中断按钮调用 `reader.cancel()`

  - [ ]* 28.7 组件测试：AdminPage 设置控件渲染
    - 断言 boolean 设置渲染为 `<Switch>`、number 设置渲染为 `<InputNumber>`

- [ ] 29. 集成 / E2E 用例补充
  - [ ]* 29.1 sse_stream.e2e.js
    - 实拉 SSE 流，验证帧顺序 `meta → delta → done`、客户端 abort 检测、超时降级 error 帧
    - _Requirements: 19.1, 19.5, 19.7, 19.10_

  - [ ]* 29.2 rate_limit.e2e.js
    - 超过 600 req/min 后 429
    - _Requirements: 23.8_

  - [ ]* 29.3 body_size_limit.e2e.js
    - 发送 6 MB JSON，断言 413 被全局错误中间件兜底为 `{ code: 1 }`
    - _Requirements: 23.9_

  - [ ]* 29.4 cas_callback.e2e.js
    - mock CAS 服务器，覆盖成功 / 缺 ticket / 校验失败三条分支
    - _Requirements: 1.6, 1.7, 1.8_

  - [ ]* 29.5 helmet_headers.e2e.js
    - 响应头包含 `X-Content-Type-Options: nosniff` 与 `Strict-Transport-Security`
    - _Requirements: 23.6_

- [ ] 30. 最终 Checkpoint - 全量回归
  - 运行 `npm run test:unit && npm run test:property && npm run test:e2e`
  - 校验所有未跳过的属性测试 ≥ 100 次迭代均通过
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 标记 `*` 的子任务为可选测试任务，可跳过以加速 MVP；未标记的为必做
- 每条属性测试位于 `backend/tests/property/PXX-*.test.js`，每条 ≥ 100 次迭代，顶部注释引用设计文档属性号
- 属性测试基于 `fast-check` + `node:test`，与既有 `tests/run-all.js` 的 e2e 用例并存
- 单元测试覆盖纯函数（sanitize、tokenize、safeParseJSON、引用解析正则），不消耗 PBT 预算
- AI 相关属性（P15、P21、P22、P23、P24、P25、P26、P30）通过劫持 `AI_BASE_URL` 注入可控 mock 响应
- 缓存等价测试（P29）同时启动 `ioredis-mock` 与内存后端断言外部行为一致
- 所有管理类敏感操作必须落 `AuditLog`（与 Property 28 配套）
- 性能 / 浏览器兼容 / AI 模型语义质量不在自动化测试范围（依赖负载测试与人工评测）

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "2.1", "2.2", "4.1", "13.1", "27.1"] },
    { "id": 1, "tasks": ["2.3", "2.4", "3.1", "3.2", "3.3", "3.4", "4.2", "6.1", "12.1", "14.1", "14.2", "15.1", "25.1", "28.1"] },
    { "id": 2, "tasks": ["3.5", "3.6", "3.7", "3.8", "5.1", "5.2", "5.3", "6.2", "9.1", "12.2", "13.2", "14.3", "14.4", "15.2", "16.1", "23.1", "25.2", "25.3", "25.4", "26.1", "26.2", "26.3", "26.4", "28.2", "28.3", "28.4"] },
    { "id": 3, "tasks": ["5.4", "5.5", "6.3", "7.1", "8.1", "9.2", "11.1", "11.2", "11.3", "15.3", "15.4", "16.2", "17.1", "23.2", "25.5", "26.5"] },
    { "id": 4, "tasks": ["7.2", "7.3", "7.4", "7.5", "8.2", "8.3", "10.1", "16.3", "17.2", "19.1", "20.1", "20.2", "20.3", "22.1", "24.1", "26.6", "26.7", "26.8"] },
    { "id": 5, "tasks": ["7.6", "7.7", "10.2", "10.3", "11.4", "11.5", "19.2", "20.4", "20.5", "21.1", "21.2", "21.3", "21.4", "21.5", "28.5", "28.6", "28.7"] },
    { "id": 6, "tasks": ["10.4", "21.6", "21.7", "21.8", "21.9"] },
    { "id": 7, "tasks": ["29.1", "29.2", "29.3", "29.4", "29.5"] }
  ]
}
```
