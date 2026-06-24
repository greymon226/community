# 代码审核报告 — 第二轮复审

> **审核时间**: 2026-06-24 10:56  
> **变更规模**: 21 个修改文件 + 7 个新增文件（含 `docs/`），净增 ~404 行

---

## 一、上轮问题修复情况

| # | 问题 | 状态 | 说明 |
|---|------|------|------|
| #4 | MCP API Key 时序安全比较 | ✅ **已修复** | 新增 `safeEqual()` 使用 `crypto.timingSafeEqual`，实现正确 |
| #7 | `cleanPlainText(question)` 重复调用 | ✅ **已修复** | 提到 `map` 外面改为 `normalizedQuestion`，变量名清晰 |
| #8 | TrendChart 无数据空态 | ✅ **已修复** | `data.length === 0` 时返回 `<Empty description="暂无趋势数据" />` |
| #9 | `Space` 组件导入 | ✅ **已确认** | 第 3 行 import 中包含 `Space` |
| #10 | RatioBar `total=0` 空态 | ✅ **已修复** | `if (!total)` 时返回 `<Empty description="暂无治理数据" />` |
| #1 | 配额预占失败未回退 | ❌ 未修复 | `aiController.js` diff 与上轮完全一致，无 `decr` 回退 |
| #2 | `cacheService` 缺少 `decr` | ❌ 未修复 | 导出列表仍为 `{ init, get, set, del, incr }` |
| #3 | `quotaUsed` 语义不一致 | ❌ 未修复 | SSE meta 发 `quota.used`（预占后），缓存存 `quota.used - 1`（预占前） |
| #5 | CORS `*` 与 Auth Header | ❌ 未修复 | 保持现状可接受（MCP 面向服务端调用） |
| #6 | 两次 findAll 性能 | ❌ 未修复 | 低优先级，当前数据量不大 |
| #11 | E2E 测试间共享数据库 | ❌ 未修复 | 低优先级，`workers:1` 已缓解 |
| #12 | 搜索断言依赖 seed 数据 | ❌ 未修复 | 低优先级 |
| #13 | AI 按钮 disabled 断言 | ❌ 未修复 | 低优先级 |

> **小结**：5 个问题已修复（#4、#7、#8、#9、#10），8 个未修复。其中 **#4（时序安全）** 是上轮最有安全价值的修复，做得好。

---

## 二、修复代码质量审核

### 2.1 `safeEqual` 实现 ✅

```js
function safeEqual(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string') return false;
  const inputBytes = Buffer.from(input);
  const expectedBytes = Buffer.from(expected);
  if (inputBytes.length !== expectedBytes.length) return false;
  return crypto.timingSafeEqual(inputBytes, expectedBytes);
}
```

- 类型检查 → 长度检查 → `timingSafeEqual`，流程正确
- 注意：长度不等时直接 `return false` 会泄露长度信息，但这在 API Key 场景中可接受（攻击者无法利用长度差异推断 key 内容）

### 2.2 `normalizedQuestion` 提取 ✅

```js
const normalizedQuestion = cleanPlainText(question).toLowerCase();
```

- 提到 `map` 外面，避免 N 次重复调用
- 后续使用 `normalizedQuestion` 替代 `q`，变量名更清晰

### 2.3 `TrendChart` / `RatioBar` 空态 ✅

- `TrendChart`: `if (!data || data.length === 0)` → `<Empty />`
- `RatioBar`: `if (!total)` → `<Empty />`
- 注意 `Empty` 使用了 `Empty.PRESENTED_IMAGE_SIMPLE`，但 **antd 的 `Empty` 未在 import 中引入**

---

## 三、新发现的问题

