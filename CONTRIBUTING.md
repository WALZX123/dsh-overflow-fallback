# 贡献指南

## 这个项目刻意保持的样子

- **零运行时依赖**：`dependencies` 永远是空的。提交引入依赖的 PR 需要先讨论。
- **无构建步骤**：`lib/` 就是源码也是发布物。改代码不用编译。
- **能力面写死**：不新增网络、文件、子进程调用。`test/verify-install.mjs` 会对这些做静态断言。

这三条是供应链可审查性的来源，不是风格偏好。

## 开发流程

```powershell
node test/decide.test.mjs
node test/plugin.test.mjs
node test/handoff.test.mjs
node test/service.test.mjs
node test/revive.test.mjs
node test/verify-install.mjs
```

改完代码要它在本机生效，有两种方式：

1. 在 DSH 里敲 `/reload`（本插件提供），走官方 HMR 重载；
2. 重启 DSH。

**新增行为必须带测试**，且优先写成纯函数：

- `lib/decide.js`、`lib/handoff.js` 不依赖 Cordis，可直接单测；
- 需要 `ctx` 的行为，用 `test/plugin.test.mjs` 里的假上下文；
- 涉及真实会话的行为，写清楚在 PR 里是怎么手测的（真机日志片段）。

## 真实数据形状优先

和 DSH 的边界（事件、会话头、消息块）以源码为准，不要按直觉写。我们已经踩过三次同类错误：

| 字段 | 真实形状 |
|---|---|
| 会话工作目录 | `session.header.cwd`（顶层，不是 `meta.cwd`） |
| 用户消息 | `user/message` 的 `data` 就是 `UserMessage`：`{ content, source }` |
| 助手消息 | `assistant/message` 的 `data.message.content` 才是正文块 |

改动这些解析时，请同时加一条"真实形状"的回归测试。

## 文档约定

- 面向模型的文本（工具名、描述、参数说明）用英文；
- 面向人的文档用中文，关键结论写进 README 而不是只写进 docs/；
- 安全相关的声明必须与代码一致：新增能力时同步更新 `SECURITY.md` 的代价清单。

## 提交信息

```
type(scope): summary

- 做了什么
- 为什么

验证：跑了哪些测试 / 真机怎么验的
```

## 发布前

完整版本路线与发布流程见 [docs/RELEASING.md](docs/RELEASING.md)。摘要：

1. 全量测试通过；
2. `npm pack --dry-run` 检查发布载荷（CI 会跑）；
3. 更新 `CHANGELOG.md`（按 新增 / 修复 / 加固 / 工程 分组）；
4. 确认 `SECURITY.md` 的能力表与代码一致；
5. 确认 `package.json` 的 `files` 覆盖所有运行时文件。
