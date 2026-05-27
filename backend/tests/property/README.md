# 属性测试目录 (`tests/property/`)

本目录存放基于 [`fast-check`](https://github.com/dubzzz/fast-check) 的属性测试，对应 [design.md](../../../.kiro/specs/tech-community-platform/design.md) 中列出的 36 条 Correctness Properties（P01 ~ P36）。

运行命令：

```bash
npm run test:property
```

底层使用 Node 内建的 `node:test` + `node:assert`，每条属性默认 ≥ 100 次迭代。

## 命名规范

- 每条属性对应**一个**测试文件，文件名形如 `PXX-<short-name>.test.js`：
  - `XX` 为属性编号，使用两位数（不足补零），如 `P01`、`P15`、`P36`
  - `<short-name>` 为短横线分隔的小写描述，限定 ≤ 6 个单词
  - 例如：
    - `P01-no-password-hash-leak.test.js`
    - `P15-ai-audit-status-mapping.test.js`
    - `P24-sse-frame-protocol.test.js`
    - `P36-response-envelope.test.js`
- 文件顶部注释**必须**引用对应的 Property 编号、设计文档章节与所验证的 Requirements，便于回溯：

  ```js
  // Property 15: AI 审核状态映射
  // See: .kiro/specs/tech-community-platform/design.md (Correctness Properties)
  // Validates: Requirements 5.6, 5.9, 8.7, 8.8, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.11
  ```

- 一个属性涉及多个子场景时，仍合并到同一文件，通过多个 `test('...')` 块分组；不要拆成 `P15a-...` / `P15b-...`。

## 公共脚手架

- `_setup.js`：内存 SQLite Sequelize 实例、表截断、AI mock server 注入、`Cache_Service` 切换 Redis-mock 等公共 helpers。
- `_arbitraries.js`：合法 / 非法用户、合法 / 含敏感词文本、富文本、SSE 帧序列等常用 fast-check 生成器。

下划线开头的文件**不会**被视作属性测试文件（`PXX-*.test.js` 模式不命中），不会被 `npm run test:property` 直接执行。

## 写法约定

- 每条属性**至少 100 次迭代**：

  ```js
  fc.assert(
    fc.property(arb1, arb2, (a, b) => {
      // 断言
    }),
    { numRuns: 100 }
  );
  ```

- 属性测试**只允许**断言对应 Property 描述的不变量，不引入额外断言；如发现需要新属性，请先在 `design.md` 中扩充 Property 编号再补测试。
- 优先零 mock。需要 AI / Redis 时通过 `_setup.js` 注入受控 mock，禁止在测试中直接读写真实外部服务。
- AI 相关属性（P15、P21、P22、P23、P24、P25、P26、P30）通过劫持 `AI_BASE_URL` 注入可控 mock 响应。
- 缓存等价测试（P29）同时启动 `ioredis-mock` 与内存后端，断言外部行为一致。

## 运行

```bash
# 运行全部属性测试
npm run test:property

# 运行单个属性
node --test tests/property/P15-ai-audit-status-mapping.test.js
```
