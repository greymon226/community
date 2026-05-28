# Requirements Document

## Introduction

企业级技术交流分享社区（以下简称 **Community_Platform**）是面向企业内部员工的技术内容协作平台。平台以"看 / 写 / 问 / 管"为主线，提供 CAS 单点登录、多级板块、富文本帖子与评论、点赞收藏分享、全文搜索与排序、内容审核（敏感词 + AI）、举报、置顶 / 加精、消息通知、AI 智能推荐 / 解读 / 站内 RAG 问答 / 写作助手、以及管理后台。本文档基于已实现代码反推完整需求，作为后续迭代与验收的基线。

后端为 Node.js + Express + Sequelize（MySQL 8）+ Redis + JWT；前端为 React 18 + Vite + Ant Design 5 + Zustand + React Router v6；AI 通过 DeepSeek（OpenAI 兼容 `/v1/chat/completions`）接入，未配置或调用失败时降级到本地规则。

## Glossary

- **Community_Platform**：完整社区系统，含 Web 前端、后端 API、数据库、缓存与 AI 调用层
- **Auth_Service**：负责登录、CAS 回调、JWT 颁发与校验的后端模块
- **CAS_Service**：对接企业 CAS 单点登录的服务模块；`CAS_SERVER_URL` 未配置时进入 Mock 模式
- **Post_Service**：帖子创建 / 编辑 / 删除 / 列表 / 详情 / 状态管理模块
- **Comment_Service**：评论及引用回复管理模块
- **Interaction_Service**：点赞、收藏、分享相关的处理模块
- **Search_Service**：基于 Sequelize 的全文搜索 / 排序 / 筛选模块，提供 `searchPosts` 与 `searchForRAG`
- **Moderation_Service**：敏感词加载与策略执行模块（mask / block / review）
- **AI_Service**：DeepSeek 客户端 + 本地规则降级模块，承担审核 / 推荐 / 解读 / 问答 / 写作助手
- **AI_Audit**：发帖 / 编辑 / 评论时的内容审核子流程，输出 `pass | review | blocked`
- **AI_Explain**：帖子详情页的 AI 解读子流程，输出 summary / keyPoints / suggestions / questions
- **AI_Ask**：站内 RAG 问答子流程，含普通接口与 SSE 流式接口
- **AI_Assist**：写作助手子流程，提供 title / summary / explainCode 三种 kind
- **Notification_Service**：站内消息生成、查询与已读处理模块
- **Report_Service**：用户举报与管理员处理模块
- **Admin_Console**：管理后台前端 + 对应 `/api/admin/*` 接口
- **Audit_Log**：管理类敏感操作的留痕（`AuditLog` 模型 + `writeAudit` 中间件）
- **Setting_Service**：系统设置读写与缓存模块（含 AI 各开关与配额）
- **Cache_Service**：Redis 优先、未配置时降级到内存的缓存模块
- **JWT_Token**：登录后颁发的 Bearer 令牌，默认有效期 7 天
- **Role**：用户角色，取值 `user`（普通用户） / `moderator`（版主） / `admin`（超级管理员）
- **Post_Status**：帖子状态，取值 `draft` / `published` / `blocked` / `deleted`
- **AI_Audit_Status**：AI 审核结果，取值 `pass` / `review` / `blocked` / `skipped`
- **Quota_Daily_Limit**：单用户每日 AI 配额，按 `ai:<feature>:quota:<userId>:<YYYY-MM-DD>` 计数
- **Sensitive_Strategy**：敏感词策略，取值 `mask` / `block` / `review`

错误码约定：

- `4001`：命中敏感词 block 策略
- `4002`：AI 审核 blocked
- `4003`：相关 AI 功能开关关闭
- `4004`：当日 AI 配额耗尽
- `5001`：AI 服务调用失败（含降级失败）

## Requirements

### Requirement 1: 用户认证与单点登录

**User Story:** 作为企业员工，我希望使用工号通过 CAS 登录社区，本地开发时可使用账号密码 Mock 登录，登录后凭 JWT 访问后续接口，从而无需重复输入企业凭据。

#### Acceptance Criteria

1. WHEN 前端请求 `GET /api/auth/cas/login-url`，THE Auth_Service SHALL 返回 HTTP 200 与 `{ mock: boolean, url: string }`，其中 Mock 模式下 `mock=true` 且 `url` 为本地登录页地址，CAS 模式下 `mock=false` 且 `url` 为外部 CAS 登录入口
2. WHERE `CAS_SERVER_URL` 未配置，THE CAS_Service SHALL 以 Mock 模式运行，并支持通过 `POST /api/auth/login` 使用 `empNo + password` 登录
3. WHEN 收到 `POST /api/auth/login` 且 `empNo` 或 `password` 字段缺失、非字符串、或 trim 后长度为 0，THE Auth_Service SHALL 返回 HTTP 400 与提示"工号与密码不能为空"，且不进入密码比对流程
4. IF `POST /api/auth/login` 提交的工号不存在、对应用户被禁用、或密码错误，THEN THE Auth_Service SHALL 统一返回 HTTP 401 与提示"工号或密码错误"，避免账号枚举
5. WHEN `POST /api/auth/login` 校验通过，THE Auth_Service SHALL 更新用户 `lastLoginAt`、签发有效期 7 天的 JWT_Token 并返回 `{ token, user }`，其中 `user` 仅含 `{ id, empNo, name, nickname, email, department, avatar, bio, techTags, role, emailNotify }` 且不含 `passwordHash`
6. WHEN `GET /api/auth/cas/callback` 收到合法 `ticket`，THE CAS_Service SHALL 校验 ticket、按 profile 同步本地用户的 `empNo / name / department / email`，并由 Auth_Service 签发有效期 7 天的 JWT_Token
7. IF `GET /api/auth/cas/callback` 缺少 `ticket` 或 `ticket` 为空字符串，THEN THE Auth_Service SHALL 返回 HTTP 400 与提示"缺少 ticket"
8. IF `GET /api/auth/cas/callback` 的 ticket 校验失败、超时、或 profile 获取失败，THEN THE Auth_Service SHALL 返回 HTTP 401 与提示"CAS 登录失败"，且不创建本地用户、不签发 JWT_Token
9. THE Auth_Service SHALL 使用 `Authorization: Bearer <token>` 头识别用户身份
10. IF 受保护接口请求未携带 `Authorization` 头、头格式非 `Bearer xxx`、token 解析失败、或 token 已过期，THEN THE Auth_Service SHALL 返回 HTTP 401 与业务码 401，提示"登录态无效"
11. IF JWT_Token 解析得到的用户不存在或 `status` 不为 `active`，THEN THE Auth_Service SHALL 返回 HTTP 401 与提示"用户不可用"
12. WHEN `GET /api/auth/me` 由已登录用户请求，THE Auth_Service SHALL 返回 HTTP 200 与当前用户 `{ id, empNo, name, nickname, email, department, avatar, bio, techTags, role, emailNotify }`，且不含 `passwordHash`
13. WHEN `POST /api/auth/logout` 被调用，THE Auth_Service SHALL 返回 HTTP 200 与业务码 0，由前端清理本地 JWT_Token

