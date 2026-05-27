# Property-Based Testing 全景表

> 运行：`cd backend && npm run test:property`
> 框架：`fast-check` (PBT) + `node:test`
> 每条 ≥ 100 次随机迭代

| Property | 文件 | 关联需求 | 守护语义 | 状态 |
| --- | --- | --- | --- | --- |
| P02 | `P02-jwt-401-consistency.test.js` | R1.9, R1.10, R1.11, R23.5 | 受保护接口对伪造/过期 token 一致 401 | ✅ |
| P03 | `P03-role-permission-matrix.test.js` | R2.2–R2.6, R4.7, R5.8, R8.11, R14.6 | 角色权限矩阵纯函数 | ✅ |
| P04 | `P04-login-anti-enumeration.test.js` | R1.4 | 登录失败反枚举一致性 | ✅ |
| P05 | `P05-input-validation-before-side-effects.test.js` | R1.3, R2.7–9, R3.3–5, R5.1... | 入参校验先于副作用 | ✅ |
| P06 | `P06-sanitize-bypass.test.js` | R3.5, R5.2, R5.3, R8.5, R23.6 | XSS 清洗不可绕过 | ✅ |
| P07 | `P07-techtags-normalization.test.js` | R3.3, R3.5 | techTags 归一化不变量 | ✅ |
| P08 | `P08-post-tags.test.js` | R6.1–6.4 | 帖子标签集合不变量 | ✅ |
| P09 | `P09-category-tree.test.js` | R4.1, R4.2, R4.6, R4.8 | 分类树最多两级 | ✅ |
| P10 | `P10-post-visibility.test.js` | R5.11, R5.12, R17.2, R17.3 | 帖子可见性谓词 | ✅ |
| P11 | `P11-search-sort-pagination.test.js` | R7.1–R7.9 | 搜索/排序/分页不变量 | ✅ |
| P12 | `P12-rag-recall-invariants.test.js` | R18.5, R18.6 | RAG 召回不变量 | ✅ |
| P13 | `P13-sensitive-words-strategy.test.js` | R11.2–R11.6 | 敏感词策略语义 | ✅ |
| P14 | `P14-sensitive-words-cache-eventual-consistency.test.js` | R11.8 | 敏感词缓存最终一致 | ✅ |
| P15 | `P15-ai-audit-status-mapping.test.js` | R5.6, R5.9, R12.1–12.6, R12.11 | AI 审核状态映射 | ✅ |
| P16 | `P16-like-favorite-counter-consistency.test.js` | R8.12, R9.1, R9.3 | 点赞/收藏计数一致性 | ✅ |
| P17 | `P17-like-notification-rising-edge.test.js` | R9.2 | 仅"未赞→已赞"产生通知 | ✅ |
| P18 | `P18-comment-count-invariant.test.js` | R8.7–R8.10 | commentCount 不变量 | ✅ |
| P23 | `P23-citation-parser.test.js` | R18.9, R19.6 | 引用编号解析纯函数性 | ✅ |
| P27 | `P27-system-settings-transactional-write.test.js` | R21.3, R21.4, R21.8 | 设置写入事务性 | ✅ |
| P28 | `P28-audit-log-exactly-once.test.js` | R22.5 | 审计日志恰一次 | ✅ |
| P29 | `P29-cache-backend-equivalence.test.js` | R25.1, R25.2 | 缓存后端等价性 | ✅ |
| P30 | `P30-ai-degradation-on-failure.test.js` | R12.9, R12.10, R25.3, R25.4, R19.7 | AI 失败稳定降级 | ✅ |
| P31 | `P31-protected-routes-jwt.test.js` | R23.5 | 受保护路由必须 JWT 鉴权 | ✅ |
| P32 | `P32-sql-injection-safety.test.js` | R23.7 | SQL 注入安全 | ✅ |
| P33 | `P33-upload-validation.test.js` | R10.1–R10.6, R23.10 | 文件上传双重校验 | ⚠️ 3 case 边界 |
| P34 | `P34-admin-stats-aggregation.test.js` | R22.1 | 管理后台统计聚合正确性 | ✅ |
| P35 | `P35-user-search-subset.test.js` | R22.2, R22.3 | 用户搜索子集语义 | ✅ |
| P36 | `P36-response-envelope.test.js` | R27.4 | 统一响应包络 | ✅ |
| P37 | `P37-prompt-injection-detection.test.js` | — (AI 安全扩展) | Prompt Injection 检测纯函数 | ✅ |

## 汇总

- **总条数**：29 个测试文件 / 147 个 test case
- **通过**：143 / 147（P33 的 3 个边界 case 待修）
- **每条最低迭代**：100 次（`fast-check` 默认 + 部分调至 200）
- **运行耗时**：~20 秒（本地 sqlite in-memory）

## 不在 PBT 范围的验证

| 维度 | 覆盖方式 |
| --- | --- |
| 性能 SLA | 负载测试（k6 / artillery） |
| 浏览器兼容性 | 人工冒烟 / BrowserStack |
| AI 模型语义质量 | 人工评测 + prompt 回归集 |
| 端到端流程 | `npm run test:e2e`（8 个黑盒用例） |
