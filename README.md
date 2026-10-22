# dsh-overflow-fallback · 溢出兜底

> **一句话**：上下文爆了、内置压缩没救回来、之后每条消息都报 400 —— 这个插件做最后一道救援：强制再压一次并重试，不行就明确告诉你，而不是让会话悄悄死掉。

[English](#english) · [设计说明](docs/DESIGN.md) · [安全模型](SECURITY.md)

---

## 它解决什么

DeepSeek Harness 在请求超出上下文窗口时会触发压缩（compaction）。压缩不是每次都成功[^1]：一旦失败，后续**每一条**消息都会带着同样的超限请求再发一次，于是同一个错误反复出现，会话只能放弃。

`dsh-overflow-fallback` 挂在公开的 `agent/request-error` 瀑布上。当内置策略明确放弃这个失败时，它：

1. 确认失败码是 `CONTEXT_WINDOW_EXCEEDED`（不是网络、限流或鉴权）；
2. 请已加载的压缩后端以 `context-overflow` 触发再压一次；
3. 只有压缩真的产出了结果，才让这一轮**重试一次**；
4. 每个 agent 最多重试 `maxAttempts` 次，之后老实放弃，不制造无限重试。

它**不会**伪造成功、不会吞掉错误、不会改动会话日志、不会偷偷截断你的内容。

## 和同类插件的关系

上下文这一块已经很挤，但各家切的位置不同：

| 插件 | 它做什么 | 与本插件的关系 |
|---|---|---|
| `billion-context` | 把上下文压到约 1/5，支持数月长会话 | **前置减少**；压不动时仍会溢出 |
| `dsh-context` | 上下文构成与演变可视化 | **只读观察**；不改变溢出结果 |
| `dsh-context-zip` / `dsh-context-guardian` / `dsh-compact-suite` | **替换或增强压缩引擎**（带收据的摘要、确定性区间、阈值控制） | 换引擎；本插件调用的是换了之后的那个引擎 |
| `dsh-compact-saviour` | 用指定模型做压缩救援 + 原生弹窗里的手动压缩 | 手动触发 + 换模型；本插件是**自动**的，不调模型 |
| `dsh-context-guard`（`@2jumpsina/...`） | ctx 角标、45% 起写交接草稿、60% 提醒 | 预警与草稿；不含"失败后重试" |
| `dsh-compact-button` / `dsh-context-actions` | 在输入框下加压缩/新会话按钮 | 手动入口；依赖 Web GUI |

**本插件的差异**：

> 不换引擎、不加界面——**在既有策略全部放弃之后先自动再试一次；仍救不回来，就把原会话交接成一个新会话继续**。

由此带来三个别人没有的性质：

1. **它能覆盖没有 GUI 的入口**。上面这些几乎都是 Web 客户端插件（角标、按钮、弹窗），在 QQ/微信/飞书网关、`--profile headless`、TUI 里根本不存在；本插件是纯宿主插件，这些入口一样生效。
2. **兜底阶段不额外花钱**。救援用的是当前压缩引擎，不额外发起模型调用；只有走到"续命"时，`kickoff` 才会让新会话跑一轮（可设 `kickoff: false` 关掉）。
3. **它零依赖、可整段审阅**。`lib/` 五个文件、不到 700 行，无 `dependencies`，装之前能一次读完。

**老实说的短板**：交接包是**有损摘录**，中间过程会丢；补法是回查——交接包里带原会话 ID 与 `T<轮次>@seq<序号>` 锚点，模型可以用 `recall_original` 工具按锚点回读原文，服务侧对应 `recall()`。

## 安装

```powershell
# 从 npm（发布后）
dsh plugin --profile desktop add dsh-overflow-fallback

# 或直接从 GitHub
dsh plugin --profile desktop add github:WALZX123/dsh-overflow-fallback
```

本地开发安装：

```powershell
dsh plugin --profile desktop add link:E:\path\to\dsh-overflow-fallback
```

装完**重启 DSH** 一次。之后改代码不必重启：输入 `/reload` 即可原地热重载。插件没有浏览器半区，界面上不会多出入口。

## 配置

在 profile 的 `cordis.patch.yml` 里，对本插件那条装载行加 `config`：

```yaml
- insert:
    - id: dsh-overflow-fallback
      name: 'dsh-overflow-fallback'
      config:
        enabled: true
        maxAttempts: 2
```

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 关掉后插件不注册任何监听 |
| `maxAttempts` | 非负整数 | `2` | 每个 agent 最多尝试几次强制压缩；`0` 等于停用救援 |
| `revive` | `off` / `manual` / `auto` | `manual` | 救不回来之后怎么办：`off` 不注册任何动作；`manual` 只提供 `revive_session` 工具/服务方法，由人或模型显式触发；`auto` 在重试用尽后自动开新会话并注入交接包 |

**未知字段与类型错误会在装载期直接抛错**，不会静默忽略——profile 里写着 `maxAttempt: 3` 却按默认值跑，是最难排查的那类失效。

## 安全边界

| 面 | 本插件 |
|---|---|
| 运行时依赖 | **零**（`package.json` 没有 `dependencies`） |
| 网络 | 插件自身不发起请求；`kickoff` 会由宿主发**一次**模型请求（花钱） |
| 文件系统 | 不直接读写；续命创建的新会话由宿主持久化到 `$DSH_HOME/sessions` |
| 子进程 | 不创建 |
| 会话日志 | 不直接 `append`；模型可见内容只走 `agent.inject()` / `agent.followup()` |
| 权限 | 与宿主进程相同，这是 DSH 插件的固有面；因此本插件刻意把能力压到最小 |
| `/reload` | 作用于**整个 profile**，会重载所有有变化的插件条目，可能中断进行中的回合 |

完整威胁模型、代价清单与报告方式见 [SECURITY.md](SECURITY.md)。

## 兼容性

DSH 里主题、输入框、压缩后端都可能是第三方实现，所以本插件**不假设它们存在，也不假设它们的顺序**。完整规则见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)，要点：