### Requirement 2: 用户角色与权限

**User Story:** 作为平台运营方，我希望按角色控制功能权限，让普通用户专注创作，版主管理指定板块，管理员拥有全局权限。

#### Acceptance Criteria

1. THE Community_Platform SHALL 维护三种 Role：`user`、`moderator`、`admin`，并将新创建用户的默认 Role 设置为 `user`
2. WHERE Role=`user` 且用户 `status = 'active'`，THE Community_Platform SHALL 允许其进行内容创作（发帖 / 评论）与互动（点赞 / 收藏 / 分享 / 举报）
3. WHERE Role=`moderator` 且用户 `status = 'active'`，THE Community_Platform SHALL 允许其行使 Role=`user` 的全部权限，并对自身 `moderatorCategoryIds` 列表中的板块执行置顶 / 加精 / 屏蔽 / 删除评论
4. WHEN Role=`moderator` 请求对帖子或评论执行管理动作（置顶 / 加精 / 屏蔽 / 删除评论），THE Auth_Service SHALL 在执行前始终调用 `canModerateCategory(user, categoryId)` 校验；若该 `categoryId` 不在其 `moderatorCategoryIds` 中，THE Auth_Service SHALL 返回 HTTP 403 与提示"无权操作"，不得因任何分支跳过该校验
5. WHERE Role=`admin` 且用户 `status = 'active'`，THE Community_Platform SHALL 允许其访问所有 `/api/admin/*` 接口，并在所有板块上拥有 Role=`moderator` 的全部权限
6. IF 用户携带有效 JWT_Token 访问 `/api/admin/*` 接口且解析得到的 Role 不在该接口 `requireRole` 允许列表内，THEN THE Auth_Service SHALL 返回 HTTP 403 与业务码 403
7. WHEN 管理员通过 `PUT /api/admin/users/:id/role` 修改角色 / 版主板块 / 状态，THE Admin_Console SHALL 仅接受 `role ∈ {user, moderator, admin}`、`status ∈ {active, disabled}`、`moderatorCategoryIds` 为整数数组（≤50 项且每项对应数据库中已存在的 Category），校验通过后持久化变更并写入 Audit_Log
8. IF `PUT /api/admin/users/:id/role` 提交的 `role`、`status` 或 `moderatorCategoryIds` 任一字段不满足上述校验，THEN THE Admin_Console SHALL 返回 HTTP 400 与对应错误提示，且不持久化任何变更、不写 Audit_Log
9. IF `PUT /api/admin/users/:id/role` 的目标 `id` 等于当前管理员自身且新 `role` 不为 `admin` 或新 `status` 不为 `active`，THEN THE Admin_Console SHALL 返回 HTTP 400 与提示"不能修改自身角色或状态"

### Requirement 3: 个人中心

**User Story:** 作为用户，我希望查看与维护自己的资料、技术标签与互动数据，并通过快捷入口查看我的帖子 / 收藏 / 评论 / 消息。

#### Acceptance Criteria

1. WHEN 已登录用户请求 `GET /api/users/:id` 且目标用户存在且 `status = 'active'`，THE Community_Platform SHALL 返回 HTTP 200 与 `{ id, empNo, name, nickname, department, avatar, bio, techTags, role, stats }`，其中 `stats.postCount` 仅统计 `status = 'published'` 的帖子数、`stats.likeReceived` 为该用户所有 `published` 帖子的 `likeCount` 之和、`stats.favoriteCount` 为该用户的收藏总数
2. IF `GET /api/users/:id` 的 `:id` 不存在或对应用户 `status != 'active'`，THEN THE Community_Platform SHALL 返回 HTTP 404 与提示"用户不存在"
3. WHEN 已登录用户调用 `PUT /api/users/me`，THE Community_Platform SHALL 仅识别 `nickname`（字符串 ≤64）、`bio`（字符串 ≤500）、`techTags`（数组或逗号分隔字符串，归一化为最多 20 个、每个 ≤32 字、去重）、`avatar`（字符串 ≤255）、`emailNotify`（布尔），未列出的字段被忽略
4. IF `PUT /api/users/me` 任一字段不满足上述类型 / 长度 / 数量约束，THEN THE Community_Platform SHALL 返回 HTTP 400 与对应字段错误，不持久化任何变更
5. THE Community_Platform SHALL 在保存前对 `nickname`、`bio` 与 `techTags` 的每个元素先调用 `cleanPlainText` 去除 HTML / 控制字符，再校验长度与数量
6. WHEN 已登录用户请求 `GET /api/users/me/posts` 且 `status ∈ {draft, published, blocked, all}`、`page ≥ 1`、`pageSize ∈ [1, 50]`（默认 `status='published'`、`page=1`、`pageSize=10`），THE Community_Platform SHALL 按 `createdAt` 倒序返回 `{ items, total, page, pageSize }`
7. IF `GET /api/users/me/posts` 的 `status` 取值不在允许集合内，THEN THE Community_Platform SHALL 返回 HTTP 400 与提示"status 取值非法"
8. WHEN 已登录用户请求 `GET /api/users/me/favorites`，THE Community_Platform SHALL 返回该用户收藏的帖子（含作者）按 `Favorite.createdAt` 倒序，仅包含 `status = 'published'` 的帖子
9. WHEN 已登录用户请求 `GET /api/users/me/comments`，THE Community_Platform SHALL 返回其非 `deleted` 状态评论（含所属帖子 `{ id, title }`）最多 100 条，按 `createdAt` 倒序
10. IF 上述 `/api/users/me/*` 任一接口未携带有效 JWT_Token，THEN THE Auth_Service SHALL 按 Requirement 1 返回 HTTP 401

### Requirement 4: 板块（分类）管理

**User Story:** 作为管理员，我希望维护多级（一级 → 二级）板块结构与可见权限，让员工按主题归档与查找内容。

#### Acceptance Criteria

