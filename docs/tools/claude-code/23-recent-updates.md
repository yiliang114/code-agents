# 23. 近期更新（v2.1.82 → v2.1.132）

> 本系列主体基于 **v2.1.81 二进制逆向分析**（2026-03-25）。本文档汇总 2026-03-26 到 **2026-05-06（v2.1.132）** 期间的关键增量更新，为 Code Agent 开发者提供新功能借鉴。

> **数据来源**：[Claude Code 官方 changelog](https://code.claude.com/docs/en/changelog) + [What's New](https://code.claude.com/docs/en/whats-new) + GitHub releases。本系列其他章节未深度逆向 v2.1.132，下面的实现细节可能不全。

## 一、版本一览

| 范围 | 周期 | 关键节点 |
|---|---|---|
| 文档基线 | v2.1.81（2026-03-25）| 系列主体内容 |
| 当前 latest | **v2.1.132**（2026-05-06）| 本文覆盖的更新 |
| 版本节奏 | 双周特性 drop（Week 13-17）| 每周日发版 |

## 二、5 个 Cloud-Connected 大特性（最重要）

### 2.1 Computer Use in CLI（research preview）

**Week 14（2026-03-30 → 04-03）发布**。

| 维度 | 说明 |
|---|---|
| 触发 | Claude 在 CLI 内调用 `computer_use` tool |
| 能力 | 打开本地 GUI 应用、点击 UI、视觉验证 |
| 价值 | 把"代码改动"和"实际运行效果验证"接到一起；headless automation 之外补 GUI 检查的循环 |
| 与 Computer Use API 的关系 | CLI 层封装，底层是 Anthropic Computer Use API |
| 风险 | 需明确 permission；Auto Mode 下默认走严格审批 |

**对 Code Agent 开发者的借鉴**：
- 把 LLM 的修改 → 跑 → 看 UI 验证形成闭环（与传统 read/edit/bash 工具组互补）
- 多模态视觉做 visual regression testing 思路
- 对 Qwen Code 是 ❌ 没有等价能力，可作差异化点

### 2.2 Auto Mode（research preview）

**Week 13（2026-03-23 → 27）发布**。

```
Manual mode (default):
  每次 permission_request → 用户审批

--dangerously-skip-permissions:
  全部跳过 ⚠ 危险

Auto Mode (新):
  Permission classifier 模型 → 安全的自动 approve / 危险的拦截
  介于上面两个极端之间
```

**Classifier 大概工作方式**（推测）：
- 输入：当前 tool call + 参数 + 上下文
- 输出：safe / risky / requires-confirmation
- 学习信号：用户历史审批选择

**对 Code Agent 开发者的借鉴**：
- 比单纯 allowlist 更智能（基于上下文，不只是 pattern match）
- 与 Qwen Code daemon 的 [§07 permission flow 4 mode](../../comparison/qwen-code-daemon-design/07-permission-auth.md) 互补 —— 可作为第 5 mode "auto-classified"

### 2.3 Ultraplan（early preview）

**Week 15（2026-04-06 → 10）发布**。

```
本地 CLI 起草 plan
    ↓
推送到 Anthropic 云端 web editor
    ↓
非作者（团队成员）评审 / 评论
    ↓
回到 CLI 执行（本地或云端跑）
```

**关键架构点**：
- Plan 不是普通文本，而是结构化（步骤 / dependencies / artifacts）
- 云端 web 编辑器与 CLI 双向同步
- 自动创建云端环境（首次使用）

### 2.4 Ultrareview（public research preview）

**Week 17（2026-04-20 → 24）发布**。

```
Trigger: /ultrareview <PR#> 或 /ultrareview（当前分支）
    ↓
云端 fleet 并行 spawn 多个 review agents（不同 perspective）
    ↓
聚合 findings → 推回本地 CLI / Desktop
```

**估计的 fleet 组成**（推测，基于公开行为）：
- security agent
- correctness agent
- style / convention agent
- performance agent
- test coverage agent

**对 Code Agent 开发者的借鉴**：
- 多 agent 并行做 review 是 single-agent 力不从心场景的解
- 与 Qwen Code [§subagent-display 4 kinds](../../comparison/subagent-display-deep-dive.md) 类似但走云端
- "Ultraplan / Ultrareview" 命名模式：cloud-augmented CLI

### 2.5 Routines on Web（Week 16）

**Week 16（2026-04-13 → 17）发布**。

```
Web 控制台:
  cron / GitHub event / API call
    ↓ schedule
  Routine（templated cloud agent）
    ↓ execute
  结果 → 回 web / CLI 通知
```

**新增 `/usage` 命令**（同周）：查看 token burn / API call / compute 使用情况。

## 三、模型与 Reasoning（Week 16）

| 变化 | 说明 |
|---|---|
| **默认模型** | Max / Team Premium 默认从 Opus 4.6 升 **Opus 4.7** |
| **新 effort level** | `xhigh`（介于 `high` 和 `max` 之间）|
| **`/effort` 滑块** | 交互式 visual tuning 替代命令行 args |

旧文档（[§03-architecture](./03-architecture.md)）的 Opus 4.6 默认表述需更新为 4.7。定价结构应保持类似。

## 四、CLI / Environment（v2.1.126-132）

### 4.1 新增 / 改进

| 类型 | 项 | 版本 | 说明 |
|---|---|---|---|
| ✨ | Native binaries 发布 | Week 16 | 启动速度提升（之前是 Bun 打包 JS）|
| ✨ | `--plugin-url` flag | v2.1.129 | 从 URL fetch plugin 包，不再仅本地 fs |
| ✨ | `CLAUDE_CODE_SESSION_ID` env | v2.1.132 | Bash 子进程能拿到 session 上下文 |
| ✨ | `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` env | v2.1.132 | 不切 fullscreen 渲染，保留 terminal scrollback |
| ✨ | `CLAUDE_CODE_FORCE_SYNC_OUTPUT` env | v2.1.129 | debug 用强制同步输出 |
| 🔧 | Gateway model discovery | v2.1.126 | `/model` picker 从 gateway `/v1/models` 读模型列表（opt-in：`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`）|

### 4.2 OAuth / 认证

| 改进 | 版本 | 说明 |
|---|---|---|
| MCP server OAuth：粘贴 code | v2.1.126 | 浏览器 callback 不可达时手动粘贴 |
| `--dangerously-skip-permissions` 范围扩大 | v2.1.126 | 现在也跳过 protected-path prompts |
| `--permission-mode` resume 修复 | v2.1.132 | `--permission-mode` 在 `--resume` 时被忽略的 bug 修了 |

## 五、新斜杠命令（Week 13-17）

| 命令 | 周期 | 说明 |
|---|---|---|
| `/ultrareview` | Week 17 | 云端 fleet 并行 review（见 §2.4）|
| `/ultraplan` | Week 15 | 云端协作 plan（见 §2.3）|
| `/autofix-pr` | Week 15 | 触发 PR auto-fix 从 terminal（web 等价）|
| `/usage` | Week 16 | 查看 token / API / compute 用量 |
| `/team-onboarding` | Week 15 | 把当前 setup 打包成 replayable guide |
| `/theme` | Week 17 | 自定义颜色主题（也支持 plugin 提供）|
| `/loop` 行为变更 | Week 15 | 不带 interval 时变 self-pacing 而非 busy-loop |

需要更新 [§02-commands](./02-commands.md) 的命令清单（当前是 79 命令 v2.1.81 基线，需加上面这些）。

## 六、Hooks 系统增强

### 6.1 Conditional `if` Hooks（Week 13）

之前 hooks 只能无条件执行。现在支持：

```jsonc
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "if": "tool.args.command =~ /rm -rf/",
      "command": "echo 'Blocked dangerous rm -rf' && exit 2"
    }]
  }
}
```

**意义**：从 "all-or-nothing 拦截" 进化为 "条件拦截"。降低误拦截率。

需要更新 [§12-hooks](./12-hooks.md) 加 `if` 字段说明。

### 6.2 Monitor Tool（Week 15）

后台事件流入对话——logs / webhooks / file changes 实时进入 Claude 上下文。

```bash
claude monitor --logs /var/log/app.log --webhook https://...
# Claude 看到日志变化时自动反应
```

类似 Qwen Code [PR#3684 / PR#3791 monitor task kind](../../comparison/subagent-display-deep-dive.md)，两边设计趋同。

## 七、IDE / Terminal

| 项 | 说明 |
|---|---|
| ✨ VS Code 原生 extension | 高亮代码块 / inline 调用 Claude / 修改建议直接在编辑器看 |
| ✨ Tool Search / Lazy Loading | 工具按需激活，启动开销下降（v2.1.76）|
| ✨ Flicker-free alt-screen | `/tui fullscreen` 稳定性提升（睡眠唤醒后不空白）|
| ✨ Custom themes | `/theme` 或 plugin 提供 |
| ✨ Session Recap | 终端失焦期间发生了什么的 summary |
| 🔧 Native PowerShell tool | Windows opt-in `CLAUDE_CODE_USE_POWERSHELL_TOOL` |

## 八、MCP / 插件

| 项 | 说明 |
|---|---|
| 🔧 Per-tool MCP result-size override | 可设单 tool output 上限到 **500K** |
| ✨ Plugin executables on Bash `PATH` | plugin 可注入 binary 到 shell 环境 |
| 🔧 MCP retry logic 改进 | 连接失败的 status 更清楚（v2.1.132）|

需要更新 [§14-mcp](./14-mcp.md) 加 result-size override 说明。

## 九、Stability / 修复

### 9.1 关键 bug 修

| 项 | 版本 | 说明 |
|---|---|---|
| 🔧 Vim mode 文本破坏 | v2.1.132 | NFD（decomposed）accented chars 被 operators 破坏 |
| 🔧 paste `/` 开头被吞 | v2.1.132 | 粘贴以 `/` 开头的文本被静默丢弃 |
| 🔧 stdio MCP memory leak | v2.1.132 | RSS 长跑无界增长（10GB+）|
| 🔧 Bedrock / Vertex prompt caching | v2.1.132 | 400 错误修复 |
| 🔧 Terminal emoji 渲染 | v2.1.132 | ZWJ 序列 + Indic scripts |

### 9.2 ⚠ 唯一 Breaking Change

**`Ctrl+O` 行为改变**（v2.1.110）：
- 之前：modal-toggle（切换不同模态）
- 之后：normal/verbose transcript view 切换

影响小（罕用快捷键），但用户脚本若依赖旧行为需调整。

## 十、与本系列其他章节的更新关联

下面是本系列哪些章节需要相应更新：

| 章节 | 更新点 |
|---|---|
| [§01-overview](./01-overview.md) | 能力矩阵加 Computer Use / Auto Mode / Ultraplan / Ultrareview |
| [§02-commands](./02-commands.md) | 加 7 个新斜杠命令（§五）|
| [§03-architecture](./03-architecture.md) | 默认模型 Opus 4.6 → 4.7；新 `xhigh` effort level；native binaries |
| [§06-settings](./06-settings.md) | 新 env vars（§4.1）|
| [§12-hooks](./12-hooks.md) | Conditional `if` hooks（§6.1）|
| [§14-mcp](./14-mcp.md) | Per-tool result-size override（§八）|
| [§15-telemetry](./15-telemetry-feature-flags.md) | 新 feature flags（gateway model discovery 等）|

## 十一、对 Qwen Code daemon 设计的启发

| Claude Code 新特性 | 对应 Qwen daemon 设计的位置 / 借鉴 |
|---|---|
| Computer Use in CLI | ❌ Qwen 无等价；可作差异化考虑 |
| Auto Mode | [§07 permission flow](../../comparison/qwen-code-daemon-design/07-permission-auth.md) 可加第 5 mode "auto-classified" |
| Ultraplan / Ultrareview（云端 fleet）| [§20 vs Anthropic Managed Agents](../../comparison/qwen-code-daemon-design/20-vs-anthropic-managed-agents.md) 同方向；Stage 6 SaaS 可包装类似产品 |
| Routines on Web | [§16 HA + §11 多租户](../../comparison/qwen-code-daemon-design/16-high-availability.md) 集群部署的应用层场景 |
| Monitor tool（背景事件流入对话）| Qwen 已有 [PR#3684/3791 monitor task kind](../../comparison/subagent-display-deep-dive.md)，趋同设计 |
| Native binaries | 启动优化方向；Qwen daemon 设计中 [§19 长跑稳定性](../../comparison/qwen-code-daemon-design/19-stability-and-longevity.md) 与之协同 |
| Conditional `if` hooks | Qwen Code hooks 系统是否引入此机制可参考 |

## 十二、一句话总结

**Claude Code 在 v2.1.81 → v2.1.132 的 ~6 周内重点投入云端协作（Computer Use / Auto Mode / Ultraplan / Ultrareview / Routines）+ 默认模型升 Opus 4.7 + Hooks 条件化 + 启动优化（native binaries / tool lazy loading）+ MCP 强化（per-tool size override / plugin binaries on PATH）+ 大量长跑 bug 修复（stdio MCP leak 10GB+ / vim NFD / paste `/` swallow）。唯一 breaking change 是 Ctrl+O 行为变更（影响小）。设计趋势：CLI 工具 + 云端 augmentation 并存（fleet of agents / cloud routines / web review）—— 与 Anthropic Managed Agents 路径同源，但保留本地 CLI 主战场。**

---

[← 返回 README](./README.md)
