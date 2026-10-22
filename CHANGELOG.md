# Changelog

版本策略：`0.1.x` 兜底、`0.2.x` 交接包、`0.3.x` 续命与服务契约、`0.4.x` 可回查，是同一开发周期内的四个里程碑；
**首个对外发布从 0.4.0 开始**，0.1–0.3 未单独发布。后续计划见 [docs/RELEASING.md](docs/RELEASING.md)。

## [0.4.0] — 2026-10-22 · 首个公开发布

- 新增模型工具 `recall_original`：按序号或交接包锚点（`T3@seq42`）回读原会话片段，只读，补齐"有损交接 + 可回查"的闭环。
- 服务与工具共用同一套切片逻辑（`sliceEvents`），单次最多 200 条；默认条数由 `recallLimit` 配置（1–200，默认 50）。
- 工程：工具与命令的注册拆到 `lib/tools.js`，`lib/index.js` 只做装配；工具抛出的错误带稳定 `code`（`no-parent`、`parent-not-loaded`、`no-session`、`already-revived`）。
- 其余能力沿用 0.3.0；首个公开发布选 0.4.0，是因为它包含回查能力。

## [0.3.0] — 2026-10-22 · 开发期里程碑：续命

### 新增

- 模型工具 `revive_session`：把无法再发请求的会话续到一个新会话，返回新会话 id 与带过去的条数。
- 配置 `revive: off | manual | auto`（默认 `manual`）：`manual` 只注册工具与服务方法；`auto` 在重试次数用尽后自动续命；子代理会话不续命。
- `lib/revive.js`：续命执行器。用 `ctx.agents.create()` 在**同一工作目录、继承原会话 provider/model** 下新建 agent；交接包经 `agent.followup()` 作为第一条真实消息发出，`followup` 被拒时回退到 `agent.inject()`。
- 配置 `kickoff`（默认 `true`）：续命时立即跑起第一轮，使交接包落盘、会话出现在列表；设为 `false` 则只排队上下文（会话会是空的，列表里看不到）。
- `/reload` 命令与 `reload_plugins` 工具：调用官方 `ctx.hmr.reconcileProfile()` 原地重载改动过的插件，不重启 desktop、不创建/杀死进程。
- 服务新增 `reviveFor(session, opts)`：供其它插件手动触发续命。
- 服务新增 `recall(session, { from, to })`：按序号回读原会话片段，配合交接包锚点使用。

### 修复（开发期真机验证发现）

- 会话头的 `cwd` 是顶层字段（`header.cwd`），此前只读 `header.meta.cwd`，导致续命会话落进 `_no-cwd`。
- `user/message` 的 data 直接是 `UserMessage`（`{ content, source }`），此前按 `{ message }` 读取，导致交接包"带过去 0 条"。
- `assistant/message` 的正文在 `data.message.content` 块里，此前只认 `text` 字段，导致"结论 0 条"。
- 工具注册改用 `ctx.inject(['tools'])` 等待式注册；此前读拓扑敏感的 `ctx.tools`，未声明注入时为 `undefined`，工具被静默跳过。
- 续命会话此前未登记到工作区（`ctx.agents.create()` 不写 `workspace.sessionIds`），现在创建后调用 `workspace.attachSession()`；失败只记警告，不丢会话。
- 轮次锚点改为按人工提问顺序生成（`T1@seq7`），不再依赖事件里并不存在的 `turn` 字段。

### 加固

- 交接包只收集 `type: "text"` 的正文块，不再把 reasoning 块当正文（避免泄露思维链、撑大体积）。
- 同一会话只能续命一次；手动工具与自动续命共用同一份去重集合，失败时释放，允许重试。
- 工作区挂接在"原会话所属工作区"找不到时，回退到路径等于会话 cwd 的工作区。
- 安全文档更正：插件会创建会话（由宿主持久化）并可能发起一轮模型请求；`/reload` 的作用域是整个 profile。`SECURITY.md` 与 README 改为逐项能力与代价说明。

### 工程

- 新增 `.editorconfig`、`CONTRIBUTING.md`、`docs/RELEASING.md`。
- CI：Node 20/22/24 全量测试 + `npm pack --dry-run` 载荷校验。
- 测试 69 个，覆盖决策、插件契约、交接包、服务、续命执行器。

## [0.2.0] — 2026-10-22 · 开发期里程碑：交接包

- `lib/handoff.js`：把会话事件整理成一份有上界（6000 字符）的交接包，纯函数、零模型调用、零 I/O。
- 交接包包含「你要继续的事」「最后的结论」「动过的东西」「原文在哪」「接着做」五节；「原文在哪」给出原会话 ID 与 `T<轮次>@seq<序号>` 锚点。
- `lib/service.js`：注册 `overflowFallback` 宿主服务，供其它插件生成交接包、判断溢出失败；并在 `dshhub.capabilities.provides` 中声明。
- `docs/SERVICE.md`：联动契约、稳定/可变部分、版本策略、失败语义。
- `docs/REVIVE.md`：续命的目标、技术路径、接线前必须验证的五项。

## [0.1.0] — 2026-10-22 · 开发期里程碑：溢出兜底

- 监听 `agent/request-error`，只在失败码为 `CONTEXT_WINDOW_EXCEEDED` 时介入。
- 先让内置与其它策略表态；下游已给出决定时不重复处理。
- 调用 `ctx.compaction.compactIfNeeded(agent, 'context-overflow', signal)` 强制再压一次。
- 只有压缩真的产出结果才返回 `{ kind: 'retry' }`；没有可压缩区间时老实放弃。
- 每个 agent 的重试次数有上界（`maxAttempts`，默认 2），按 agent 记录在 `WeakMap`。
- 配置错误在装载期抛错；运行期异常记警告。
- 零运行时依赖、无网络、无文件、无子进程；`test/verify-install.mjs` 做能力面静态断言。
- 宿主层兼容：`next()` 优先、压缩后端可替换/可缺失、异常降级为警告。
- 载荷自检：缺少可用 agent 或取消信号时不做任何处理。
