# 设计说明 · dsh-overflow-fallback

本文记录插件的扩展点选择、行为契约与不做什么。实现见 `lib/`。

## 1. 为什么需要它

DSH 的请求在超出模型上下文窗口时，由压缩后端尝试把一段历史折叠成一个摘要节点。压缩由多个条件共同决定（阈值、可压缩区间、摘要请求本身是否成功、工具调用配对是否平衡）。任何一环不成立，压缩就返回「没有可压缩区间」，请求本身仍然超限。

此后用户再发消息，组装出的请求依旧超限，provider 依旧返回同一个错误。会话的可操作性由此永久丧失——用户看到的是一串同样的报错，唯一的出路是放弃这个会话。

插件做的不是「更好的压缩算法」，而是**在既有策略全部放弃之后，再给一次机会，并且把结局说清楚**。

## 2. 扩展点

只用两处公开面，均在 DSH 源码里有明确声明：

| 面 | 位置 | 签名 |
|---|---|---|
| `agent/request-error` | `packages/core/agent/src/runtime-types.ts` | `(payload: { agent, turn, step, provider, failure, retryPolicy, signal }, next) => Promise<RequestErrorAction>` |
| `ctx.compaction` | `packages/compaction/compaction/src/index.ts` | `compactIfNeeded(agent, trigger, signal): Promise<CompactionResult \| null>` |

`RequestErrorAction` 只有两种取值：`{ kind: 'retry' }` 或 `undefined`（`packages/core/agent/src/runtime-types.ts`）。插件因此不可能伪造「成功」以外的结果——返回 `undefined` 就是继续失败。

`CompactionTrigger` 的 `'context-overflow'` 是官方为「provider 已确认超限」准备的触发值：它允许压缩在低于常规阈值时也进行有用区间缩减。

## 3. 行为契约

```
agent/request-error(payload, next)
  ├─ next()                          // 先让内置与其它策略表态
  ├─ 下游已给出决定 → 原样返回，不重复处理
  ├─ signal 已中止 → 返回 undefined
  ├─ 失败码 != CONTEXT_WINDOW_EXCEEDED → 返回 undefined
  ├─ 本 agent 尝试次数 >= maxAttempts → 返回 undefined
  ├─ 没有 compaction 服务 → 记一条警告，返回 undefined
  ├─ 次数 +1，调用 compactIfNeeded(agent, 'context-overflow', signal)
  │    ├─ 返回结果 → { kind: 'retry' }
  │    ├─ 返回 null → undefined（没有可压缩区间，重试只会复现同样错误）
  │    └─ 抛错 → 记警告，返回 undefined
```

三条不变量：

1. **只在确有进展时重试**。`compactIfNeeded` 返回 `null` 表示没有安全区间可压，此时重试只会再撞一次墙。
2. **重试有上界**。次数按 agent 记在 `WeakMap` 里，随 agent 回收，不泄漏。
3. **永不越权**。不直接改会话日志、不构造合成消息、不绕过审批。

## 4. 被否决的方案

| 方案 | 为什么不用 |
|---|---|
| 自己实现压缩 | 与内置后端重复；摘要质量、token 计价、检查点一致性都属于后端职责 |
| 监听 `agent/pre-step` 提前拦截并注入提示词 | 会改变模型可见输入，需要新的会话事件与快照更新；价值不足以承担这个面 |
| 直接改 session JSONL 修历史 | 破坏「模型所见即日志所记」的不变量，且格式随版本变化 |
| 新建会话并搬运摘要 | 需要会话创建与跨会话引用，属于更大的能力面；留待后续版本评估 |

## 5. 安全模型

- **零依赖**：供应链风险等于本仓库本身。
- **零 I/O**：无网络、无文件、无子进程，`test/verify-install.mjs` 对入口做静态断言。
- **最小权限**：只读 `ctx.get('compaction')`，只调用一个公开方法。
- **失败可见**：配置错误在装载期抛错；运行期异常记警告而不是吞掉。
- **可卸载**：监听通过 `ctx.on` 注册，随 fiber 释放。

## 6. 路线图

| 版本 | 内容 | 状态 |
|---|---|---|
| 0.1 | 溢出后的强制压缩重试 | 完成 |
| 0.2 | 交接包：有损摘录 + 原会话锚点 + `overflowFallback` 服务 | 完成 |
| 0.3 | 续命：`revive_session` / `reviveFor` / `/reload` / `reload_plugins` | 完成 |
| 0.4 | 可回查：`recall_original` 按序号/锚点回读原会话 | 完成（首个发布） |
| 0.5 | 可见入口：会话头部右侧的续命入口 + 预演模式（只返回计划不建会话） | 计划 |
| 1.0 | 契约冻结、真实组合测试进 CI、类型检查 | 计划 |

每个版本都必须保持：**默认无副作用、失败可见、可单独关闭**。

自动续命失败后，同一会话不会被再次自动续命（`WeakSet` 只加不减），避免故障时反复建会话；手动工具失败则会释放标记，允许重试。