| 场景 | 行为 |
|---|---|
| 别的插件已处理这个错误 | `next()` 优先，原样返回，不抢 |
| 压缩后端被替换 / 缺失 / 正忙 | 调用当时生效的实现；缺失时只记一条警告；忙时放弃本次重试 |
| 子代理、多会话、多端同看 | 按 agent 计数，互不影响 |
| 主题、布局、侧栏 | 插件**没有浏览器半区**，与主题、布局完全无关 |
| IM（QQ/微信/飞书/钉钉）、远程、headless | 走同一个 agent loop，救援天然生效；**但插件按 profile 安装**——跑 agent 的那个 profile 里也要装 |
| 卸载 | 监听随 fiber 释放，无残留 |

| DSH | 状态 |
|---|---|
| 0.2.1-rc.2 | 已核对扩展点签名 |
| 0.2.0-rc.2 | 未实测 |

DSH 处于开发者预览期，扩展点可能破坏性变更。插件只依赖两处公开面：`agent/request-error` 事件与 `ctx.compaction.compactIfNeeded()`；任何一处改名都会在装载或调用时明确失败，而不是静默降级。

## 给插件作者：联动接口

本插件注册一个宿主服务 `overflowFallback`，并在 `package.json` 的 `dshhub.capabilities.provides` 里声明：

```js
export const inject = ['overflowFallback']
export function apply(ctx) {
  const { markdown } = ctx.overflowFallback.handoffFor(session)
}
```

| 成员 | 用途 |
|---|---|
| `isOverflowFailure(failure)` | 判断是不是上下文超限 |
| `handoffFor(session, opts)` | 从活的会话生成交接包 |
| `buildHandoff({ events, ... })` | 从事件数组生成 |
| `anchor()` / `parseAnchor()` | 生成/解析 `T3@seq42` 锚点 |

稳定契约（文档大小上限、锚点语法、必备章节、版本策略、失败语义）见 [docs/SERVICE.md](docs/SERVICE.md)。服务是只读的：不改会话、不建会话、不发请求。

## 路线图

| 版本 | 内容 | 状态 |
|---|---|---|
| 0.1 | 溢出后强制压缩重试（兜底） | 已完成 |
| 0.2 | 交接包生成：把原会话整理成一份可读的接力文档 | 已完成（`lib/handoff.js`） |
| 0.3 | **续命**：原会话只读保留，新会话带着交接包接着聊；含 `revive_session`、`/reload` | 完成，已真机验证 |
| 0.4 | **可回查**：`recall_original` 工具按序号/锚点回读原会话，补齐有损交接的检索面 | 完成，首个对外发布 |
| 0.5 | 可见入口：会话头部右侧的续命按钮 + 预演模式（只返回计划不建会话） | 计划 |

"续命"是真正的目标：**聊死的会话不该等于丢掉的工作**。兜底重试只是为了少走一步。完整版本路线见 [docs/RELEASING.md](docs/RELEASING.md)。

## 改代码不用重启

两个入口，都调用 DSH 官方的 HMR 重载（`ctx.hmr.reconcileProfile()`）——和插件管理器装完插件后做的是同一件事：

- **人用**：输入框敲 `/reload`，回车。命令在宿主侧注册，**不占任何布局**，只出现在 `/` 菜单里，不会和主题或其它插件冲突。
- **模型用**：工具 `reload_plugins`，参数 `ids` 可指定条目，留空则重载所有改动过的。

```
/reload
```

- 不创建进程、不杀进程、不重启 desktop；
- 只重载"磁盘上的文件变了"的插件条目；
- 客户端插件如需重建 bundle，仍要刷新页面。

**为什么不是右上角的"重启按钮"**：窗口右上角的最小化/最大化/关闭是 Electron 原生窗口按钮，没有插件槽位；硬塞就是 DOM 注入，会随主题和布局变化而错位——正是本项目一直避免的做法。`/reload` 零占位，效果一样。

将来若要一个可见图标，正确的位置是 `conversation.session.header.utilities`（会话头部右侧，由应用布局管理），那需要额外增加客户端半区。

## 开发

```powershell
node test/decide.test.mjs    # 重试决策
node test/plugin.test.mjs    # 插件事件契约与工具注册
node test/handoff.test.mjs   # 交接包生成
node test/service.test.mjs   # overflowFallback 服务契约
node test/revive.test.mjs    # 续命执行器
node test/verify-install.mjs # 发布载荷与能力面契约
```

仓库无构建步骤：`lib/` 就是交付物，纯 ESM、零依赖、无编译。

## English

DeepSeek Harness can get stuck when a request exceeds the context window and the built-in compaction policy cannot shrink the surface: every later message repeats the same `CONTEXT_WINDOW_EXCEEDED` failure. `dsh-overflow-fallback` listens on the public `agent/request-error` waterfall, asks the loaded compaction backend for one forced `context-overflow` reduction, and retries only when compaction actually produced a result. It adds no model-visible text, performs no I/O, and has zero runtime dependencies.

[^1]: 见 `docs/DESIGN.md` 的「为什么需要它」一节，其中记录了触发条件与已知边界。
