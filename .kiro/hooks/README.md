# Kiro Hooks — AI 嵌入研发流程

> 本目录下的 4 个 Hook 把 AI 从"工具"升级为"流程一部分"，是本项目"AI 原生"
> 区别于"AI 辅助"的硬指标。

## Hook 一览

| Hook 文件 | 触发时机 | 动作类型 | 目的 |
| --- | --- | --- | --- |
| `spec-sync-check.kiro.hook` | `fileEdited` — 三份 spec 任意一个保存 | askAgent | 提醒同步 Property 与实现 |
| `pbt-on-ai-change.kiro.hook` | `fileEdited` — AI 相关 service / controller 保存 | runCommand | 自动跑聚焦 PBT（P15/P23/P30/P37） |
| `secret-leak-guard.kiro.hook` | `preToolUse` — 任意 write 工具 | askAgent | 写文件前检查 API Key / 密码泄漏 |
| `post-task-test.kiro.hook` | `postTaskExecution` — 任务标记完成 | runCommand | 跑全量 unit + property |

## 设计哲学

### 1. 把"机械重复 + 容易遗忘"交给 Hook
- 改完 spec 忘记同步测试 → `spec-sync-check`
- 改完 aiService 没跑 PBT → `pbt-on-ai-change`
- 不小心把 .env 贴进代码 → `secret-leak-guard`
- 任务标完成但没跑测试 → `post-task-test`

### 2. 不打扰人类的工作流
- runCommand 类 hook 在后台跑，输出失败时才打断
- askAgent 类 hook 只在有真实问题时才打扰人

### 3. 与 37 条 Property 形成正反馈
- Hook 触发 PBT → PBT 抓到反例 → 修复 → spec 演进 → 新 Hook → 更稳的代码
- 每次 AI 改动都被 Property 守护，不可能引入"通过编译但破坏不变量"的回归

## 启用状态

4 个 Hook 默认 **已启用**（文件以 `.kiro.hook` 结尾），Kiro IDE 打开本仓库后
会在 Explorer → "Agent Hooks" 面板里自动识别并加载。

如需临时禁用某个 Hook，把对应文件重命名加上 `.disabled` 后缀即可：

```bash
# 临时关闭 secret-leak-guard
mv .kiro/hooks/secret-leak-guard.kiro.hook .kiro/hooks/secret-leak-guard.kiro.hook.disabled
```

如需新增 Hook：
- IDE 命令面板 → "Open Kiro Hook UI"
- 或直接在本目录下新建 `.kiro.hook` 配置文件（JSON Schema 见父 README 的 hooks 节）

## 与提交材料的对应关系

- **设计文档 §7.4**：AI 编排能力一节直接引用本目录
- **演示材料 §2.1**：作为 Kiro Spec 三段式的延伸 — 不仅是设计期 AI 协作，
  更是运行期 AI 持续守护
- **AI 协作过程实录 节点 8**：详述 4 个 Hook 各自的痛点 → 解决路径

## 验证 Hook 是否生效

最简单的方法：
1. 打开 `.kiro/specs/tech-community-platform/requirements.md`，加一行注释保存
2. 应该立即看到 IDE 触发 `spec-sync-check`，AI 输出差异清单
3. 编辑 `backend/src/services/aiService.js` 加个空格保存
4. 应该立即看到终端跑 P15/P23/P30/P37 的结果（< 5 秒）