1. THE Community_Platform SHALL 仅支持最多两级板块：一级 `parentId = null`，二级 `parentId` 必须指向一个 `parentId = null` 的现存板块
2. WHEN 任意访客请求 `GET /api/categories`，THE Community_Platform SHALL 仅返回 `enabled = true` 的板块，按 `sort ASC, id ASC` 排序，一级板块返回数组并在 `children` 中包含其二级板块（二级 `children` 固定为空数组）
3. WHEN 管理员调用 `POST /api/admin/categories` 时，`name` 非空（≤64 字）、`description` ≤255 字、`icon` ≤255 字、`sort` 为整数、`enabled` 为布尔（缺省 true），THE Admin_Console SHALL 持久化该板块并写入 Audit_Log；若任一字段不满足约束，SHALL 返回 HTTP 400 与对应字段错误，不持久化、不写 Audit_Log
4. WHEN 管理员调用 `PUT /api/admin/categories/:id`，THE Admin_Console SHALL 仅识别 `name / description / icon / parentId / sort / enabled / visibility` 字段，未列出的字段被忽略；若 `visibility` 为对象类型，SHALL 序列化为 JSON 字符串后保存；变更成功写入 Audit_Log
5. WHEN 管理员调用 `DELETE /api/admin/categories/:id`，且该板块下不存在子板块且不存在状态非 `deleted` 的帖子，THE Admin_Console SHALL 删除该板块并写入 Audit_Log；否则返回 HTTP 400 与提示"该板块下仍存在子板块或帖子"，不执行删除
6. THE Community_Platform SHALL 接受 `visibility` 为可选字段；当 `visibility` 为 `null`、空字符串或 `{}` 时，板块对所有用户可见
7. THE Community_Platform SHALL 仅允许 Role=`admin` 调用 `POST /admin/categories`、`PUT /admin/categories/:id`、`DELETE /admin/categories/:id`；其它 Role 调用返回 HTTP 403
8. IF `POST` 或 `PUT` 时 `parentId` 等于自身 `id`、指向不存在的板块、或指向一个 `parentId` 非 null 的二级板块，THEN THE Admin_Console SHALL 返回 HTTP 400 与提示"父板块非法"
9. IF `PUT` 或 `DELETE` 时 `:id` 不存在，THEN THE Admin_Console SHALL 返回 HTTP 404 与提示"板块不存在"

### Requirement 5: 帖子创建、编辑与删除

**User Story:** 作为用户，我希望使用富文本编辑器撰写技术帖（含代码块、图片、表格、链接），按草稿或发布状态保存，并可在后续编辑或删除。

#### Acceptance Criteria

1. WHEN 已登录用户调用 `POST /api/posts` 缺失 `title`、`content` 或 `categoryId` 任一字段，THE Post_Service SHALL 返回错误"标题、正文、分类必填"
2. THE Post_Service SHALL 对 `title` 调用 `cleanPlainText` 并截断至 200 字
3. THE Post_Service SHALL 对 `content` 调用 `cleanRichText`（基于 `sanitize-html` 的白名单）以防御 XSS
4. THE Post_Service SHALL 在保存帖子时基于清洗后的 `content` 自动生成 `summary`
5. THE Post_Service SHALL 支持四种 Post_Status：`draft` / `published` / `blocked` / `deleted`
6. WHEN 创建帖子且 `status = 'draft'`，THE Post_Service SHALL 跳过 AI_Audit 并以 `draft` 状态保存
7. WHEN 帖子作者或 Role=`admin` 调用 `PUT /api/posts/:id`，THE Post_Service SHALL 允许编辑 `title / content / categoryId / tags / status`
8. IF 调用 `PUT /api/posts/:id` 的用户既非作者也非 admin，THEN THE Post_Service SHALL 返回 HTTP 403 与提示"无权修改"
9. WHEN 编辑后 `status` 切换至 `published` 且 `title` 或 `content` 发生变更，THE Post_Service SHALL 重新执行 AI_Audit
10. WHEN 帖子作者或 Role=`admin` 调用 `DELETE /api/posts/:id`，THE Post_Service SHALL 将 `status` 置为 `deleted` 并写入 Audit_Log
11. IF 帖子 `status = 'deleted'`，THEN THE Post_Service SHALL 在 `GET /api/posts/:id` 返回 HTTP 404
12. IF 帖子 `status = 'blocked'` 且请求方既非作者也非 admin，THEN THE Post_Service SHALL 在 `GET /api/posts/:id` 返回 HTTP 403 与提示"帖子已被屏蔽"
13. WHEN 任意访客请求 `GET /api/posts/:id` 且帖子可见，THE Post_Service SHALL 返回完整字段（含 `author / category / tags`）并异步 `increment(viewCount)` 不阻塞响应
14. WHERE 已登录用户访问 `GET /api/posts/:id`，THE Post_Service SHALL 在响应中返回 `liked` 与 `favorited` 当前用户视角

### Requirement 6: 标签

**User Story:** 作为用户，我希望为帖子添加自由标签，便于后续搜索与推荐。

#### Acceptance Criteria

1. THE Post_Service SHALL 允许每篇帖子最多 10 个标签
2. THE Post_Service SHALL 对每个标签调用 `cleanPlainText` 并截断至 32 字，过滤空字符串
3. WHEN 帖子绑定标签时不存在该 Tag，THE Post_Service SHALL 自动创建 Tag 记录
4. WHEN 帖子的标签集合发生变化，THE Post_Service SHALL 删除原有 PostTag 关联并按新集合重建，并对每个 Tag 执行 `increment('usageCount')`

### Requirement 7: 帖子列表、搜索、排序与筛选

**User Story:** 作为用户，我希望按关键词搜索全文，按时间 / 热度 / 评论数 / 精华排序，并按板块、作者、标签筛选，从而快速定位想看的内容。

#### Acceptance Criteria

1. WHEN 任意访客请求 `GET /api/posts`，THE Search_Service SHALL 仅返回 `status = 'published'` 的帖子，并支持 `keyword / categoryId / authorId / tag / sort / page / pageSize` 查询参数
2. WHERE 提供 `keyword`，THE Search_Service SHALL 在 `title`、`content`、`summary` 三个字段上使用 `LIKE %keyword%` 进行 OR 匹配
3. WHEN `sort = 'latest'` 或缺省，THE Search_Service SHALL 按 `pinned DESC, createdAt DESC` 排序
4. WHEN `sort = 'hot'`，THE Search_Service SHALL 按 `pinned DESC, likeCount DESC, viewCount DESC` 排序
5. WHEN `sort = 'comments'`，THE Search_Service SHALL 按 `pinned DESC, commentCount DESC` 排序
6. WHEN `sort = 'featured'`，THE Search_Service SHALL 按 `featured DESC, createdAt DESC` 排序
7. THE Search_Service SHALL 限制 `pageSize` 上限为 50；超出时按 50 截断
8. THE Search_Service SHALL 在响应中返回 `{ items, total, page, pageSize }`，且 `items` 含 `author / category / tags`
9. WHERE 提供 `tag`，THE Search_Service SHALL 通过 `Tag.name` 关联做强制 `required = true` 过滤

