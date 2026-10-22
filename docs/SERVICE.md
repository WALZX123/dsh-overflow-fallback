# 插件联动接口（overflowFallback 服务）

本插件在宿主侧注册一个 Cordis 服务 `overflowFallback`，别的插件用它生成交接包、判断溢出失败，**不需要依赖本包的内部文件**。

> 客户端的 UI 插件不能互相 import 实现，跨包联动要么走服务注入，要么走槽位。这里提供的是宿主侧的服务注入面。

## 声明

`package.json`：

```json
{
  "dshhub": {
    "capabilities": { "provides": ["service:overflowFallback"] },
    "permissions": { "network": [] }
  }
}
```

- `provides` 是机器可读的能力声明，插件市场与依赖分析工具据此知道你提供什么；
- `permissions.network` 为空数组，表示不发起网络请求（与 `SECURITY.md` 一致）。

## 消费方式

```js
export const inject = ['overflowFallback']

export function apply(ctx) {
  const { markdown, stats } = ctx.overflowFallback.handoffFor(session, {
    reason: '上下文超限，已生成交接包',
  })
}
```

**可选消费**（服务可能没装）：

```js
const fallback = ctx.get('overflowFallback')
if (fallback !== undefined) {
  const markdown = fallback.handoffFor(session).markdown
}
```

## 方法

| 成员 | 签名 | 语义 |
|---|---|---|
| `contractVersion` | `number` | 当前为 `1`；破坏性变更才递增 |
| `isOverflowFailure(failure)` | `(unknown) => boolean` | 失败码是否为 `CONTEXT_WINDOW_EXCEEDED`（兼容嵌套 `error.code`） |
| `buildHandoff(input)` | `({ events, title?, sessionId?, reason? }) => { markdown, stats }` | 从事件数组生成交接包 |
| `handoffFor(session, options?)` | `(session, { title?, sessionId?, reason? }) => { markdown, stats }` | 从活的 Session 生成；读取 `id`、`header.title`、`snapshotEvents()` |
| `anchor(turn, seq)` | `(number, number) => string` | 生成锚点，如 `T3@seq42` |
| `parseAnchor(text)` | `(string) => { turn, seq } \| undefined` | 从任意文本里解析第一个锚点 |
| `recall(session, { from, to })` | `(session, range) => { events, truncated }` | 按序号回读会话日志片段，最多 200 条 |
| `reviveFor(session, opts?)` | `(session, { reason?, title? }) => Promise<{ sessionId, handoff, agent }>` | 新建会话并注入交接包（**这是唯一会写状态的方法**） |

除 `reviveFor` 外，所有方法都是**只读**的：不改会话、不创建会话、不发请求、不写文件。`reviveFor` 需要 `ctx.agents` 可用，且只写新会话，原会话只读。

## 交接包格式契约

**稳定的部分**（下游可以依赖）：

- 文档大小上限：6000 字符；
- 必然包含「原文在哪」一节；
- 锚点语法固定为 `T<轮次>@seq<序号>`；
- 至少包含「你要继续的事」「最后的结论」「接着做」三节。

**可变的部分**（下游不要依赖）：

- 措辞、标点、章节顺序的细节；
- 具体摘录了哪几条消息（当前是最近 8 条提问、最近 3 条回复）；
- 是否附带文件与工具清单（没有就不出现）。

> 解析请用 `parseAnchor()` 或锚点正则，不要匹配标题文字。

## 版本策略

- `contractVersion` 只在**破坏性**变更时递增（删方法、改返回结构、改锚点语法）；
- 新增成员、放宽上限、增加可选字段都不递增；
- 下游应按版本号做能力判断，而不是按包版本号。

## 失败语义

- `handoffFor(undefined)` 抛 `TypeError`；
- 会话缺少 `snapshotEvents()` 时按空事件处理，返回一份可用的空交接包，不抛错；
- 服务未安装时 `ctx.get('overflowFallback')` 返回 `undefined`，下游必须自行降级。

## 为什么不做成"共享代码"

- 客户端插件之间禁止运行时互相 import（DSH 的插件边界规则）；
- 复制一份 `handoff.js` 会造成两份实现漂移；
- 服务注入是 Cordis 的一等机制，可卸载、可替换、可等待就绪。

将来如果交接包需要更强的检索能力（按锚点回读原会话），同样以**扩展这个服务**的方式发布，而不是让下游直接读会话文件。
