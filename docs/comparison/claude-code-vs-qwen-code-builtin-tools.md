# Claude Code vs Qwen Code 内置工具对比

> **数据来源**：
> - **Claude Code v2.1.132**：[docs/tools/claude-code/04-tools.md](../tools/claude-code/04-tools.md)（反编译 + 源码分析）
> - **Qwen Code v0.15.10**：`/root/git/qwen-code/packages/core/src/tools/tool-names.ts` + tools 目录源码（截至 2026-05-12，commit 包含 PR#4002 + PR#4022 + PR#4041 + PR#4069）
> - **配套阅读**：[Tool-Search Deep-Dive](./tool-search-deep-dive.md) / [Tool-Parallelism Deep-Dive](./tool-parallelism-deep-dive.md) / [ReadFile Tool Deep-Dive](./read-file-tool-deep-dive.md) / [BriefTool Async Deep-Dive](./brieftool-async-user-messages-deep-dive.md)

## 一、TL;DR

| 维度 | Claude Code | Qwen Code |
|---|---|---|
| **内置工具总数** | **~39**（10 核心 + 25 延迟 + 3 内部 + 1 条件）| **~21**（含 MCP 动态注册基础）|
| **加载策略** | ToolSearch 延迟（核心 10 始终加载 / 25 按需）| 部分延迟（PR#3589 + PR#4022 共 9 项 deferred）|
| **MCP 工具** | `mcp__<server>__<tool>` 动态注册 | `mcp-tool.ts` 同款机制 |
| **System prompt 节省** | ~60%（15K → 6K tokens）| 部分（PR#3589 + PR#4022 等延迟落地）|
| **设计差异** | 工具数多 + 强分类 + 延迟加载是核心创新 | 工具数精简 + 按需求渐进添加（Cron / Monitor 等较新）|

## 二、工具数量对比

| 类别 | Claude Code | Qwen Code | 差异 |
|---|:---:|:---:|---|
| 核心（始终加载） | 10 | ~12 | Qwen 没有 ToolSearch / StructuredOutput 顶级工具 |
| 延迟（按需加载） | 25 | 9 | Claude 延迟池大得多 |
| 内部 / 条件 | 4 | 0 | Claude 有 REPLTool / SleepTool / PowerShell |
| MCP 动态 | ∞ | ∞ | 两者都支持 |
| **总计（不含 MCP）** | **~39** | **~21** | **Claude ~1.85x** |

## 三、详细 mapping table（Claude → Qwen 对应关系）

### 3.1 文件 / 搜索类

| Claude Code | Qwen Code | 状态 | 备注 |
|---|---|---|---|
| `Read` | `read_file` (ReadFile) | ✅ 对齐 + Qwen 后来居上 | PR#3717 / 3774 / 3810 / 3932 / 4002 FileReadCache + prior-read 守卫链与 Claude 行为对齐 |
| `Write` | `write_file` (WriteFile) | ✅ 对齐 | partial-read 接受语义 PR#3932 / 4002 与 Claude 一致 |
| `Edit` | `edit` (Edit) | ✅ 对齐 | replace_all 模式 Qwen 也有 |
| `Glob` | `glob` (Glob) | ✅ 对齐 | — |
| `Grep` | `grep_search` (Grep) + `ripGrep`（独立 ts 文件）| ✅ 双实现 | Qwen 有 `grep.ts` 通用版 + `ripGrep.ts` 性能版 |
| `LS` (Claude 内部？) | `list_directory` (LS / ListFiles) | ✅ 对齐 | Qwen 独立工具 |

### 3.2 执行类

| Claude Code | Qwen Code | 状态 | 备注 |
|---|---|---|---|
| `Bash` | `run_shell_command` (Shell) | ✅ 对齐 | Claude 12,411 LOC / 18 文件 / 23 项安全验证；Qwen `shell.ts` 含 AST 只读检测 |
| `PowerShell`（Windows 条件）| ❌ 无 | Qwen 缺 | Claude 仅 Windows 平台启用 |
| `REPLTool`（内部）| ❌ 无 | Qwen 缺 | Claude 内部使用 |
| `SleepTool`（内部）| ❌ 无 | Qwen 缺 | Claude 内部使用（睡眠 / 等待）|

### 3.3 Agent / 任务调度类

| Claude Code | Qwen Code | 状态 | 备注 |
|---|---|---|---|
| `Agent` | `agent` (Agent) | ✅ 对齐 | Qwen 在 agent/ 子目录有 `agent.ts` + `fork-subagent.ts` |
| `Task*` 工具组（TaskCreate / TaskList / TaskGet / TaskUpdate / TaskOutput）| `todo_write` (TodoWrite) + `task-stop` (TaskStop) | ⚠️ 不完全对齐 | Claude Task V2 工具组更细粒度（5+ 个 Task* 工具）；Qwen 用 TodoWrite + TaskStop 两个，Background tasks 由 4 kinds framework 调度 |
| `TaskStop`（内部，含 KillShell 别名）| `task_stop` (TaskStop) | ✅ 对齐 | Qwen 同款（PR#3642 + PR#3836 4 kinds dispatch）|
| `TodoWrite` | `todo_write` (TodoWrite) | ✅ 对齐 | — |