### Requirement 8: 评论与引用回复

**User Story:** 作为用户，我希望在帖子下评论以及对其它评论引用回复，并能点赞或删除评论。

#### Acceptance Criteria

1. WHEN 任意访客请求 `GET /api/posts/:postId/comments`，THE Comment_Service SHALL 在数据库层面通过 `status != 'deleted'` 过滤已删除评论后再处理，仅对剩余评论组装 `replyTo`（含原作者昵称）等关联与当前用户点赞状态，按 `createdAt ASC` 排序返回
2. WHERE 已登录用户访问该列表，THE Comment_Service SHALL 在每条评论上附加 `liked` 当前用户视角
3. WHEN 已登录用户调用 `POST /api/posts/:postId/comments` 且 `content` 为空，THE Comment_Service SHALL 返回错误"内容不能为空"
4. IF 目标帖子 `status` 不为 `published`，THEN THE Comment_Service SHALL 返回错误"帖子不可评论"
5. THE Comment_Service SHALL 对评论 `content` 调用 `cleanRichText` 并基于其纯文本调用 Moderation_Service
6. IF 评论命中敏感词 `block` 策略，THEN THE Comment_Service SHALL 返回业务码 4001 / HTTP 400
7. WHEN 评论 AI_Audit 返回 `blocked`，THE Comment_Service SHALL 返回业务码 4002 / HTTP 400 且不创建评论；当 AI_Audit 返回 `pass` 或其它非 `blocked` 状态（含 `review`）时，THE Comment_Service SHALL 不返回业务码 4002，按各自业务路径处理
8. WHEN AI_Audit 返回 `review`，THE Comment_Service SHALL 创建评论并将其 `status` 置为 `blocked`，响应中带 `pending = true` 与提示"已提交，AI 审核存疑，等待管理员复审"
9. WHEN 评论创建成功（非 review），THE Comment_Service SHALL 对帖子 `commentCount` 自增并通知帖子作者（type=`commented`）；若提供 `replyToId`，THE Comment_Service SHALL 同时通知被引用评论的作者（type=`replied`）
10. WHEN 评论作者或可管理该帖子板块的版主 / admin 调用 `DELETE /api/comments/:id`，THE Comment_Service SHALL 将 `status` 置为 `deleted` 并对帖子 `commentCount` 自减
11. IF 删除评论的请求方既非作者也非可管理该板块的版主 / admin，THEN THE Comment_Service SHALL 返回 HTTP 403 与提示"无权删除"
12. WHEN 已登录用户调用 `POST /api/comments/:id/like`，THE Interaction_Service SHALL 在用户已点赞时取消并 `decrement('likeCount')`，未点赞时新增并 `increment('likeCount')`，响应返回最新 `liked` 与 `likeCount`

### Requirement 9: 互动 - 点赞、收藏、分享

**User Story:** 作为用户，我希望对帖子点赞、收藏并复制分享链接，让有价值的内容沉淀下来。

#### Acceptance Criteria

1. WHEN 已登录用户调用 `POST /api/posts/:id/like`，THE Interaction_Service SHALL 切换该用户对该帖子的点赞状态并同步 `Post.likeCount`
2. WHEN 用户由"未赞"变为"已赞"，THE Notification_Service SHALL 向帖子作者发送 type=`liked` 的通知
3. WHEN 已登录用户调用 `POST /api/posts/:id/favorite`，THE Interaction_Service SHALL 切换该用户对该帖子的收藏状态并同步 `Post.favoriteCount`
4. THE Community_Platform SHALL 在帖子详情页提供"复制链接"按钮，由前端通过浏览器剪贴板 API 完成分享
5. IF 操作目标帖子不存在，THEN THE Interaction_Service SHALL 返回 HTTP 404 与提示"帖子不存在"

### Requirement 10: 文件上传

**User Story:** 作为内容作者，我希望在富文本中插入图片，平台需要限制类型与大小防止滥用。

#### Acceptance Criteria

1. THE Community_Platform SHALL 通过 `POST /api/upload` 接收 `multipart/form-data` 单文件 `file` 字段
2. THE Community_Platform SHALL 仅接受扩展名属于 `{.png, .jpg, .jpeg, .gif, .webp}` 的文件
3. IF 上传文件扩展名不在白名单，THEN THE Community_Platform SHALL 返回错误"不支持的文件类型"
4. THE Community_Platform SHALL 限制单文件大小不超过 `MAX_UPLOAD_MB` 配置值（默认 10 MB）
5. WHEN 上传文件被处理，THE Community_Platform SHALL 同时校验扩展名白名单与大小限制；任一项校验失败时不得返回成功响应，必须返回相应错误
6. WHEN 上传成功（白名单与大小校验均通过），THE Community_Platform SHALL 返回 `{ url, originalName, size }`，其中 `url` 形如 `/uploads/{timestamp}-{uuid}{ext}`
7. THE Community_Platform SHALL 通过 `/uploads/*` 静态路由对外提供这些文件
8. WHERE 前端启用图片懒加载，THE Community_Platform SHALL 在帖子详情中保留 `<img>` 原始属性以便前端按需加载

### Requirement 11: 敏感词过滤

**User Story:** 作为运营方，我希望根据敏感词策略，自动遮蔽 / 拦截 / 标记送审违规内容，避免明显违规内容上线。

#### Acceptance Criteria

1. THE Moderation_Service SHALL 在首次调用时加载数据库 `SensitiveWord` 与 `.env` 中 `SENSITIVE_WORDS` 兜底词，并缓存
2. THE Moderation_Service SHALL 支持三种 Sensitive_Strategy：`mask` / `block` / `review`
3. WHEN 文本命中 `mask` 策略词，THE Moderation_Service SHALL 将该词替换为等长 `*`
4. WHEN 文本命中任一 `block` 策略词，THE Moderation_Service SHALL 在结果中置 `blocked = true`
5. WHEN 文本同时命中 `review` 与 `block` 策略词，THE Moderation_Service SHALL 同时置 `blocked = true` 与 `needReview = true`，不得因 block 优先而跳过 review 标记
6. WHEN 文本未命中任何敏感词，THE Moderation_Service SHALL 不修改 `cleanText`、保持 `hits = []`、`blocked = false`、`needReview = false`，不执行任何替换或标记动作
7. WHEN 帖子或评论内容命中 `block` 策略，THE Post_Service / Comment_Service SHALL 返回业务码 4001 / HTTP 400
8. WHEN 管理员通过 `POST /api/admin/sensitive-words` 添加或更新词条、`DELETE /api/admin/sensitive-words/:id` 删除词条，THE Moderation_Service SHALL `invalidate()` 缓存以便下一次调用重新加载

