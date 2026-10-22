# 发布计划与流程

## 版本路线

首个对外发布是 **0.3.0**。0.1 / 0.2 是同一开发周期内的里程碑，不单独发布。

| 版本 | 主题 | 范围 | 状态 |
|---|---|---|---|
| 0.1.0 | 溢出兜底 | `agent/request-error` 上强制再压一次并重试 | 开发期里程碑 |
| 0.2.0 | 交接包 | 有损摘录 + 原会话锚点 + `overflowFallback` 服务 | 开发期里程碑 |
| **0.3.0** | **续命** | `revive_session` / `reviveFor` / `recall` / `/reload` / `reload_plugins` | **首个发布** |
| 0.4.0 | 可回查 | 把 `recall` 暴露成模型工具 `recall_original`；交接包锚点可直接被模型使用 | 计划 |
| 0.5.0 | 可见与可控 | 客户端半区：会话头部右侧的续命入口 + 预演模式（只返回计划不建会话） | 计划 |
| 1.0.0 | 稳定 | 契约冻结；真实组合测试进 CI；类型检查 | 计划 |

### 版本号规则

- **主版本**（0.x → 1.0）：契约冻结、或 `overflowFallback` 服务出现破坏性变更；
- **次版本**（0.3 → 0.4）：新增能力，向后兼容；
- **修订版本**（0.3.0 → 0.3.1）：只修 bug、改文档、改内部实现，不新增配置项与服务方法。

`service.contractVersion` 独立于包版本：只有删方法、改返回结构、改锚点语法时才递增。

## 发布前检查清单

1. 全量测试通过：`node test/decide.test.mjs && node test/plugin.test.mjs && node test/handoff.test.mjs && node test/service.test.mjs && node test/revive.test.mjs && node test/verify-install.mjs`；
2. `npm pack --dry-run` 的载荷与 `files` 白名单一致（CI 会跑）；
3. `CHANGELOG.md` 已分组：新增 / 修复 / 加固 / 工程；
4. `SECURITY.md` 的能力表与代价清单与代码一致（新增能力必须同步）；
5. `package.json` 的 `dsh.compatibility.dshReleases` 与实测版本一致；
6. 真机验证：至少跑一次"溢出 → 续命 → 新会话可见"，并在 PR/Release Note 里贴日志片段。

## npm 发布步骤

```powershell
# 1. 确认登录
npm whoami

# 2. 干跑，检查发布内容
npm pack --dry-run

# 3. 发布
npm publish --access public

# 4. 打 tag（与版本号一致）
git tag v0.3.0
git push origin v0.3.0
```

首个版本发布后，在 README 顶部换成真实安装命令：

```powershell
dsh plugin --profile desktop add dsh-overflow-fallback
```

## 兼容性承诺

- 只依赖两处公开面：`agent/request-error` 与 `ctx.compaction`；另用 `ctx.agents`、`workspaceRegistry`、`hmr`、`commands`、`tools` 的能力面，均为可选读取。
- DSH 破坏性变更时：优先发修订版本适配；若必须改契约，升次版本并在 CHANGELOG 标注 breaking。
- 不承诺在未实测的 DSH 版本上可用；`dshReleases` 里标 `untested` 的版本会被如实告知。