> [!WARNING]
> **问题 14 — `Empty` 组件未导入**
>
> [AdminPage.jsx](file:///d:/YXB/code/community/frontend/src/pages/AdminPage.jsx) 第 551 行和第 610 行使用了 `<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />`，但第 2-4 行的 antd import 中没有 `Empty`：
> ```js
> import {
>   Card, Tabs, Statistic, Row, Col, Table, Tag, Button, Space, Input,
>   Select, Modal, Form, App, Popconfirm, Switch, InputNumber,
> } from 'antd';
> ```
> 缺少 `Empty`。**这会导致运行时报错**（`Empty is not defined`）。需要在 import 中添加 `Empty`。

> [!NOTE]
> **问题 15 — `docs/code_review.md` 是上轮审核报告的副本**
>
> 新增的 `docs/code_review.md` 内容是上一轮审核报告的全文拷贝。如果这是有意保留的审核记录则无需处理；如果是误操作，建议从提交中排除或 `.gitignore` 掉。

---

## 四、仍需关注的核心问题

### #1（🔴 中等）— 配额预占失败未回退

这是上轮唯一标记为 **必须修复** 的问题，本轮未修复。三个 AI 接口（`ask`、`askStream`、`assist`）均存在：

```
reserveDailyQuota  →  配额 +1
     ↓
AI 调用失败（502/超时）
     ↓
用户白扣一次配额 ❌
```

**修复建议**：

1. 在 `cacheService` 添加 `decr` 方法：
```js
async function decr(key) {
  if (client) {
    try { return await client.decr(key); } catch (err) { fallbackToMemory(err); }
  }
  const entry = memoryStore.get(key);
  if (entry && (!entry.expireAt || entry.expireAt >= Date.now())) {
    entry.value = Math.max(0, (Number(entry.value) || 0) - 1);
    return entry.value;
  }
  return 0;
}
```

2. 在 `aiController.js` 各 catch 分支添加回退：
```js
// ask() 的 catch 分支
} catch (e) {
  await cache.decr(quotaKey);  // 回退配额
  return fail(res, `AI 调用失败：${e.message}`, 5001, 502);
}
```

### #3（🟡 低）— `quotaUsed` 语义不一致

| 位置 | 发送值 | 含义 |
|------|--------|------|
| SSE `meta` 帧 | `quota.used` | 预占后（即本次请求算在内） |
| 缓存 payload `used` | `quota.used - 1` | 预占前（不算本次） |
| `assist` 返回 | `quota.used` | 预占后 |

前端展示"已用 X/Y"时，语义不统一会让用户困惑。建议：
- `reserveDailyQuota` 返回 `{ allowed, before: used - 1, after: used, limit }`
- 所有输出统一使用 `after`（即含本次的已用量）

---

## 五、问题汇总（更新版）

| # | 严重程度 | 状态 | 描述 |
|---|---------|------|------|
| #1 | 🔴 中 | ❌ 未修复 | 配额预占后 AI 调用失败未回退计数 |
| #2 | 🟡 低 | ❌ 未修复 | `cacheService` 缺少 `decr` 方法 |
| #3 | 🟡 低 | ❌ 未修复 | `quotaUsed` 语义不一致 |
| #4 | 🟡 低 | ✅ 已修复 | API Key 改用 `timingSafeEqual` |
| #5 | ⚪ 建议 | ⏭️ 保留 | CORS `*` 与 Auth（服务端调用不影响） |
| #6 | 🟡 低 | ⏭️ 保留 | 两次 findAll + LIKE 性能待观察 |
| #7 | ⚪ 建议 | ✅ 已修复 | `normalizedQuestion` 提到循环外 |
| #8 | ⚪ 建议 | ✅ 已修复 | TrendChart 空态 `<Empty />` |
| #9 | ⚪ 建议 | ✅ 已确认 | `Space` 已在 import 中 |
| #10 | ⚪ 建议 | ✅ 已修复 | RatioBar 空态 `<Empty />` |
| #11 | 🟡 低 | ⏭️ 保留 | E2E 测试间共享数据库 |
| #12 | ⚪ 建议 | ⏭️ 保留 | 搜索断言依赖 seed 数据 |
| #13 | ⚪ 建议 | ⏭️ 保留 | AI 按钮 disabled 断言 |
| **#14** | **🔴 中** | **🆕 新发现** | **`Empty` 组件未 import（运行时报错）** |
| #15 | ⚪ 建议 | 🆕 新发现 | `docs/code_review.md` 是否需要提交 |

---

## 六、总体评价

**整体质量 ★★★★½** — 比上轮有所提升。`timingSafeEqual` 和空态处理的修复质量很好。

**提交前必须处理**：
1. **#14** — `Empty` 组件未导入，TrendChart/RatioBar 的空态分支会直接报错
2. **#1** — 配额回退（风险：AI 服务故障期间用户配额被无效消耗）

**建议处理**：
- #3 — 统一 `quotaUsed` 语义

其余为低优先级优化，不阻塞提交。