### Requirement 12: AI 内容审核

**User Story:** 作为运营方，我希望发帖 / 编辑时自动调用 AI 审核，把违规内容拦在发布前，对疑似违规内容标记为待复审。

#### Acceptance Criteria

1. WHERE 系统设置 `aiAuditEnabled = true` 且帖子非 `draft`，THE Post_Service SHALL 在创建或编辑发布时调用 AI_Audit
2. WHERE 帖子 `status = 'draft'`，THE Post_Service SHALL 跳过 AI_Audit 并将 `aiAuditStatus` 不置为模型结果（继续维持业务逻辑判断）
3. WHEN AI_Audit 返回 `pass`，THE Post_Service SHALL 将帖子 `status` 置为 `published` 并将 `aiAuditStatus` 置为 `pass`
4. WHEN AI_Audit 返回 `review`，THE Post_Service SHALL 将帖子 `status` 置为 `blocked`、`aiAuditStatus` 置为 `review`、响应附 `pending = true` 并提示"已提交，AI 审核存疑，等待管理员复审"
5. WHEN AI_Audit 返回 `blocked`，THE Post_Service SHALL 不创建 / 不持久化变更，返回 HTTP 400 与业务码 4002，并将原始拒绝原因写入 Audit_Log（`action = 'post.rejected_by_ai'`）
6. WHERE `aiAuditEnabled = false`，THE Post_Service SHALL 跳过 AI 调用，将 `aiAuditStatus` 置为 `skipped`、`aiAuditReason` 置为"AI 审核已关闭"
7. THE AI_Service SHALL 通过 `POST {AI_BASE_URL}/v1/chat/completions` 调用 DeepSeek（OpenAI 兼容协议），固定 `response_format = { type: 'json_object' }` 与 `temperature = 0`
8. THE AI_Service SHALL 解析模型返回的 JSON 为 `{ status, reason, categories }`，其中 `status ∈ {pass, review, blocked}`，否则按 `review` 兜底
9. IF AI 模型调用抛出异常或返回非法 JSON，THEN THE AI_Service SHALL 降级到本地 `RISK_KEYWORDS` 规则，命中风险词时返回 `review`
10. THE AI_Service SHALL 在请求上设置 `AI_TIMEOUT_MS`（默认 15000ms）超时；超时后按降级规则处理
11. WHEN 评论创建走 AI_Audit 且返回 `blocked`，THE Comment_Service SHALL 返回 HTTP 400 与业务码 4002；返回 `review` 时按 R8.8 处理

### Requirement 13: 举报与处理

**User Story:** 作为用户，我希望对违规帖子或评论发起举报；作为管理员或版主，我希望集中处理举报。

#### Acceptance Criteria

1. WHEN 已登录用户调用 `POST /api/reports`，THE Report_Service SHALL 校验 `targetType ∈ {post, comment}`、`targetId` 与 `reason` 均非空，否则返回 HTTP 400
2. THE Report_Service SHALL 将 `reason` 截断至 255 字保存
3. WHEN 管理员或版主调用 `GET /api/admin/reports`，THE Report_Service SHALL 默认仅返回 `status = 'pending'` 的举报，支持 `status = all` 或具体状态过滤，按 `createdAt DESC` 排序分页
4. WHEN 管理员或版主调用 `POST /api/admin/reports/:id/handle`，THE Report_Service SHALL 仅接受 `action ∈ {block, reject}`
5. WHEN `action = 'block'` 且 `targetType = 'post'`，THE Report_Service SHALL 将该帖子 `status` 置为 `blocked`
6. WHEN `action = 'block'` 且 `targetType = 'comment'`，THE Report_Service SHALL 将该评论 `status` 置为 `blocked`
7. WHEN 处理完成，THE Report_Service SHALL 写入 `handledBy / handledAt / remark` 并将举报 `status` 置为 `resolved`（block）或 `rejected`（reject），同时写入 Audit_Log

### Requirement 14: 置顶 / 加精 / 屏蔽

**User Story:** 作为版主或管理员，我希望对优质内容置顶或加精，对违规内容屏蔽。

#### Acceptance Criteria

1. WHEN 版主或管理员调用 `POST /api/admin/posts/:id/pin` 且 `canModerateCategory(user, post.categoryId) = true`，THE Post_Service SHALL 将 `pinned` 设为 `clamp(level, 0, 2)`，支持 0 / 1（板块）/ 2（全站）两级置顶
2. WHEN `pinned > 0`，THE Notification_Service SHALL 向帖子作者发送 type=`pinned` 通知
3. WHEN 版主或管理员调用 `POST /api/admin/posts/:id/feature`，THE Post_Service SHALL 切换 `featured` 布尔；切换为 `true` 时，THE Notification_Service SHALL 发送 type=`featured` 通知
4. WHEN 版主或管理员调用 `POST /api/admin/posts/:id/block`，THE Post_Service SHALL 在 `published` 与 `blocked` 之间切换帖子 `status`
5. WHEN 任一上述管理动作执行成功，THE Audit_Log SHALL 记录 `action / targetType / targetId / detail`
6. IF `canModerateCategory` 校验失败，THEN THE Post_Service SHALL 返回 HTTP 403 与提示"无权操作"

### Requirement 15: 消息通知

**User Story:** 作为用户，我希望被评论 / 被回复 / 被点赞 / 被加精 / 被置顶 / 收到系统公告时收到站内消息，并能在消息中心查看与已读。

#### Acceptance Criteria

1. THE Notification_Service SHALL 支持以下 `type`：`commented` / `replied` / `liked` / `featured` / `pinned` / `system`
2. WHEN 已登录用户调用 `GET /api/notifications`，THE Notification_Service SHALL 按 `createdAt DESC` 返回分页结果，并附 `unreadCount`
3. WHERE 查询参数 `unreadOnly = '1' | 'true'`，THE Notification_Service SHALL 仅返回 `read = false` 的通知
4. WHEN 已登录用户调用 `POST /api/notifications/read` 不带 `ids`，THE Notification_Service SHALL 将其全部未读通知置为已读
5. WHEN 调用 `POST /api/notifications/read` 携带 `ids` 数组，THE Notification_Service SHALL 仅将 `ids` 内属于当前用户的通知置为已读
6. WHEN 通知触发条件满足（被评论 / 被回复 / 被点赞 / 被加精 / 被置顶），THE Community_Platform 对应模块 SHALL 调用 `notify.notify(...)` 写入 `Notification` 表
7. WHERE 用户已登录，THE Community_Platform 前端 SHALL 在页面加载完成时立即基于 `unreadCount` 显示红点未读提示，且每 30 秒轮询 `GET /api/notifications?unreadOnly=1` 更新未读数量，无需等待首次轮询完成
8. WHERE 用户在个人设置开启 `emailNotify = true`，THE Notification_Service SHALL 记录该偏好以便后续邮件通道扩展（本期允许仅持久化偏好）