### 3.4 Web / 抓取类

| Claude Code | Qwen Code | 状态 | 备注 |
|---|---|---|---|
| `WebFetch` | `web_fetch` (WebFetch) | ✅ 对齐 | Claude 1,131 LOC |
| `WebSearch` | ❌ **缺**（PR#3502 移除 → PR#3844 OPEN 重新添加中）| Qwen 待补 | Qwen 之前移除过 WebSearch（PR#3502 −1830 行），社区报 #3841 引用 codeagents [web-search-tool-deep-dive](./web-search-tool-deep-dive.md) 推动 PR#3844 OPEN 回填 |
| `NotebookEdit` | ❌ 无 | Qwen 缺 | Claude 587 LOC，Jupyter `.ipynb` 编辑支持 |
| `WebFetch` Auto Clean | 有 prompt-injection 防御 | 有同款（PR#3844 设计）|

### 3.5 LSP / Code Intelligence

| Claude Code | Qwen Code | 状态 | 备注 |
|---|---|---|---|
| `LSP` | `lsp` (Lsp) | ✅ 对齐 | Qwen `lsp.ts` 完整实现 |

### 3.6 用户交互类

| Claude Code | Qwen Code | 状态 | 备注 |
|---|---|---|---|
| `AskUserQuestion` | `ask_user_question` (AskUserQuestion) | ✅ 对齐 | PR#4041 把 Qwen 该工具从 deferred 改回 always-visible（防 prose fallback）|
| `SendMessage` | `send_message` (SendMessage) | ✅ 对齐 | 给 background task 发消息 |
| `Brief`（Claude 延迟工具）| ❌ 无 | Qwen 缺 | Claude `brieftool` 异步用户消息机制（[Brief Tool Deep-Dive](./brieftool-async-user-messages-deep-dive.md)）|
| `ExitPlanMode` | `exit_plan_mode` (ExitPlanMode) | ✅ 对齐 | — |
| `PlanMode*` 工具组 | 仅 `exit_plan_mode` | ⚠️ 不完全对齐 | Claude 有 PlanMode 多个相关工具，Qwen 只暴露 exit |

### 3.7 Cron / 调度类

| Claude Code | Qwen Code | 状态 | 备注 |
|---|---|---|---|
| `Cron*` 工具组（CronCreate / CronList / CronDelete）| `cron_create` / `cron_list` / `cron_delete` (CronCreate / CronList / CronDelete) | ✅ **完全对齐** | Qwen 拆 3 个独立工具（PR#3589 ToolSearch 默认 deferred）|

### 3.8 Memory / Skills

| Claude Code | Qwen Code | 状态 | 备注 |
|---|---|---|---|
| `Skill` | `skill` (Skill) | ✅ 对齐 | Qwen PR#3852 path-conditional 激活（基于 discovered 路径，比 Claude 更准）|
| `Memory` 系列（Claude 通过 services/memdir 而非工具）| `save_memory` (SaveMemory) | ⚠️ 实现位置不同 | Claude 把 memory 放在 services 层；Qwen 暴露为顶级 tool |

### 3.9 Worktree / Git 高级

| Claude Code | Qwen Code | 状态 | 备注 |
|---|---|---|---|
| `Worktree*` 工具组（EnterWorktree / ExitWorktree）| ❌ 无 | Qwen 缺 | Claude 支持 git worktree 切换 |

### 3.10 Remote / Team

| Claude Code | Qwen Code | 状态 | 备注 |
|---|---|---|---|
| `RemoteTrigger`（Claude 延迟）| ❌ 无 | Qwen 缺 | Claude 远程触发能力 |
| `Team*` 工具组（Claude 延迟）| ❌ 无 | Qwen 缺 | Claude 团队协作（多 user 共享）|
| `Config`（Claude 延迟）| ❌ 无 | Qwen 缺 | Claude 动态 settings 工具（[Config Tool Deep-Dive](./config-tool-dynamic-settings-deep-dive.md)）|
| `StructuredOutput`（Claude 核心）| 🟡 PR#4001 OPEN（feat: structured JSON schema output）| Qwen 实现中 | 对应 Claude 核心工具，Qwen 通过 CLI flag (`--json-schema`) 实现而非工具 |
| `ToolSearch`（Claude 核心）| 🟡 PR#3589 部分实现 + PR#4069 加 `tools.toolSearch.enabled` 开关 | Qwen 部分 | Qwen ToolSearch 实现了延迟机制，但 PR#4069 揭示与 prefix cache 冲突（DeepSeek 用户报 +214% 成本）|

