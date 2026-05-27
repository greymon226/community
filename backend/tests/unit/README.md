# 单元测试目录 (`tests/unit/`)

本目录存放纯函数 / 模块级单元测试，运行命令：

```bash
npm run test:unit
```

底层使用 Node 内建的 `node:test` 与 `node:assert`（不引入第三方测试框架），以最小开销验证核心纯函数与模块行为。

## 命名规范

- 一律使用 `.test.js` 后缀，便于 `npm run test:unit` 通过 glob `tests/unit/**/*.test.js` 自动收集。
- 文件名形如 `<module>.test.js`，其中 `<module>` 与被测目标对应：
  - `sanitize.test.js` 测试 `src/utils/sanitize.js`
  - `searchService-tokenize.test.js` 测试 `searchService` 内部的 `tokenize` 等纯函数
  - `aiService-safeParseJSON.test.js` 测试 `aiService` 内部的 `safeParseJSON` 工具函数
- 同一模块若需要拆多个文件，使用 `<module>-<sub>.test.js`，避免单文件膨胀。

## 写法约定

- 顶部以注释列出被测对象与覆盖的需求编号，例如：

  ```js
  // Tests for src/utils/sanitize.js
  // Validates: Requirements 5.2, 5.3, 8.5
  ```

- 不引入数据库 / Redis / 网络依赖，全部在内存中完成；如需 mock，请使用 `node:test` 自带的 `mock` API 或在 `tests/property/_setup.js` 中暴露的辅助函数。
- 单个用例尽量小、断言尽量明确；不要在单元测试里塞集成测试。

## 运行

```bash
# 运行全部单元测试
npm run test:unit

# 运行单个文件
node --test tests/unit/sanitize.test.js
```