### Requirement 16: AI 智能推荐

**User Story:** 作为用户，我希望首页能基于我的技术标签推荐相关帖子，提高发现效率。

#### Acceptance Criteria

1. WHEN 已登录用户调用 `GET /api/posts/recommend`，THE AI_Service SHALL 基于用户 `techTags` 与 `Tag` 表做交集匹配
2. WHERE 用户 `techTags` 为空或未命中任何 Tag，THE AI_Service SHALL 退化为按 `likeCount DESC, createdAt DESC` 取热门帖子最多 10 条
3. WHERE 命中标签集合非空，THE AI_Service SHALL 返回与匹配标签关联且 `status = 'published'` 的帖子最多 10 条，按 `likeCount DESC, createdAt DESC` 排序

### Requirement 17: AI 帖子解读

**User Story:** 作为读者，我希望对长文一键 AI 解读，得到摘要、要点、改进建议、追问问题，快速吸收内容。

#### Acceptance Criteria

1. WHERE `aiExplainEnabled = false`，THE Post_Service SHALL 在 `GET /api/posts/:id/explain` 返回 HTTP 403 与业务码 4003
2. IF 目标帖子 `status = 'deleted'` 或不存在，THEN THE Post_Service SHALL 返回 HTTP 404 与提示"帖子不存在"
3. IF 帖子 `status = 'blocked'` 且请求方既非作者也非 admin，THEN THE Post_Service SHALL 返回 HTTP 403 与提示"帖子不可访问"
4. THE Post_Service SHALL 以 `ai:explain:post:<postId>:<updatedAtTs>` 为缓存键缓存解读结果 24 小时
5. WHEN 缓存命中，THE Post_Service SHALL 直接返回结果并附 `cached = true`，且不消耗用户配额
6. WHEN 缓存未命中且 `aiExplainPerUserDailyLimit > 0` 且当日已用 ≥ 上限，THE Post_Service SHALL 返回 HTTP 429 与业务码 4004 与提示"今日 AI 解读次数已用完"
7. WHEN 调用 AI_Service 解读失败，THE Post_Service SHALL 返回 HTTP 502 与业务码 5001 与提示"AI 解读失败：<原因>"
8. WHEN 调用成功，THE AI_Service SHALL 返回 `{ summary, keyPoints[], suggestions[], questions[], model, usage, elapsedMs }`，且 `keyPoints` 控制在 3-6 条，`suggestions / questions` 各 0-4 条
9. WHEN 调用成功，THE Post_Service SHALL 写入 24h 缓存并将当日配额计数 `+1`

### Requirement 18: AI 站内问答（RAG）

**User Story:** 作为用户，我希望提问后由 AI 基于站内帖子作答，并标注引用，让我能继续深入查阅原帖。

#### Acceptance Criteria

1. WHERE `aiAskEnabled = false`，THE AI_Service SHALL 在 `POST /api/ai/ask` 与 `POST /api/ai/ask/stream` 返回 HTTP 403 与业务码 4003
2. WHEN 收到 `question` 为空或长度 > 500，THE AI_Service SHALL 返回 HTTP 400 与对应提示
3. THE AI_Service SHALL 对 `question` 调用 Moderation_Service；命中 `block` 策略时返回业务码 4001 / HTTP 400
4. WHEN 未命中缓存且 `aiAskPerUserDailyLimit > 0` 且当日已用 ≥ 上限，THE AI_Service SHALL 返回 HTTP 429 与业务码 4004
5. THE AI_Service SHALL 通过 `Search_Service.searchForRAG` 召回 Top-N 候选帖子，其中 `topN = clamp(请求参数 topN, 3, 8)`，默认 5
6. THE Search_Service SHALL 在 `searchForRAG` 中按以下流程工作：分词（中英文）→ 多关键词在 `title / content / summary` 上 OR 召回 → 本地评分（标题命中权重 5、正文命中按出现次数封顶 5、互动量对数微加权）→ 取 Top-N
7. WHEN 站内未召回任何相关帖子，THE AI_Service SHALL 不调用模型，返回引导文案"站内还没有找到相关讨论..."并将 `hasAnswer = false`、`citations = []`、`candidates = []`
8. WHEN 召回非空，THE AI_Service SHALL 调用 LLM（OpenAI 兼容 chat.completions，`response_format = json_object`），要求模型仅基于上下文作答并标注 `[n]` 引用编号
9. THE AI_Service SHALL 将模型返回的 `citedSourceIds` 同时按"真实帖子 id"与"上下文编号 n"两种语义解析，并去重为最终引用帖子集合
10. THE AI_Service SHALL 以 `ai:ask:<sha1(question.toLowerCase()).slice(0,16)>` 作为问题缓存键，缓存结果 1 小时；缓存命中时响应附 `cached = true`，不消耗配额
11. WHEN 调用成功，THE AI_Service SHALL 返回 `{ question, answer, hasAnswer, citations, candidates, model, elapsedMs, usage, cached, quotaUsed, quotaLimit }`
12. IF 模型调用失败，THEN THE AI_Service SHALL 返回 HTTP 502 与业务码 5001 与提示"AI 调用失败：<原因>"
13. WHERE 站内无相关帖子，THE Community_Platform 前端 SHALL 引导用户去对应板块发帖，并把当前问题预填到发帖标题

### Requirement 19: AI 站内问答 - 流式（SSE）

**User Story:** 作为用户，我希望问答以流式打字机效果呈现，并可以中途中断。

#### Acceptance Criteria