### 3.11 Qwen 独有

| Qwen Code | Claude Code | 状态 | 备注 |
|---|---|---|---|
| `monitor` (Monitor) | ❌ 无 | **Qwen 独有** | 长跑 shell 命令 stdout 流监控（`tail -f` / 构建输出 / 状态轮询），auto-stop on max_events / idle_timeout_ms。实现见 `monitor.ts` 742 行|

## 四、加载策略对比

### 4.1 Claude Code: ToolSearch 延迟加载

- **核心 10 个工具始终加载到系统提示**（约 ~6K tokens）
- **25 个延迟工具**（`shouldDefer: true`）不在初始 prompt——模型通过 `ToolSearch("keyword")` 动态拉取 schema
- **节省**：系统提示从 ~15K → ~6K tokens（**~60%**）

```
ToolSearch 工作流：
  模型: "需要编辑 Jupyter notebook"
  ↓
  ToolSearch("notebook edit") → 返回 NotebookEdit schema
  ↓
  下一轮模型: NotebookEdit({...})
```

### 4.2 Qwen Code: 部分延迟

- **PR#3589** 引入 ToolSearch 机制，最初延迟 5 项：`cron_create`, `cron_list`, `cron_delete`, `ask_user_question`, `exit_plan_mode`, `lsp`, MCP 相关
- **PR#4022** (2026-05-11) 扩展延迟 4 项：`monitor`, `send_message`, `task_stop`, `web_fetch` — 与 Claude 延迟策略对齐
- **PR#4041** (2026-05-11) 反向修复：`ask_user_question` 强制 `shouldDefer=false`（deferred 后模型用 prose 代替结构化 multi-choice）
- **PR#4069** (2026-05-12 OPEN) 新增 `tools.toolSearch.enabled` 全局开关 + `deepseek-v4-*` 自动 disable（防 prefix cache 冲突）

### 4.3 设计权衡：token 节省 vs cache hit

