# 安全策略

## 报告漏洞

请**不要**用公开 issue 报告安全问题。使用仓库的 **Security → Report a vulnerability**（GitHub Security Advisory），或直接联系维护者。我们会在 7 天内回应，并在修复发布后致谢（除非你要求匿名）。

## 支持范围

| 版本 | 支持 |
|---|---|
| 0.4.x | 是 |

## 威胁模型

DSH 插件以宿主进程的完整权限运行，没有独立沙箱。因此本插件的主张不是「它被沙箱住了」，而是**它申请的每一项能力都能在代码里逐条对上**。

### 本插件会做什么

| 能力 | 触发条件 | 影响 |
|---|---|---|
| 监听 `agent/request-error` | 始终 | 只读事件载荷 |
| 调用 `ctx.compaction.compactIfNeeded()` | 上下文超限且内置策略放弃 | 压缩会话历史（宿主能力） |
| **创建新会话** | `revive` 不为 `off` 且被显式触发 | 宿主会把新会话持久化到磁盘，并出现在会话列表 |
| **发起一轮模型请求** | `kickoff: true`（默认） | 新会话会立即用交接包跑第一轮，**消耗 token** |
| 注册 `/reload` 与 `reload_plugins` | 宿主提供 HMR | 重载 profile 中**所有**磁盘上发生变化且被引用的插件条目 |
| 读取父会话日志 | 调用 `recall_original` / 服务 `recall` | 只读 `snapshotEvents()`，不修改任何会话 |
| 注册 `overflowFallback` 服务 | 始终 | 其它插件可调用只读的交接包生成；`reviveFor` 会建会话 |

### 本插件不做、且代码里不应出现

- 直接调用 `fetch` / `http(s)` / `WebSocket`（插件自身不发网络请求；模型请求由宿主发出）；
- 直接读写文件、调用 `node:fs`；
- 创建子进程或 shell；
- 读取凭据或环境变量里的密钥；
- 直接 `session.append()` 改会话日志；模型可见内容只通过 `agent.inject()` / `agent.followup()` 这两条公开通道写入；
- `eval` / `new Function` / 加载远程代码；
- 改写工具 schema、绕过审批。

`test/verify-install.mjs` 对 `lib/` 下每个文件做上述模式的静态断言，出现即发布检查失败。这是防回归的门槛，不是沙箱。

## 需要使用者知情的代价

1. **续命会花钱**：`kickoff: true` 时，新会话会立刻发一次模型请求。不想要这轮就设 `kickoff: false`（交接包退化为排队上下文，但会话不会出现在列表里，因为它是空的）。
2. **续命会落盘**：新会话由宿主持久化，和正常会话一样存在 `$DSH_HOME/sessions` 下，**不会**自动删除。原会话只读，不受影响。
3. **`/reload` 的作用域是整个 profile**，不只是本插件：它会重载所有磁盘上有变化、且被 loader 引用的条目。正在执行的回合可能被中断，调用前请确认。
4. **交接包包含原会话文本**：它只在本地生成、只写进新会话；插件不上传、不外发。若原会话含敏感内容，交接包同样含敏感内容。

## 供应链

- **零运行时依赖**：`package.json` 无 `dependencies`。安装不会引入任何第三方包。
- 无构建步骤：`lib/` 即发布物，可直接审阅（约 5 个文件、不到 700 行）。
- 发布文件由 `files` 白名单限定，`test/verify-install.mjs` 校验完整性。

## 给使用者的审查建议

1. `lib/handoff.js` 与 `lib/decide.js` 是纯函数，无 I/O，最容易读；
2. `lib/revive.js` 只看它调用了 `ctx.agents.create` / `agent.followup` / `agent.inject` 三个公开 API；
3. `lib/index.js` 是装配层：监听、配置、服务、工具注册；
4. 跑 `node test/verify-install.mjs`；
5. 升级时看 diff。

## 不承诺的事

- 不保证压缩一定成功：本插件只是多给一次机会，摘要质量归压缩后端。
- 不保证交接包完整：它是有损摘录，锚点可回查原会话。
- 不保证兼容未来 DSH 版本：DSH 处于开发者预览期，扩展点可能变更；失效时插件会明确报错，而不是静默改变行为。