1. WHEN 已通过 JWT 鉴权的请求调用 `POST /api/ai/ask/stream` 且同时满足 `aiAskEnabled = true`、`question` 为字符串且 trim 后非空且长度 ≤ 500、Moderation_Service 对 `question` 未命中 `block` 策略、当日已用配额 < `aiAskPerUserDailyLimit`（或 `aiAskPerUserDailyLimit ≤ 0` 视为不限），THE AI_Service SHALL 以 HTTP 200 建立 SSE 响应，设置响应头 `Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`Connection: keep-alive`、`X-Accel-Buffering: no`，并按 SSE 协议输出帧，每帧形如 `data: {"type":"meta"|"delta"|"done"|"error","payload":{...}}\n\n`，相邻帧之间以两个换行 `\n\n` 分隔
2. IF `POST /api/ai/ask/stream` 的任一前置检查未通过，THEN THE AI_Service SHALL 在建立 SSE 流之前以对应 HTTP 错误直接响应、不发送任何 SSE 帧、不增加配额计数：`question` 缺失 / 非字符串 / trim 后为空 / 长度 > 500 → HTTP 400；`aiAskEnabled = false` → HTTP 403 + 业务码 4003；命中敏感词 `block` 策略 → HTTP 400 + 业务码 4001；当日已用 ≥ `aiAskPerUserDailyLimit` 且 `aiAskPerUserDailyLimit > 0` → HTTP 429 + 业务码 4004
3. WHEN SSE 流建立后第一次向响应写入，THE AI_Service SHALL 发送且仅发送一帧 `meta`，`payload` 包含 `{ question: string, candidates: array, quotaUsed: number, quotaLimit: number }`，且 `meta` 帧必须先于任何 `delta` / `done` / `error` 帧出现
4. WHEN 模型返回流式 token 增量，THE AI_Service SHALL 发送一帧 `delta`，`payload.text` 为本次增量的 UTF-8 字符串；一次问答中允许出现零至多帧 `delta`
5. WHEN 模型完成正常输出（无异常、非客户端中断），THE AI_Service SHALL 发送且仅发送一帧 `done`，`payload` 包含 `{ hasAnswer: boolean, citations: array, usage: object, full: string }`，`done` 必须在所有 `delta` 帧之后，且发送后立即关闭连接
6. THE AI_Service SHALL 通过对 `full` 文本应用正则 `\[(\d{1,2})\]` 收集引用编号 n，仅保留满足 `1 ≤ n ≤ candidates.length` 的编号、按首次出现顺序去重，并映射回 `candidates[n-1]` 的真实帖子 id 形成 `citedSourceIds`；越界或非法编号被忽略，且 `done.payload.citations` 中元素顺序与 `citedSourceIds` 保持一致
7. IF 模型调用或上游响应过程中发生异常（含 `AI_TIMEOUT_MS` 超时、网络错误、上游返回非法负载），THEN THE AI_Service SHALL 发送且仅发送一帧 `error`，`payload.message` 为长度 ≤ 500 字的中文原因文案，不包含堆栈、密钥或上游 URL，随后立即关闭连接；`error` 帧出现后不得再发送 `delta` 或 `done` 帧
8. WHEN 召回非空且 AI_Service 即将向 LLM 发起首次请求，THE AI_Service SHALL 在该次请求之前将该用户当日 `aiAskPerUserDailyLimit` 配额计数 `+1`，并与非流式 `POST /api/ai/ask` 共享同一配额池；WHERE 召回为空（参见 #9）或请求被 #2 的前置检查拒绝，THE AI_Service SHALL 不增加该计数；WHERE 计数已 `+1` 后发生 `error` 帧或客户端中断，THE AI_Service SHALL 不回滚该次计数
9. WHERE `Search_Service.searchForRAG` 召回的候选帖子数为 0，THE AI_Service SHALL 不调用模型，依次发送：一帧 `meta`（`candidates = []`、`quotaUsed` / `quotaLimit` 反映尚未 `+1` 的当前状态）、一帧 `delta`（`payload.text` 为长度 ≤ 200 字的中文引导文案）、一帧 `done`（`hasAnswer = false`、`citations = []`、`usage = {}`、`full` 等于该引导文案），随后关闭连接，且不增加配额计数
10. WHEN 客户端关闭 EventSource 或取消 fetch reader 导致连接断开，THE AI_Service SHALL 在下一次向响应流写入时检测到连接关闭，停止后续 `delta` 输出与上游模型读取，且不再发送任何 `done` 或 `error` 帧；此后若已对该次请求 `+1` 配额则保持不回滚

### Requirement 20: AI 写作助手

**User Story:** 作为作者，我希望写帖时一键改写标题、生成摘要、解释代码片段，提高产出效率。

#### Acceptance Criteria

1. WHERE `aiAssistEnabled = false`，THE AI_Service SHALL 在 `POST /api/ai/assist` 返回 HTTP 403 与业务码 4003
2. WHEN `aiAssistPerUserDailyLimit > 0` 且当日已用 ≥ 上限，THE AI_Service SHALL 返回 HTTP 429 与业务码 4004
3. THE AI_Service SHALL 仅接受 `kind ∈ {title, summary, explainCode}`，其它取值返回 HTTP 400
4. WHEN `kind = 'title'`，THE AI_Service SHALL 基于 `title + content` 生成 3-5 个候选标题，每个 ≤ 30 字
5. WHEN `kind = 'summary'`，THE AI_Service SHALL 基于 `title + content` 生成 1-2 句中文摘要，长度 ≤ 120 字
6. WHEN `kind = 'explainCode'`，THE AI_Service SHALL 基于 `snippet + language` 返回 `{ explanation, risks[], suggestions[] }`
7. WHEN 调用成功，THE AI_Service SHALL 将该用户当日配额计数 `+1` 并在响应中返回 `{ kind, ...result, quotaUsed, quotaLimit }`
8. IF 模型调用失败，THEN THE AI_Service SHALL 返回 HTTP 502 与业务码 5001

### Requirement 21: 系统设置与 AI 状态自检

**User Story:** 作为管理员，我希望在后台开关 AI 各项功能与配额，并能一键测试 AI 服务连通性。

#### Acceptance Criteria

1. WHEN 管理员调用 `GET /api/admin/settings`，THE Setting_Service SHALL 返回所有设置项 `{ key, value, defaultValue, description }` 与 AI 状态卡片 `{ provider, model, apiKeyConfigured }`
2. THE Setting_Service SHALL 维护以下默认设置项：`aiAuditEnabled`(true) / `aiExplainEnabled`(true) / `aiExplainPerUserDailyLimit`(30) / `aiAskEnabled`(true) / `aiAskPerUserDailyLimit`(50) / `aiAssistEnabled`(true) / `aiAssistPerUserDailyLimit`(100)
3. WHEN 管理员调用 `PUT /api/admin/settings`，THE Setting_Service SHALL 仅接受 `DEFAULTS` 中已声明的 `key`，其它返回 HTTP 400 与提示"未知的系统设置项"
4. THE Setting_Service SHALL 将 `value` 序列化为 JSON 存入 `SystemSetting.value`，并仅在写入成功（HTTP 200）后 `invalidate()` 内存缓存；写入失败时不得清除缓存
5. THE Admin_Console 前端 SHALL 对 boolean 类型设置使用 Switch、对 number 类型设置使用 InputNumber 控件
6. WHEN 管理员调用 `POST /api/admin/ai/test`，THE Setting_Service SHALL 用 `{ title, content }`（缺省值为内置正常样本）调用 `AI_Service.auditContent` 并返回 `{ provider, model, apiKeyConfigured, elapsedMs, result }`
7. IF AI 测试调用抛出异常，THEN THE Setting_Service SHALL 返回 HTTP 500 与业务码 500 与"AI 调用失败：<原因>"
8. THE Setting_Service SHALL 仅在 `settings.set` 写入成功后写入 Audit_Log（`action = 'setting.update'`）；写入失败（如 `key` 非法）时不得记录该 audit，但 `controller` SHALL 返回相应业务错误（HTTP 400）以便排查

### Requirement 22: 管理后台总览与审计

**User Story:** 作为管理员，我希望看到关键运营指标、所有敏感操作的留痕，便于快速决策与回溯。

#### Acceptance Criteria

1. WHEN 管理员调用 `GET /api/admin/stats`，THE Admin_Console SHALL 返回 `{ users, posts, comments, categories, pendingReports }`，其中 `posts` 仅统计 `status = 'published'`、`comments` 仅统计 `status = 'active'`、`pendingReports` 仅统计 `status = 'pending'`
2. WHEN 管理员调用 `GET /api/admin/users` 携带 `keyword`，THE Admin_Console SHALL 在 `name`、`empNo`、`department` 三个字段做 OR `LIKE` 匹配，按 `id ASC` 分页
3. THE Admin_Console SHALL 对返回的用户数据排除 `passwordHash` 字段
4. WHEN 管理员调用 `GET /api/admin/audit-logs`，THE Audit_Log SHALL 返回按 `createdAt DESC` 分页的记录，并附 `operator` 简要信息
5. THE Community_Platform SHALL 在以下事件写入 Audit_Log：`post.create / post.update / post.delete / post.pin / post.feature / post.block / post.rejected_by_ai / comment.delete / category.create / category.update / category.delete / report.create / report.block / report.reject / user.update / setting.update`

### Requirement 23: 性能、安全与可用性

**User Story:** 作为运营方，我希望平台在正常负载下稳定、安全、响应迅速。

#### Acceptance Criteria

1. THE Community_Platform SHALL 使核心页面（首页、帖子详情、个人中心）在标准网络下端到端响应时间不超过 2000ms
2. THE Community_Platform SHALL 使全文搜索（`GET /api/posts?keyword=...`）在标准网络下端到端响应时间不超过 3000ms
3. THE Community_Platform SHALL 在 500 并发在线用户场景下保持服务可用
4. THE Community_Platform SHALL 全年可用率不低于 99.5%
5. THE Community_Platform SHALL 在所有非 `/api/auth/*`（除 `/auth/me`）与非 `/api/categories`、非 `/api/posts` 列表 / 详情之外的接口上强制 JWT 鉴权
6. THE Community_Platform SHALL 通过 `helmet`、`cors`、`sanitize-html` 抵御 XSS 与常见 Web 头部攻击
7. THE Community_Platform SHALL 通过 Sequelize 参数化查询防止 SQL 注入
8. THE Community_Platform SHALL 在 `/api/*` 上启用速率限制：默认每 IP 每分钟 600 次请求，超出时返回 HTTP 429
9. THE Community_Platform SHALL 在 `express.json` 上限制请求体 5MB
10. THE Community_Platform SHALL 在文件上传上启用扩展名白名单与单文件大小限制
11. THE Community_Platform SHALL 在 AI 调用上设置 `AI_TIMEOUT_MS` 超时，避免长时间挂起占用连接

### Requirement 24: 兼容性与响应式

**User Story:** 作为员工，我希望在 PC 浏览器与手机浏览器中都能流畅使用社区。

#### Acceptance Criteria

1. THE Community_Platform 前端 SHALL 兼容主流现代浏览器（Chrome / Edge / Firefox / Safari 最近两个大版本）
2. THE Community_Platform 前端 SHALL 同时适配桌面（PC）与移动端（H5）布局
3. THE Community_Platform 前端 SHALL 在富文本编辑器中兼容中文输入法（IME）的 `compositionstart / compositionend` 事件，避免在拼音过程中误触发提交或字符抖动
4. THE Community_Platform 前端 SHALL 在帖子详情中对代码块启用语法高亮、对图片启用懒加载

### Requirement 25: 缓存与降级

**User Story:** 作为运维方，我希望 Redis 不可用时平台仍能工作，AI 不可用时业务仍能继续。

#### Acceptance Criteria

1. WHERE `REDIS_URL` 已配置，THE Cache_Service SHALL 使用 Redis 作为后端
2. WHERE `REDIS_URL` 未配置或连接失败，THE Cache_Service SHALL 自动降级到进程内内存缓存
3. WHERE AI provider 未配置或调用失败，THE AI_Service SHALL 在内容审核场景降级到本地 `RISK_KEYWORDS` 规则，并保证业务接口不阻断
4. WHERE AI provider 未配置，THE AI_Service SHALL 在 `explain / ask / assist` 场景抛出"AI provider 未配置"，由控制器返回 HTTP 502 与业务码 5001

### Requirement 26: 数据存储与启动同步

**User Story:** 作为开发者，我希望使用 MySQL 做主存储，并能在迭代期间增量同步表结构。

#### Acceptance Criteria

1. THE Community_Platform SHALL 默认使用 MySQL 8 作为主存储，通过 Sequelize 模型层访问
2. WHEN 后端启动且 `DB_SYNC_ALTER` 未设置，THE Community_Platform SHALL 仅执行 `sequelize.sync()`，不修改已有表结构
3. WHEN 后端启动且 `DB_SYNC_ALTER = '1'`，THE Community_Platform SHALL 执行一次 `sequelize.sync({ alter: true })` 以增量对齐表结构
4. THE Community_Platform SHALL 通过 docker compose 提供 MySQL 与 Redis 的开发依赖编排

### Requirement 27: 技术栈与协议约束

**User Story:** 作为团队，我希望明确技术栈与对外协议，使二次开发与对接稳定。

#### Acceptance Criteria

1. THE Community_Platform 后端 SHALL 使用 Node.js + Express + Sequelize + JWT + Redis + multer + sanitize-html
2. THE Community_Platform 前端 SHALL 使用 React 18 + Vite + Ant Design 5 + Zustand + React Router v6
3. THE AI_Service SHALL 通过 OpenAI 兼容协议 `POST {AI_BASE_URL}/v1/chat/completions` 调用 DeepSeek，固定 `response_format = json_object`，流式接口 `stream = true`
4. THE Community_Platform SHALL 以 `{ code, message, data }` 统一响应结构对外提供 API；成功时 `code = 0`，失败时 `code` 与 HTTP 状态码可能不一致（业务错误码见错误码约定）