[PR#4069 揭示的根本矛盾](./qwen-code-improvement-report.md#2026-05-12)（来自真实用户 [discussions/4065](https://github.com/QwenLM/qwen-code/discussions/4065)）：

| 维度 | ToolSearch 之前 | ToolSearch 之后 |
|---|---|---|
| Initial tool list | 全部 ~30 工具 | 核心 ~10 工具 + 动态发现 |
| Token 数 | 较高 | 减少 ~46% |
| Cache prefix | 稳定 → cache hit 97.5% | 动态 → cache hit **81.5%** |
| DeepSeek 日成本 | $1.05 | **$3.30**（+214%） |

DeepSeek `cache_hit` 定价是 `cache_miss` 的 1/120，失去 cache hit = 输入 token 价格涨 120 倍，远超 ToolSearch 节省的 46% token 数。**Claude 因模型架构差异（prompt cache 工作机制不同）不受此影响**。

## 五、Claude 独有工具（Qwen 可借鉴）

| 工具 | Claude LOC | 用途 | Qwen 借鉴优先级 |
|---|---|---|---|
| **WebSearch** | 569 | 搜索引擎查询 | 🌟 **P0**（PR#3844 OPEN 回填中）|
| **NotebookEdit** | 587 | Jupyter `.ipynb` 编辑 | 🟡 P1（数据科学场景）|
| **Worktree*** | — | git worktree 切换 / 多分支并行 | 🟡 P1（高级 git 工作流）|
| **Brief** | — | 异步用户消息批量收集 | 🟡 P1（[Brief Tool Deep-Dive](./brieftool-async-user-messages-deep-dive.md)）|
| **RemoteTrigger** | — | 远程触发 | 🔴 P3（对应 PR#3929-3931 remote-control 方向）|
| **Team*** | — | 团队协作工具组 | 🔴 P3（企业部署）|
| **Config** | — | 动态 settings 工具 | 🟡 P2（[Config Tool Deep-Dive](./config-tool-dynamic-settings-deep-dive.md)）|
| **SleepTool** | — | 等待 / 节流（内部）| 🔴 P3（内部使用）|
| **PowerShell** | — | Windows 平台 shell | 🟡 P2（跨平台 Windows 支持）|

## 六、Qwen 独有工具（Claude 没有）

| 工具 | LOC | 用途 | 设计亮点 |
|---|---|---|---|
| **monitor** | 742 | 长跑 shell 命令 stdout 流监控 + auto-stop | 4 kinds Background tasks framework（agent / shell / monitor / dream）的 monitor 消费者；max_events / idle_timeout_ms 自动停止；throttling 防止 stdout 洪泛 |
| **save_memory**（顶级 tool）| ~300 | 写入用户级 memory（cross-session）| Claude 通过 services/memdir 层实现，不暴露为 tool |

## 七、共同工具但实现差异

### 7.1 Read 工具：Qwen 后来居上

| 维度 | Claude Code | Qwen Code |
|---|---|---|
| LOC | 1,602 | 440 (read-file.ts) |
| Cache 机制 | LRU 1000 条 + mtime 失效 | session-scoped FileReadCache（`(dev, ino)` key）|
| Prior-read 守卫 | 内置 | PR#3774 + PR#3932 + PR#4002 完整对齐 |
| 二进制检测 | mime + 扩展名 + 4KB sample | PR#4002 同款（KNOWN_TEXT_EXTENSIONS 50+ + mime + sample 3-step）|
| Partial read | 接受 | PR#3932 Edit 路径接受 |
| Image 压缩 | 有 token 上限 | 🟡 部分（参考 [ReadFile Tool Deep-Dive](./read-file-tool-deep-dive.md) 12 项可借鉴）|

**评估**：Qwen 经过 5 PR 跨 13 天系列（PR#3717→3810→3774→3932→4002）已与 Claude 行为对齐。详见 [item-2 文件读取缓存](./qwen-code-improvement-report-p0-p1-engine.md#item-2)。

### 7.2 Bash / Shell：Claude 更严格

| 维度 | Claude Code | Qwen Code |
|---|---|---|
| LOC | 12,411 (18 文件) | 3,652 (单文件 shell.ts) |
| 安全验证 | 23 项 | AST 只读检测 + 命令白名单 |
| 沙箱机制 | 有 | NoSandbox 默认（[§09 daemon-design](./qwen-code-daemon-design/09-multi-tenancy-and-sandbox.md) 已删，External 范畴）|
| 后台运行 | `run_in_background` 字段 | PR#3642 BackgroundShellRegistry + PR#3894 Ctrl+B promote |
| Sed 模拟 | `_simulatedSedEdit` 直接编辑不经 shell | ❌ 无 |
| `dangerouslyDisableSandbox` | 有 | ❌ 无（无沙箱）|

**评估**：Claude Bash 在安全验证 / 沙箱 / 命令分类维度成熟度远超 Qwen，但 Qwen 4 kinds Background framework（PR#3642 + PR#3720 + PR#3791 + PR#3836）是 Claude 没有的 background tasks 统一调度面。

### 7.3 Cron：Qwen 更精细

| 维度 | Claude Code | Qwen Code |
|---|---|---|
| 工具数 | Cron* 一组 | 拆 3 个独立：CronCreate / CronList / CronDelete |
| 持久化 | settings | `~/.qwen/crons.json` |
| 加载方式 | 延迟 | 延迟（PR#3589） |

### 7.4 Skill：Qwen 路径条件激活更准

| 维度 | Claude Code | Qwen Code |
|---|---|---|
| Path-conditional 激活 | 基于 tool 输入路径 | **PR#3852 基于 discovered 路径**（更广覆盖：glob / grep / ripGrep 结果路径都触发激活）|
| 防伪造路径 | — | PR#3852 仅信任 filesystem 工具的 result-side metadata + structured ripgrep |
| 热重载 slash 命令 | — | **PR#3923 (2026-05-08)** `SkillManager.addChangeListener` 触发 slash commands 重载 |
| Symlink 支持 | — | **PR#3915 (2026-05-07)** 允许 symlink 指向 skills 目录外 |

**评估**：Qwen Skill 在 path-conditional 激活精度 + 热重载 + symlink 灵活性 3 项**反超 Claude**。

## 八、一句话总结

**Claude Code 内置工具数 ~39 vs Qwen Code ~21**（不含 MCP 动态注册），Claude 在工具数量 / ToolSearch 延迟加载策略 / Bash 23 项安全验证 / 工具子组（Task* / Cron* / Worktree* / Team* / PlanMode*）细粒度上更成熟；**Qwen 在 FileReadCache + prior-read 守卫链（5 PR 跨 13 天与 Claude 对齐）/ 4 kinds Background tasks framework + Monitor 工具 / Skill path-conditional 激活（基于 discovered 路径）/ 热重载 + symlink 灵活性 4 项独有优势上反超 Claude**。

**关键设计借鉴方向**：
- 🌟 **Qwen → Claude**：4 kinds Background tasks framework + Monitor 工具；Skill 基于 discovered 路径激活；FileReadCache prior-read 守卫链 5 PR 完整闭环
- 🌟 **Claude → Qwen**：WebSearch 回填（PR#3844 OPEN）；NotebookEdit / Worktree* / Brief / Config 工具组；ToolSearch 与 prefix cache 的 cost-aware 协调（PR#4069 揭示并修复 DeepSeek +214% 成本回归）
