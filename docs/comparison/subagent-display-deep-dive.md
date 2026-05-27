# SubAgent 展示 Deep-Dive——Claude Code vs Qwen Code

> **核心问题**：Claude Code 和 Qwen Code 在运行 SubAgent 时的 UI 展示有何差异？各自的设计哲学与借鉴机会是什么？
>
> 返回 [Qwen Code 改进建议总览](./qwen-code-improvement-report.md)
>
> **2026-05-04 重大更新**：本文写作于 2026-04 中旬时 Qwen Code SubAgent 还**仅有嵌入式展示**；2026-04-27 → 2026-05-04 在 ~8 天内合并了 **15 个 PR**（PR#3471/3488/3642/3684/3687/3720/3721/3771/3739/3791/3801/3784/3792/3808/3809），Qwen Code 现已**完整实现真正后台并发 + pill+dialog UI + background agent resume + Phase C event monitor + Phase D part(a) 长跑 foreground 后台化提示**——把原"Qwen 借鉴 Claude 的 3 个机会"清单基本兑现，部分设计还**反超 Claude**。文末"八、相关追踪 item"的状态全部更新为 ✓ 已实现。
>
> **2026-05-22 v0.16.0 更新**：PR#3969（Ctrl+B keybind）/ PR#3970（TaskBase envelope，`flavor` 重命名为 `isBackgrounded`）/ PR#3933（monitor notifications）均已合并入 v0.16.0。Phase D part (b) 完整收官。"追踪中"原 OPEN 项全部关闭。
>
> **2026-05-24 Claude Code v2.1.150 binary 复核**：⚠️ 文档原结论"Claude Code 把同期工程力量放在云端 fleet... 本地 Coordinator panel 维持 v2.1.81 时设计" **部分推翻**。v2.1.150 二进制 `strings` 扫描确认 **`background-tasks-dialog` / `BackgroundTasksSettings` / `BackgroundAppearance`** 三个新组件名稳定存在（v2.1.145 时点已含相同 string count）—— Claude 在 v2.1.132（本文档原对比基线）→ v2.1.145 之间加了 **`/tasks` 单任务 transcript 详情对话框**（prompt + tool calls + result 三段式 + 状态 3 态 start/progress/error）+ **`/daemon` 服务化管理面板**（3 类 services：scheduled task / assistant / remote-control server）。原结论"只在云端投入"不成立；但 Qwen "4-kind 统一调度 framework"仍领先 —— Claude `/daemon` 是 systemd-style 长跑服务管理（与 Qwen in-session task 不同维度），`/tasks` 是轻量单任务查看器。具体形态见 §零 [`background-tasks-dialog` 实际形态](#background-tasks-dialog-实际形态2026-05-24-binary-反编译)。
>
> **2026-05-26 PR#4477 in flight**：wenshao 2026-05-24 开 [PR#4477](https://github.com/QwenLM/qwen-code/pull/4477) `feat(cli): dense inline panel + keyboard navigation for parallel agent fan-out` (target `main`, +809/-95 12 files, 9 commits, OPEN REVIEW_REQUIRED) —— LiveAgentPanel 上**再加一层 inline dense panel + 完整键盘导航**，与 Claude Coordinator 拉开第二层差距。两个新能力：① **`InlineParallelAgentsDisplay`** —— `/review` 等 ≥2 parallel agent fan-out 组现在不再走 `CompactToolGroupDisplay` 的 `Agent × 9 / <last name>` 单行折叠或 `ToolMessage` 全展开，而是渲染密集面板（每 agent 一行：status `○`/`✔` · name · activity · elapsed · tokens）；live + committed 两阶段都渲；committed 入 `<Static>` 永久 scrollback。② **LiveAgentPanel 键盘导航**：`main` 作首行 + agent rows；输入框 `↓` focus panel 选 `main`；`↑↓` 在 `main` + agent 间导航带 `▸` 指示；`Enter` 直开 `BackgroundTasksDialog` detail 模式；`Esc` / `↑-at-top` 回输入框；新 `detail-from-panel` dialog 模式 `←` 回 panel 而非 list；可打印字符自动失焦 type 入输入框；`LiveAgentPanel.DEFAULT_MAX_ROWS` 5→12 让 9 个 `/review` agent 全可见。详 [§六.14](#已落地-14inline-dense-panel--liveagentpanel-keyboard-navpr4477-2026-05-24-open)。

## 零、最新动态（截至 2026-05-24，含 v0.16.0 release + Claude v2.1.150 binary 复核）

### TL;DR

到 2026-05-22（v0.16.0 release），Qwen Code 在 subagent display 上**所有 P0/P1 改进已合并**：

- 🌟 **PR#3909 ✓ 2026-05-07 13:38** —— Qwen Code **直接 port Claude Code 的 `CoordinatorTaskPanel` 模式**：移除 inline `AgentExecutionDisplay`，加 **always-on `LiveAgentPanel`** 锚定在**输入框 footer 下方**，一行一个 agent，右列 pin elapsed + tokens。+ **PR#3919 ownership filter follow-up**（闭合 review 标出的 panel-owned 重复渲染问题）
- **Background tasks roadmap (#3634) 四阶段**全部落地（2026-05-04 收官）+ **Phase D part (b) 完整收官**（foreground → background promote，PR#3894 ✓ PR-2 of 3 + **PR#3969 ✓ PR-3 of 3 Ctrl+B keybind，均已合并入 v0.16.0**）
- **Kind framework 4 消费者全到齐**：agent / shell / monitor / **dream**（PR#3836，2026-05-06）
- **foreground subagents 也接入 pill+dialog**（PR#3768，2026-05-06，闭合前/后台 UI 对偶）
- **Subagent 稳定性与隔离 6 PR 套**：context auto-compact（PR#3735）+ Config 隔离（PR#3873 + PR#3887 + **PR#3892 第三 wrapper site 闭合**）+ **PR#3707 per-agent ContentGenerator view**（不同 model 的 subagent 看到正确 modality）+ approval banner 修复（PR#3956）
- **🌟 PR#3539 `/branch` (`/fork` alias) session 分支** ✓ 2026-05-08 MERGED（slash 命令 + JSONL 复制 + atomic create + rollback-safe swap）
- **PR#3880 searchable `/resume` picker** ✓ 2026-05-08 MERGED（free-text + j/k preview + Ctrl+B branch toggle）

→ **PR#3909 是设计收敛事件**：之前 Qwen 选择"折叠 pill / 按需 dialog"差异化，现在选**主动对齐 Claude pattern**，理由是 PR#3768 抑制 inline 后 live phase 完全不可见——LiveAgentPanel 补上这个缺口比保留差异化更重要。Qwen 的双层 UI（**LiveAgentPanel always-on glance** + **BackgroundTasksDialog 按需 detail**）现在比 Claude 单层 Coordinator panel 更精细。

### 历史里程碑：Background tasks roadmap (#3634) 四阶段

| Phase | 内容 | 收官 PR | 时间 |
|---|---|---|---|
| **A** | 后台 subagents | PR#3076 | 早期 ✓ |
| **B** | managed background shell pool + `/tasks` + dialog 整合 | PR#3642 / PR#3720 / PR#3801 | 2026-05-03 ✓ |
| **C** | event monitor tool + dialog 集成 | PR#3684 / PR#3791 / PR#3792 | 2026-05-04 ✓ |
| **D part (a)** | 长跑 foreground bash 后台化提示 | PR#3809 | 2026-05-04 ✓ |

四阶段加上 PR#3471/3488 控制面 + UI、PR#3687 整合、PR#3739 resume、PR#3721 显示稳定性，形成完整的多模态后台任务调度系统。详见 [§六 各小节](#六qwen-code-已落地的-6-项--2-项反超-claude)。

### v0.15.9 后续合并（2026-05-06 → 05-08 v0.15.9 期间，**11 PR**；PR#3969/3970/3933 继续合并入 v0.16.0）

| PR | 合并 | 一句话 | 详情 |
|---|---|---|---|
| [PR#3836](https://github.com/QwenLM/qwen-code/pull/3836) | 2026-05-06 | 🌟 Kind framework 第 4 消费者：dream 任务 | [§六.7](#已落地-7kind-framework-第-4-消费者dream-任务pr3836) |
| [PR#3768](https://github.com/QwenLM/qwen-code/pull/3768) | 2026-05-06 | 🌟 foreground subagents 路由到 pill+dialog | [§六.8](#已落地-8foreground-subagents-也接入-pilldialogpr3768) |
| [PR#3735](https://github.com/QwenLM/qwen-code/pull/3735) | 2026-05-06 | 🌟 subagent 上下文 auto-compact 防溢出 | [§六.9](#已落地-9subagent-稳定性与隔离pr3735--pr3873--pr3887) |
| [PR#3873](https://github.com/QwenLM/qwen-code/pull/3873) | 2026-05-07 02:31 | 🔧 subagent Config 真正隔离（PR#3774 follow-up）| [§六.9](#已落地-9subagent-稳定性与隔离pr3735--pr3873--pr3887) |
| [PR#3887](https://github.com/QwenLM/qwen-code/pull/3887) | 2026-05-07 05:43 | 🔧 foreground-fork path 漏掉的 ToolRegistry stop（PR#3873 review follow-up）| [§六.9](#已落地-9subagent-稳定性与隔离pr3735--pr3873--pr3887) |
| **[PR#3909](https://github.com/QwenLM/qwen-code/pull/3909)** | **2026-05-07 13:38** | 🌟🌟 **重大收敛**：移除 inline `AgentExecutionDisplay`，新加 always-on `LiveAgentPanel` port Claude `CoordinatorTaskPanel` 模式 | [§六.10](#已落地-10liveagentpanel-port-claude-coordinatortaskpanel-模式pr3909) |
| **[PR#3539](https://github.com/QwenLM/qwen-code/pull/3539)** | **2026-05-08 11:34** | 🌟 **`/branch` (`/fork` alias) session 分支**：slash 命令 fork session 创建分支副本（JSONL 复制 + `forkedFrom` stamp + 原子创建 + rollback-safe swap），对标 Claude `--fork-session` flag | [§六.11](#已落地-11branch-alias-fork-session-分支pr3539) |
| [PR#3919](https://github.com/QwenLM/qwen-code/pull/3919) | 2026-05-08 05:42 | 🔧 **LiveAgentPanel ownership filter**（PR#3909 review follow-up）：闭合 panel-owned subagent rows 通过 ToolGroupMessage 漏到 live area 的重复渲染 + post-delete `statusChange` emit | [§六.10 followup](#已落地-10liveagentpanel-port-claude-coordinatortaskpanel-模式pr3909) |
| [PR#3892](https://github.com/QwenLM/qwen-code/pull/3892) | 2026-05-08 05:42 | 🔧 **runForkedAgent YOLO wrapper 第三 Config-wrapper site 闭合**（PR#3873 review follow-up）：YOLO override + 每 fork FileReadCache + memory-extraction 都修复 | [§六.9 followup](#已落地-9subagent-稳定性与隔离pr3735--pr3873--pr3887) |
| **[PR#3894](https://github.com/QwenLM/qwen-code/pull/3894)** | **2026-05-08 11:56** | 🌟 **foreground → background promote 集成**（Phase D part (b) PR-2 of 3 #3831）：shell tool 检测 background-promote abort，snapshot 输出到 `bg_xxx.output` 文件，注册 `BackgroundShellEntry`，return ToolResult 指向 `/tasks` / dialog / `task_stop` | [§六.12](#已落地-12foreground--background-promote-pr3894-pr3969) |
| [PR#3956](https://github.com/QwenLM/qwen-code/pull/3956) | 2026-05-08 12:20 | 🔧 **subagent approval banner 显示 tool details**：compactMode early-return 修复，让 banner 渲染完整 body（command / file diff / MCP tool）而非只 agent name + 通用 prompt | [§六.13](#已落地-13subagent-approval-banner-工具细节pr3956) |
| **[PR#4477](https://github.com/QwenLM/qwen-code/pull/4477)** | **2026-05-24 08:37 🔧 OPEN** | 🌟🌟 **inline dense panel + LiveAgentPanel keyboard nav** for parallel agent fan-out（`/review` 等 ≥2 agent 场景）：新 `InlineParallelAgentsDisplay` 1 行/agent（status·name·activity·elapsed·tokens）替代 `Agent × 9 / <last name>` 折叠；LiveAgentPanel `↓` from input · `↑↓` navigate · Enter detail · Esc back · maxRows 5→12 | [§六.14](#已落地-14inline-dense-panel--liveagentpanel-keyboard-navpr4477-2026-05-24-open) |

### 追踪中（2026-05-22 更新：原 OPEN 项已全部合并入 v0.16.0；2026-05-26 新增 PR#4477 in flight）

- ✅ **[PR#3969](https://github.com/QwenLM/qwen-code/pull/3969) Ctrl+B promote keybind**（✓ 已合并入 v0.16.0，#3831 PR-3 of 3）—— foreground → background promote 的 UI 终结篇，加 Ctrl+B 用户键绑（详见 [§六.12](#已落地-12foreground--background-promote-pr3894-pr3969)）
- ✅ **[PR#3970](https://github.com/QwenLM/qwen-code/pull/3970) TaskBase envelope + foreground subagent persistence**（✓ 已合并入 v0.16.0）—— 引入 shared `TaskBase` envelope；foreground subagent 也接入 JSONL transcript writer + meta sidecar；agent-task discriminator 从 `flavor: 'foreground' \| 'background'` **正式重命名为 `isBackgrounded: boolean`**（旧名保留一个版本作 type alias）
- ✅ **[PR#3933](https://github.com/QwenLM/qwen-code/pull/3933) monitor notifications routing for subagents**（✓ 已合并入 v0.16.0）—— Monitor 通知路由到启动 monitor 的 owning subagent，修复 subagent-owned monitors 污染 parent context 的问题
- 🔧 **[PR#4477](https://github.com/QwenLM/qwen-code/pull/4477) inline dense panel + LiveAgentPanel keyboard nav**（OPEN REVIEW_REQUIRED 2026-05-24，wenshao 自开自迭代 9 commits）—— 对**纯并行 agent 组**（`/review` 9-agent fan-out 类）渲 `InlineParallelAgentsDisplay` 密集面板（1 行/agent 含 live activity）替代 `Agent × 9` 折叠；LiveAgentPanel 加完整键盘路径（`↓` from input · `↑↓` navigate · Enter detail · Esc back · `←` from detail 回 panel）；`DEFAULT_MAX_ROWS` 5→12；详 [§六.14](#已落地-14inline-dense-panel--liveagentpanel-keyboard-navpr4477-2026-05-24-open)
- ❌ **monitor → `send_message` 集成** — PR#3684 自述"未做"清单第 2 项。`task_stop` 已通过 PR#3791 覆盖；`send_message` 因 monitor 语义模糊被推迟（详见 [§六.5](#已落地-5phase-c-event-monitor-toolpr3684-系列追踪以来最大单-pr)）
- 🟡 **`/agents --history` 归档对比视图** — 当前 `BackgroundTasksDialog` 偏运行时管理，历史归档 + 对比 diff 仍未实现
- 🆕 **Claude Code Ultrareview**（云端 fleet）— v2.1.132 Week 17 public preview，云端 fleet 并行 review agents → CLI/Desktop。与 Qwen 本地 background subagents 思路**正交**（云端 vs 本地）—— v2.1.150 仍稳定，未停止扩张（binary 含 29 处 `Ultrareview` + 31 处 `Ultraplan` 提示）
- 🆕 **Claude Code 本地 background-tasks-dialog**（v2.1.132 → v2.1.145 间引入）—— v2.1.150 binary 含 `background-tasks-dialog` / `BackgroundTasksSettings` / `BackgroundAppearance` 三个新组件名，意味着 Claude 也加了**本地** background tasks 对话框。**反驳**文档原结论"Claude 维持 v2.1.81 设计"
  - Qwen daemon External Reference Architecture SaaS 方向上能包装类似产品：[§06 §七 vs Anthropic Managed Agents](./qwen-code-daemon-design/06-roadmap.md)
  - Claude Code 端详见 [§23-recent-updates](../tools/claude-code/23-recent-updates.md)

### Claude Code 同期参照（v2.1.81 → v2.1.150，~10 周）

**关键观察：Claude Code 主 Coordinator panel 设计在同期保持稳定，所有新特性都是正交扩展。**

| Claude Code 子系统 | 自 v2.1.81 起的变化 | 影响 Coordinator panel？ |
|---|---|---|
| `CoordinatorAgentStatus.tsx`（输入框下方常驻面板）| 无架构改动 | ✗ |
| `LocalAgentTask` 状态机 / `TaskListV2.tsx` 30s TTL | 无改动 | ✗ |
| `AgentProgressLine` / `AgentTool` 内联 | 无改动 | ✗ |
| 4 状态分类 | 仍 running / completed / failed / canceled | ✗ |

**v2.1.120 增强**：v2.1.120（2026-04-28）`/agents` 库列表加 **`● N running`** 计数指示——让用户在 agent 定义库视图中看到当前活跃实例数量。

**v2.1.132 → v2.1.145 间增强**（**2026-05-24 binary 复核新发现**）：v2.1.145+ 的 `claude` binary `strings` 含以下新组件名（v2.1.132 当时未确认存在）：
- `background-tasks-dialog` — **本地 background tasks 对话框**
- `BackgroundTasksSettings` — 设置面板
- `BackgroundAppearance` — 外观自定义

意味着 Claude 在云端 fleet (Ultraplan / Ultrareview / Routines) 之外，也在 v2.1.132~145 间加了本地 background tasks UI surface。具体何时引入 + 完整 UX 形态需要 v2.1.133-144 binary 对比 + leaked source 更新才能精确（leaked source 自 2026-04-25 无新 commit，已落后）。

#### `background-tasks-dialog` 实际形态（2026-05-24 binary 反编译）

直接从 v2.1.150 binary 周边 JS（React Ink 组件源码）反编译挖出的实际形态：

**1. 触发**：`/tasks` slash command

- Enable 逻辑：`function nw(){ if (t4(process.env.CLAUDE_CODE_ENABLE_TASKS)) return false; return true; }` —— **default-on**；env `CLAUDE_CODE_ENABLE_TASKS=true` (truthy) 反而**禁用** tasks（kill-switch 语义）
- Hint 字符串："Task IDs can be found using the /tasks command"

**2. Dialog 实际渲染**（line 717320 React Ink 组件源码反编译）：

```
┌─ Background task dialog (单任务详情) ─────────────┐
│ <label>                  ·  <metadata pills>      │
│                                                   │
│ Error                                             │ ← state==='error' 时显示
│   <error message>                                 │
│                                                   │
│ Loading transcript…                               │ ← async transcript loading
│ — 或 —                                            │
│ Transcript not yet available (agent still         │ ← state==='start'/'progress'
│   running).                                       │
│ — 或 —                                            │
│ Transcript unavailable.                            │
│                                                   │
│ Prompt                                            │
│   <prompt 第 1 行>                                │
│   <prompt 第 2 行>                                │
│   <prompt 第 3 行>                                │
│   … N more lines                                  │
│                                                   │
│ Tool calls (N)                                    │
│   … M earlier                                     │
│   <tool name> (<summary>)                         │ ← 最近 5 个，更早 collapse
│   ...                                             │
│                                                   │
│ Result                                            │
│   … X more above                                  │
│   <syntax-highlighted result.json>                │ ← code block 或 plain text
│   … Y more below                                  │
└───────────────────────────────────────────────────┘
```

**3. 状态 enum**：`'start' | 'progress' | 'error'` —— 3 态（不是 Qwen 那种 active/achieved/aborted/cleared 4 态 goal-style）

**4. 任务字段**（list entry 用的）：`id` / `name` / `label` / `kind` / `status` / `model` / `cwd` / `owner` / `started` / `action` —— **`kind` 字段说明 Claude 也有"任务种类"概念**（与 Qwen 4-kind framework 同构？需要进一步源码核查）

**5. 配套 `/daemon` slash command**（另一个相关命令）：

```
{type:'local-jsx', name:'daemon', immediate:true,
 description:'Manage background services: assistants, scheduled tasks, and remote control'}
```

**3 类 services**：
| Kind | Label |
|---|---|
| `scheduled` | `"scheduled task"`（cron / 定时任务）|
| `assistant` | `"assistant"`（agent 实例）|
| `remoteControl` | `"remote-control server"`（远程控制 server）|

**Action 按钮**：`uninstall: "Uninstall service"` / `stop: "Stop"`

**与 Qwen Code `/tasks` 对照**：

| 维度 | Claude v2.1.150 | Qwen v0.16.0 |
|---|---|---|
| **触发命令** | `/tasks` + `/daemon` 双命令 | `/tasks` 单命令 |
| **状态枚举** | `start` / `progress` / `error` 3 态 | `running` / `completed` / `failed` / `cancelled` ... 多态 |
| **任务种类（kind）** | 字段存在但未确认 enum | **4 kind 明确**：agent / shell / monitor / dream |
| **统一调度抽象** | 待源码核查（dialog 字段看是分类 list 而非统一调度）| ✅ 4-kind 走同 framework |
| **transcript 详情** | ✅ Prompt + Tool calls (last 5) + Result 三段式 | ✅ AgentDialog 含 transcript |
| **scheduled task / cron 类** | ✅ `/daemon scheduled` 独立 service | ❌（用户层无 cron task） |
| **remote-control server 类** | ✅ `/daemon remoteControl`（与 Ultraplan/Ultrareview 关联）| ❌ |
| **服务化管理** | ✅ daemon-level services 概念（install/uninstall）| ❌（Qwen 是 session-level task） |

**关键判断**（2026-05-24 binary 复核后）：
- Claude `/tasks` dialog 是**轻量的单任务详情查看器**（prompt + tools + result 三段式），不是 Qwen LiveAgentPanel 那种 always-on multi-task overview
- Claude `/daemon` 是**服务化管理面板**（cron task / assistant / remote-control），更接近 systemd-style "long-running services"，与 Qwen 的"in-session background task"概念**不同维度**
- Claude **可能没有 Qwen 那种 4-kind 统一调度 framework**（dialog UI 看任务是按 kind 字段分类列出，但能否跨 kind 共用 scheduler 待源码确认）
- 因此原"Qwen 在 background tasks framework 上仍领先 Claude"判断**仍成立**，但需限定为"**4-kind 统一调度框架方向**"领先；Claude 在"长跑服务管理"+"transcript 详情查看"另有自己的设计

**5 个正交新特性**（均不改动 Coordinator panel）：

| 特性 | 周期 | 为何正交 |
|---|---|---|
| **Auto Mode** permission classifier（research preview）| Week 13 | 工作在权限决策层；UI 仅是 footer mode pill |
| **Computer Use**（research preview）| Week 14 | GUI 自动化结果**内联在 task tool 输出**，不进 Coordinator |
| **Ultraplan**（early preview）| Week 15 | 云端 plan editor，CLI 仅触发，结果在 web session |
| **Routines on Web** | Week 16 | 完全 web-only，CLI 仅 schedule 创建 |
| **Ultrareview** cloud fleet（public preview）| Week 17 | 云端 fleet 跑，"findings 异步回 CLI/Desktop" 但**实现细节未公开**（不确定是否复用 Coordinator panel 还是新 UI） |

**对比启示**：

| 维度 | Claude Code v2.1.81→150 | Qwen Code 同期（2026-04-27 → 05-22）|
|---|---|---|
| Coordinator / 主 panel 架构 | 稳定，无改动 | 多次迭代（pill + dialog + 4 kinds + foreground 同框）|
| 状态分类 | 4 状态稳定 | 同 4 状态（继承 Claude 思路）|
| Agent kind 框架 | 单一 LocalAgentTask | **4 kinds**（agent / shell / monitor / dream）|
| foreground subagent UI | inline 渲染（v2.1.81 起未变）| **inline + pill+dialog 双模式**（PR#3768 闭合闪烁）|
| subagent 隔离 | 共享 parent registry | **subagent 独立 Config + tool registry**（PR#3873）|
| subagent 上下文溢出 | 主 agent 才 compact | **subagent 也走相同 compaction trigger**（PR#3735）|
| 创新方向 | **云端 fleet（Ultrareview） + GUI（Computer Use）正交扩展** | **本地 subagent 设计深耕**（4 kinds + UI 同框 + 隔离 + 稳定性）|

**核心判断**（2026-05-24 复核后修订）：
- **到 2026-05-22 v0.16.0**，Qwen Code 在本地 background tasks framework 设计上**仍领先 Claude Code**（4-kind: agent/shell/monitor/dream 统一调度 + pill+dialog UI + foreground↔background promote + Ctrl+B keybind 全套）。
- **但原"Claude 维持 v2.1.81 设计"已部分推翻**：v2.1.150 binary 含 `background-tasks-dialog` / `BackgroundTasksSettings` / `BackgroundAppearance`，Claude 也在 v2.1.132→145 间加了本地 background tasks 对话框。Claude 并非只押云端 fleet。
- 准确说法：**Claude 同时投入云端 fleet（Ultraplan / Ultrareview / Routines）+ 本地 background tasks dialog**；具体 UX 形态 / 是否对齐 Qwen 4-kind framework 仍需源码级核查。

**研究来源**：[Claude Code §23 v2.1.82-132 增量](../tools/claude-code/23-recent-updates.md)（已落后到 v2.1.132，待更新到 v2.1.150）+ **2026-05-24 v2.1.150 binary `strings` 扫描**（claude-code-leaked 自 2026-04-25 无新 commit）。Ultrareview 云端 fleet + 新本地 background-tasks-dialog 的 CLI UI 呈现细节官方未公开，需后续观察。

---

## 一、两条不同的 UI 哲学

### Claude Code = 双模式
1. **Task 工具内联模式**（`AgentTool.tsx`）——主消息流内展示，完成即收
2. **Coordinator 后台面板**（`CoordinatorAgentStatus.tsx`）——独立常驻面板渲染在**输入框 footer 下方**（屏幕底部），多 agent 并发，30s TTL 自动驱逐

### Qwen Code = 双模式（2026-04-28 起）
1. **嵌入式 `AgentExecutionDisplay.tsx`**（原有）—— 作为工具结果嵌入消息流，三档可折叠展示（compact / default / verbose），Ctrl+E / Ctrl+F 切换
2. **Background tasks 调度面**（PR#3471/3488/3642 新增）—— 状态行 `BackgroundTasksPill` + 按 Down 键打开 `BackgroundTasksDialog` + Enter 进详情 + `x` 取消；**SubAgent 与后台 shell 共用同一调度面**

> **设计差异**：Claude **输入框下方常驻面板**（屏幕最底部，源码注释 "Renders below the prompt input footer"，任何时候都能看见），Qwen 状态行**pill 提示 + 按需打开对话框**（默认折叠节省屏幕空间）。两种 UX 偏好不同：Claude 偏"持续可见"，Qwen 偏"需要时才占空间"。
>
> 典型 Claude TUI 屏幕布局：
> ```
> ┌─ 消息流 / Scrollback ─────────────┐
> │ user: ...                          │
> │ ⏺ Task(...) ⎿ summary              │
> │ ...                                │
> ├────────────────────────────────────┤
> │ > [输入框]                         │  ← prompt input
> ├────────────────────────────────────┤
> │ ⏵ mode: default · …                │  ← input footer
> ├────────────────────────────────────┤
> │ ◯ agent-A · ▶ 5s                   │  ← CoordinatorAgentStatus
> │ ◯ agent-B · ▶ 12s                  │     (在 footer 下方)
> │ ✕ agent-C · failed (10s ago)       │
> └────────────────────────────────────┘
> ```

---

## 二、逐维度对比

| 维度 | Claude Code | Qwen Code |
|---|---|---|
| **发起展示** | Task：内联 `⏺ Task(...)` ⎿ 摘要<br>Coordinator：输入框下方常驻面板 `○ name · ▶ 0s` | 嵌入：工具组 `├─ agent_name ● Running`<br>**Background：状态行 pill + Down 键打开 dialog**（PR#3488）<br>**LiveAgentPanel：输入框下方常驻面板 `○ name (activity) ▶ Ns · Nk tokens`**（PR#3909，port Claude pattern）<br>**🆕 InlineParallelAgentsDisplay：≥2 并行 agent 组的密集面板**，1 行/agent 含 live activity + elapsed + tokens（PR#4477 OPEN，反超 Claude `Agent × 9` 折叠）|
| **SubAgent 身份** | `AgentProgressLine.tsx:75` 彩色背景标签 | `AgentExecutionDisplay.tsx:148` 彩色 `agentColor` + StatusDot |
| **执行中实时性** | Task：spinner + 最终结果<br>Coordinator：仅最后一个工具 + 计数（1s tick）| 嵌入：**完整工具列表**（默认最后 5 个，verbose 全部）<br>**Dialog：Running/Completed/Failed/Cancelled 4 类状态**（PR#3488）|
| **展示模式切换** | Task 固定；Coordinator `↑↓`+Enter 导航 | 嵌入：**Ctrl+E / Ctrl+F 三档切**（compact ↔ default ↔ verbose）<br>Dialog：`↑↓` 导航 + Enter 进详情 + Left/Esc 关闭 |
| **并发布局** | Coordinator 垂直列表 `◯ A / ◯ B / ◯ C` | 嵌入：同工具组内 `.map()` 渲染<br>**Dialog：列表视图 + per-agent rolling tool activity buffer**（PR#3488）|
| **权限审批路由** | Task 内部黑盒；Coordinator 独立流 | **焦点锁**（`focusedSubagentRef` + `isWaitingForOtherApproval`）|
| **完成后摘要** | `RECENT_COMPLETED_TTL_MS = 30_000` 自动驱逐 | 嵌入：4 行执行摘要长期保留<br>**Dialog：完成后保持可见，用户主动管理**（与 Claude 不同选择，PR#3488）|
| **失败处理** | Coordinator `✕ Failed (Ns ago)` → 30s 后驱逐 | 嵌入：红色 `├─ ✕ Failed` 永久保留<br>**Dialog：4 状态分类 Running/Completed/Failed/Cancelled，明确区分非 GOAL 终止**（PR#3488）|
| **独立管理视图** | `/agents` + `AgentsMenu` / `AgentsList`（agent 定义）| `/tasks` 命令 + dialog（PR#3642，运行时管理）|
| **后台并发能力** | ✅ 真后台（`evictAfter` 驱动，独立 loop） | **✅ 真后台**（PR#3471 `task_stop` / `send_message` / per-agent transcript 控制面 + PR#3488 UI）|
| **后台 shell 与 SubAgent 调度面** | **分离**（BashOutput / Background shells 与 Coordinator panel 独立）| **统一**（PR#3720 把后台 shell + SubAgent 合并到同一 dialog · pill / 导航 / 详情视图共用）—— **超越 Claude** |
| **agent resume / continuation** | ✅ `tools/AgentTool/resumeAgent.ts:resumeAgentBackground()` | **✅ + transcript-first fork resume**（PR#3739 +4087/-165 · `BackgroundAgentResumeService` + paused 生命周期 + `SubagentStart` hook 重放）—— **比 Claude 更稳健** |
| **取消语义** | `x` 立即驱逐 | `x` 取消 + 状态变为 Cancelled（PR#3488 区分"取消"与"驱逐"）|

---

## 三、关键代码片段

### 3.1 Claude Coordinator Task Panel（`CoordinatorAgentStatus.tsx`）

**渲染条件**（文件头注释原文）：

> CoordinatorTaskPanel —— Steerable list of background agents.
> Renders below the prompt input footer whenever local_agent tasks exist.
> Visibility is driven by `evictAfter`: `undefined` (running/retained) shows always; a timestamp shows until passed. Enter to view/steer, x to dismiss.

**核心逻辑**：

```typescript
// L31-33：可见任务 = 非已驱逐 + 按 startTime 排序
export function getVisibleAgentTasks(tasks: AppState['tasks']): LocalAgentTaskState[] {
  return Object.values(tasks)
    .filter((t): t is LocalAgentTaskState => isPanelAgentTask(t) && t.evictAfter !== 0)
    .sort((a, b) => a.startTime - b.startTime)
}

// L45-63：1s tick：重渲染 elapsed + 驱逐过期任务
React.useEffect(() => {
  if (!hasTasks) return
  const interval = setInterval((tasksRef, setAppState, setTick) => {
    const now = Date.now()
    for (const t of Object.values(tasksRef.current)) {
      if (isPanelAgentTask(t) && (t.evictAfter ?? Infinity) <= now) {
        evictTerminalTask(t.id, setAppState)
      }
    }
    setTick(prev => prev + 1)
  }, 1000, tasksRef, setAppState, setTick)
  return () => clearInterval(interval)
}, [hasTasks, setAppState])

// L72-75：垂直列表：MainLine + N 个 AgentLine
return <Box flexDirection="column" marginTop={1}>
  <MainLine ... />
  {visibleTasks.map((task, i) => 
    <AgentLine task={task} onClick={() => enterTeammateView(task.id, setAppState)} />
  )}
</Box>
```

**设计精妙之处**：
- `evictAfter` 作为**数据驱动的可见性**，不是"已完成"而是"过期时间戳"——支持 `x` 键立即驱逐（`evictAfter = 0`）、30s 延迟驱逐、永久保留（`undefined`）
- 1s `setInterval` 同时负责**elapsed time 刷新** + **驱逐**，单一 tick 源避免多定时器竞争
- `tasksRef` + `setTick` 解耦——`useEffect` 依赖只有 `hasTasks`，不依赖 `tasks` 避免每次 task 变化重建 interval

### 3.2 Qwen Code `AgentExecutionDisplay` 三档切换

```typescript
// AgentExecutionDisplay.tsx:124-140
useKeypress((key) => {
  if (key.ctrl && key.name === 'e') {
    // compact ↔ default
    setDisplayMode(current => current === 'compact' ? 'default' : 'compact')
  } else if (key.ctrl && key.name === 'f') {
    // default ↔ verbose
    setDisplayMode(current => current === 'default' ? 'verbose' : 'default')
  }
}, { isActive: true })
```

**三档信息密度**：

| 模式 | 显示内容 | 用途 |
|---|---|---|
| `compact`（默认）| Agent 名 + status + 当前工具 + `+N more tool calls (ctrl+e to expand)` | 平静浏览 |
| `default`（Ctrl+E）| 任务描述 + 最后 5 个工具 + 执行摘要 | 查看进展 |
| `verbose`（Ctrl+F）| 完整任务 + 全部工具 + 详细统计 | 深度调试 |

### 3.3 Qwen Code `ToolGroupMessage` 焦点锁

```typescript
// ToolGroupMessage.tsx:99-123
const subagentsAwaitingApproval = useMemo(
  () => toolCalls.filter(tc => isAgentWithPendingConfirmation(tc.resultDisplay)),
  [toolCalls],
)

const focusedSubagentRef = useRef<string | null>(null)
const stillPending = subagentsAwaitingApproval.some(
  tc => tc.callId === focusedSubagentRef.current,
)
if (!stillPending) {
  // 焦点移交给第一个等待中的 subagent（first-come first-served）
  focusedSubagentRef.current = subagentsAwaitingApproval[0]?.callId ?? null
}

// 渲染（L256-287）
{toolCalls.map(tool => {
  const isSubagentFocused = isFocused && !toolAwaitingApproval && focusedSubagentCallId === tool.callId
  const isWaitingForOtherApproval = isAgentWithPendingConfirmation(tool.resultDisplay) 
    && focusedSubagentCallId !== null 
    && focusedSubagentCallId !== tool.callId
  return <ToolMessage {...tool} isFocused={isSubagentFocused} isWaitingForOtherApproval={isWaitingForOtherApproval} />
})}
```

**效果**：3 个并发 subagent 都需要审批时，用户只看到**一个审批 prompt**，其他显示 `⏳ Waiting for other approval...`，按序轮转。

---

## 四、典型场景逐帧对比

> **范围说明**：以下场景描述 Qwen Code **嵌入式** SubAgent 模式（`AgentExecutionDisplay`），不涉及 2026-04-28 后新增的 **Background tasks dialog**（`BackgroundTasksPill` + `BackgroundTasksDialog`）。两种模式当前并存——短任务走嵌入式（看到完整工具时间轴），长跑/后台任务走 dialog（pill 显示运行计数 + 按 Down 键打开 dialog）。

### 场景 A：单 SubAgent 10 秒任务

**Claude Code Task 模式**：

```
⏺ Task(Research X)
  ⎿ researcher is thinking...
  ⎿ Running web_search (2s)
  ⎿ Running parse_results (1s)
  ⎿ Done (10s · 1.5K tokens)
     Found 3 relevant sources about...
```

**Qwen Code compact 模式（默认）**：

```
├─ researcher ● Running
│  Task: Research X
│  ⊷ web_search  (ctrl+e to expand)
│  +2 more tool calls
```

10 秒后完成：
```
├─ researcher ✓ Completed  
│  Execution Summary: 3 tool uses · 10s · 1,500 tokens
```

**差异**：Claude 展示**时间轴**（每个工具一行带时长），Qwen 展示**状态摘要**（当前+计数，点击展开）。

---

### 场景 B：3 个并发 SubAgent，第 2 个触发权限审批

**Claude Code Coordinator 模式**：

```
[底部面板]
◯ main
◯ researcher-A · ▶ 2s · 200 tokens
◯ researcher-B · ▶ 2s · 150 tokens  ⚠ needs approval
◯ researcher-C · ▶ 2s · 100 tokens
```

用户按 `↓↓` 选中 B，按 Enter 进入详情视图：
```
researcher-B
├─ Task: Research B
├─ Running web_fetch
└─ ⚠ Approval required: Allow web access to example.com?
   [y/n/s/d]
```

审批后按 ESC 回主视图。

**Qwen Code 嵌入模式**：

```
├─ Tool Group
│  ├─ researcher-A ● Running
│  │  ⏳ Waiting for other approval...
│  ├─ researcher-B ● Running  ← (focused)
│  │  ┤ Confirm: Allow web access to example.com?
│  │  └─ [y/n/s/d]
│  ├─ researcher-C ● Running
│  │  ⏳ Waiting for other approval...
```

用户在**主视图直接输入 y/n**，无需导航切换。审批后焦点自动切到下一个 subagent。

**差异**：
- Claude = **空间分离**（面板 vs 详情），需要 `↓↓ Enter` + `ESC`
- Qwen = **时间分离**（焦点锁排队），无需导航

---

### 场景 C：SubAgent 失败 + 30s 后

**Claude Code Coordinator**：

```
t=0:  ◯ researcher · ✕ Failed (Network timeout)
t=30: [行消失，被驱逐]
```

用户想看失败详情需要从日志找。

**Qwen Code**：

```
├─ researcher ✕ Failed
│  Failed: Network timeout
│  Attempted 2 tools · 500 tokens · 5s
│  [永久保留在历史中]
```

---

### 场景 D：用户 Ctrl+C 中断 SubAgent

**Claude Code**：取消信号通过 `AbortController` 传递到后台任务；Coordinator 面板状态变为 `canceled`。

**Qwen Code**：Ctrl+C 取消当前工具调用（包括 subagent），UI 显示 `Command was cancelled`。

---

## 五、三大设计哲学差异

### 1. 后台 vs 嵌入

> **2026-05-02 更新**：Qwen 在 2026-04-27 → 2026-05-01 的 5 天内通过 6 个 PR 实现了真后台并发，本表的"Qwen Code"列已分成"嵌入式（原有）"和"Background tasks 调度面（新增）"两栏。

| | Claude Code | Qwen Code 嵌入式（原有）| Qwen Code Background tasks（PR#3471/3488/3642）|
|---|---|---|---|
| **模型** | Coordinator = 输入框下方常驻面板（`AppState.tasks` 独立于主 loop，1s tick）| subagent 作为 tool result 在消息流内 | 状态行 pill + 按需打开 dialog（`task_stop` / `send_message` 控制面）|
| **生命周期** | `evictAfter` 时间戳控制可见性，30s TTL 自动驱逐 | 随消息树追加，tool 调用结束 = subagent 结束 | **保持可见，用户主动 `x` 取消**（4 状态：Running/Completed/Failed/Cancelled）|
| **能力** | 支持"最小化继续运行" | 必须在 tool 周期内完成（适合短任务）| **支持"最小化继续运行" + transcript-first fork resume**（PR#3739）|
| **代价** | AppState 内存占用 | 消息流可能变长 | dialog 状态需用户主动管理 |

**结论**：Qwen 现在**两种模式并存**——短任务嵌入消息流（用户能看到完整工具列表），长任务进入 background dialog（不阻塞主交互流）。这比 Claude 的"Task 内联 / Coordinator 独立"二分更灵活。

> **同期 Claude Code 现状（v2.1.82 → v2.1.150，~10 周）**：Coordinator panel + 异步 Subagent 调用形态**leaked source 自 2026-04-25 无新 commit 无法源码确认**；v2.1.150 binary `strings` 显示 **Claude 已在 v2.1.132→145 间加 `background-tasks-dialog` / `BackgroundTasksSettings` / `BackgroundAppearance`**（本地 background tasks 对话框 + 设置 + 外观）—— Claude 并非只押云端 fleet。Auto Mode / Computer Use / Ultraplan / Ultrareview / Routines 仍是正交方向。详见 [§零 Claude Code 同期参照](#claude-code-同期参照v2181--v21150-10-周)。

### 2. 多模态展示

| | Claude Code | Qwen Code |
|---|---|---|
| **切换方式** | 两种视图，`↑↓ Enter ESC` 导航 | 同视图三档 `Ctrl+E / Ctrl+F` 即切 |
| **信息密度** | 面板行固定格式；详情页完整 | 按需调整（compact → verbose）|

**判断**：**Qwen 的"按键即切档"在这个维度超越 Claude**。`useKeypress` 注册全局快捷键，无需离开当前上下文。

### 3. 权限审批路由

| | Claude Code | Qwen Code |
|---|---|---|
| **机制** | Task 工具内**黑盒**（主 agent 等待）；Coordinator 独立审批流 | `focusedSubagentRef` 焦点锁，一等公民 |
| **并发体验** | 无明确排队机制，多 subagent 权限竞争 | **串行化轮转**，其他 subagent 显式 `⏳ Waiting...` |

**判断**：Qwen 的并发审批 UX 更清晰——用户始终知道"现在处理 B，A/C 等着"。

---

## 六、Qwen Code 已落地的 6 项 + 2 项反超 Claude

> **本节状态变化（2026-04 → 2026-05）**：原本列出 3 个"待借鉴机会"，到 2026-05-04 全部已通过 **15 个 PR** 落地，外加 Qwen 自己**新增了 2 个 Claude 没有的设计**（统一调度面 + transcript-first fork resume）+ Phase C event monitor tool + **Phase D part (a) 长跑 foreground bash 提示**（双层防御机制）。

### 🥇 已落地 1：真正后台并发 + UI 调度面（PR#3471/3488/3642）✓

**Claude 源码**：
- `CoordinatorAgentStatus.tsx:45-63` —— 1s tick 驱动 elapsed + 驱逐
- `TaskListV2.tsx:21` —— `RECENT_COMPLETED_TTL_MS = 30_000`
- `tasks/LocalAgentTask/LocalAgentTask.js` —— 任务状态机

**Qwen 落地状态**：

| 层 | PR | 实现 |
|---|---|---|
| 模型侧控制面 | [PR#3471](https://github.com/QwenLM/qwen-code/pull/3471) ✓ 2026-04-27 | `task_stop` / `send_message` / per-agent transcript 工具，对标 Claude `TaskStop` / `SendMessage` |
| UI 层 | [PR#3488](https://github.com/QwenLM/qwen-code/pull/3488) ✓ 2026-04-28 | `BackgroundTasksPill`（状态行运行计数）+ `BackgroundTasksDialog`（Down 键打开）+ detail view（Enter 进详情）+ cancel flow（`x` 键）+ Running/Completed/Failed/Cancelled 4 状态 |
| `/tasks` 命令 + shell pool | [PR#3642](https://github.com/QwenLM/qwen-code/pull/3642) ✓ 2026-04-28 | managed background shell pool + `/tasks` 命令（CLI 入口）|

**与 Claude 的设计差异**：
- Claude **输入框下方常驻面板**；Qwen **状态行 pill + 按需打开 dialog**（默认折叠节省屏幕空间）
- Claude **30s TTL 自动驱逐已完成**；Qwen **保持可见，用户主动管理 + `x` 显式取消变为 Cancelled**
- Claude 4 状态：running / completed（隐式 success / failure）；Qwen **明确 4 类**：Running / Completed / Failed / Cancelled（区分非 GOAL 终止）—— **比 Claude 更显式**

**3 项超出 Claude 的设计**（PR#3488）：
1. ✨ **4 类状态分类**：明确区分 timeout / max-turn / errors 为 Failed
2. ✨ **per-agent rolling tool activity buffer**（feeds detail view Progress section）
3. ✨ **原始 prompt 保存到 detail view**（用户能看自己最初指令）

---

### 🥈 已落地 2：后台 shell 与 SubAgent 统一调度面（PR#3687/3720）✓ **超越 Claude**

**Claude 设计**：BashOutput / Background shells 与 Coordinator panel 是**两套相对独立的 UI** —— 用户视角下"后台 shell"和"后台 agent"是不同 mental model。

**Qwen 选择把它们合并**：

| PR | 层 | 内容 |
|---|---|---|
| [PR#3687](https://github.com/QwenLM/qwen-code/pull/3687) ✓ 2026-04-29 | 控制层 | 后台 shell 也接入 `task_stop` 工具，模型用单一动作能停 SubAgent + shell |
| [PR#3720](https://github.com/QwenLM/qwen-code/pull/3720) ✓ 2026-04-29 | UI 层 | 后台 shell 与 SubAgent 在 dialog 中合并（统一 pill / 统一导航 / 统一详情视图） |

**意义**：用户视角下"后台任务"是**单一 mental model**——不需要区分"是 shell 还是 agent"。这是 Qwen Code 团队**对 Claude 设计的一次有意识改进**。

---

### 🥉 已落地 3：background-agent resume + continuation（PR#3739）✓ **比 Claude 设计更稳健**

**Claude 源码**：`tools/AgentTool/resumeAgent.ts:resumeAgentBackground()`

**Qwen 落地**（[PR#3739](https://github.com/QwenLM/qwen-code/pull/3739) ✓ 2026-05-01 · **+4087/-165 单 PR 体量爆表**）：

| 能力 | 实现 |
|---|---|
| 持久化发现 | `BackgroundAgentResumeService` 扫描 `subagents/<sessionId>/` |
| 生命周期 | sidecar metadata 记录 `paused` 状态 + registry/UI 表现 |
| **Transcript-first fork resume** | fork bootstrap 写入 `system/agent_bootstrap` + 原始 launch prompt 写入 `system/agent_launch_prompt`，resume 时**从 transcript 历史重建 worker context** 而非从当前父 prompt/tool 状态重建 |
| Hook 重放 | resume 时**重新跑 `SubagentStart` hooks** + 并发 resume 自动 coalesce |
| 控制面 | `send_message` + `task_stop` 处理 paused background agent |
| UI | `/resume` 流程加载 paused tasks + 瞬态恢复提示 |
| 兼容兜底 | 无 bootstrap 记录的 legacy fork transcript 仍可见为 paused 并 abandonable，但**禁止 unsafe resume** |

**比 Claude 更稳健的点**：transcript-first fork resume 避免了父 prompt 漂移导致 fork worker context 重建错误——在多步 agent 链场景下显著降低恢复时的状态污染风险。

---

### 已落地 4：显示稳定性（PR#3721）✓

[PR#3721](https://github.com/QwenLM/qwen-code/pull/3721) ✓ 2026-04-29（+1336/-57）—— `bound SubAgent display by visual height to prevent flicker`。补足并发 subagent 长输出场景下的渲染稳定性。

---

### 已落地 5：Phase C event monitor tool（PR#3684）✓ 系列追踪以来最大单 PR

[PR#3684](https://github.com/QwenLM/qwen-code/pull/3684) ✓ 2026-05-02 12:57 UTC（**+6297/-147**）—— `feat(core): event monitor tool with throttled stdout streaming (Phase C)`。这是 Background tasks roadmap (#3634) 的第三阶段，与已合并的 Phase A（后台 subagents）+ Phase B（PR#3642 background shell pool）形成完整三件套。

> **对齐说明**（2026-05-12 修订，2026-05-24 v2.1.150 复核仍成立）：Claude Code v2.1.139 二进制 `strings` 确认同样内置 `Monitor` 工具（详见 [claude-code-vs-qwen-code-builtin-tools.md §3.12](./claude-code-vs-qwen-code-builtin-tools.md#312-monitor-工具claude-vs-qwen-详细对比)），v2.1.150 仍保留。Phase C 是 Qwen 对齐 Claude Monitor 设计的工程实现，**真正的 Qwen 独有创新是 4 kinds Background tasks framework**（agent/shell/monitor/dream 统一调度抽象）而非 monitor 工具本身——v2.1.150 binary 新增的 `background-tasks-dialog` 暂无证据它能跨多种 kind 统一调度（仍待源码确认）。

**新增能力**：

| 组件 | 实现 |
|---|---|
| **`Monitor` 工具** | spawn 长跑 shell 命令 + **token-bucket 节流**（burst=5, sustain=1/sec）把 stdout lines 作为**事件**返回给 agent |
| **`MonitorRegistry`** | 4 状态生命周期（running/completed/failed/cancelled）+ idle timeout 自动停 + max events 自动停 + 独立 `AbortController`（Ctrl+C 不杀 monitor）|
| **shell 层 sleep 拦截** | 前台 `sleep N`(N≥2) 被阻塞 + 提示模型用 Monitor 或 `is_background` |
| **事件传输** | 复用 `<task-notification><kind>monitor</kind>` XML 信封 |
| **CLI wiring** | 同时覆盖 interactive (`useGeminiStream.ts`) + headless (`nonInteractiveCli.ts`) 路径 |

**与 Background subagent (Phase A) 的同构性**：

| 维度 | Phase A subagent | Phase C monitor |
|---|---|---|
| 独立 AbortController | ✓ | ✓ |
| stdout/stderr 分离 buffer | ✓ | ✓ |
| 4 状态生命周期 | ✓ | ✓ |
| `<task-notification>` 信封 | ✓（`<kind>subagent</kind>`）| ✓（`<kind>monitor</kind>`）|
| Idle/timeout 自动停 | partial | ✓ |

**未做项追踪**（PR#3684 自述清单的当前状态）：

| 未做项 | 状态 | 备注 |
|---|---|---|
| Footer pill / dialog 集成 | ✅ **PR#3791 已合并 2026-05-03 02:05 UTC** | **+791/-49**（体量从 OPEN 时 +357/-40 翻倍）· 8 文件 / 2 commits · core `MonitorRegistry.setStatusChangeCallback` 镜像 `BackgroundShellRegistry` / `BackgroundTaskRegistry` 的 sync-fire-on-register 模式 |
| `task_stop` 集成 | ✅ **PR#3791 顺带覆盖** | `x` 键路由到 `monitorRegistry.cancel()`，同步 settle 与 `task_stop` 的 monitor 路径一致 |
| `send_message` 集成 | ❌ 仍缺 | 当前未在 PR#3791 范围内（语义解释见下文） |

**`send_message` 工具的当前语义**（源码 `packages/core/src/tools/send-message.ts`）：

> SendMessage tool — lets the model send a text message to a background task. Running tasks receive the message at the next tool-round boundary; paused recovered tasks are resumed first and take the message as their first continuation instruction.（文件头注释）

参数 `task_id` + `message`；行为：

| 目标任务状态 | 行为 |
|---|---|
| `running` | 消息进队列，**下一轮工具边界**时传递给目标 agent |
| `paused`（PR#3739 引入的暂停态） | **先 resume + 把 message 作为第一条 continuation instruction**（`config.resumeBackgroundAgent(taskId, message)`）|

**当前限制**：`send-message.ts:50` 只查 `getBackgroundTaskRegistry()`（agent kind），**不查 `MonitorRegistry`**——所以 `send_message(task_id=<monitor-id>)` 当前会返回 `SEND_MESSAGE_NOT_FOUND` 错误。

**`monitor → send_message 集成`未做的含义**：让 `send_message` 也接受 monitor 的 task_id。但**语义是开放设计问题**——monitor 没有 LLM 消费 message，可能的做法：
1. **stdin 转发**：把 message 写给被监控进程的 stdin（对 `tail -f` 无意义，但对 `npm test --watch` 等交互命令有用）
2. **拒绝并报错**：明确告诉模型"monitor 不接受 send_message"
3. **元事件注入**：把 message 作为 `<task-notification><kind>monitor</kind>` 信封里的一条事件，让调用 agent 后续能看到（充当"备注"机制）

PR#3684 自述清单只说"集成"未做，**没规定具体语义**——这是后续 follow-up PR 需要决策的事情。`task_stop` 的对偶方向语义清晰（"杀掉被监控进程"），所以 PR#3791 顺带就覆盖了；`send_message` 因语义模糊而被推迟。

**PR#3791 合并后已完成**：monitor 与 subagent / background shell 共享同一个 pill+dialog 调度面 —— **Phase C 与 PR#3471/3488 调度面的主要对接已完成**，kind framework 现有 **agent / shell / monitor 三个真实消费者**，把"generic framework"从声称变为证据。

**[PR#3836](https://github.com/QwenLM/qwen-code/pull/3836) ✓ 2026-05-06 02:20 UTC 合并（+1714/-100，体量从 OPEN 时 +598/-19 增长 3x）**：将 **dream** 加为**第 4 种 kind**（auto-memory consolidation 后台任务），同时 **scope 扩展含 cancellation**（标题从 `feat(cli): surface` 改为 `feat(core,cli): surface **and cancel**`）。OPEN 版自称"zero core-package changes"，**MERGED 版实际改了 core**：① `MemoryTaskStatus` 加 `'cancelled'` 状态；② 新增 `MemoryManager.cancelTask` 方法；③ `task_stop` 工具加第 4 dispatch route（模型也能 cancel dream task）；④ cancellation aborts dream fork-agent + 现有 `runDream` finally 块释放 consolidation lock。**意义**：framework 现有 **agent / shell / monitor / dream 四个真实消费者**——把"generic framework"从声称变为强证据。

**Lint fix 工程实践**：commit `7999b85` 给 5 个新 switch 加 `default: { const _exhaustive: never = entry; throw ... }`，同时保运行时 guard 和编译期 exhaustiveness 检查——4th kind 出现时 TypeScript 立即指出 5 个 site 需新加 arm。

---

### 已落地 6：Phase D part (a) 长跑 foreground bash 后台化提示（PR#3809）✓ 2026-05-04 收官

[PR#3809](https://github.com/QwenLM/qwen-code/pull/3809) ✓ 2026-05-04 15:24 UTC（**+649/-1** · 体量从 OPEN 时 +130/0 增长 5 倍 · 5 commits · 91 测试）—— Background tasks roadmap (#3634) Phase D part (a)。当 foreground `shell` tool call 完成（成功或错误）时，LLM-facing tool result 加 advisory 行，建议下次类似长命令用 `is_background: true`。

**关键设计精化**（OPEN → MERGED）：

| 维度 | OPEN（+130/0）| MERGED（+649/-1）|
|---|---|---|
| 触发阈值 | 固定 60 秒 | **effective timeout 的一半 per-invocation 含 1000ms floor** |
| default 120s 命令跑 90s | ✓ 60s 出 advisory | ✓ 60s 出 advisory（不变）|
| `timeout: 600_000` 跑 400s | 60s 出（**过早**——300s 才合理）| **300s 出 advisory**（per-invocation 适配）|
| `timeout: 1` 跑 0.5s | 0.05s 出"ran for 0s"噪声 | **1000ms floor 不出**（避免噪声）|
| Advisory 内容 | 裸"use is_background next time" | **加 stateful 警告**："**别重跑刚完成的命令**"——matters for stateful operations（deploys / migrations / `git push`）|

**与 PR#3684 sleep interception 的双层防御**：

| 时机 | 机制 | PR | 触发 |
|---|---|---|---|
| **validate 时** | shell 层 `sleep N`(N≥2) 拦截 | PR#3684 | 拦截**显式 sleep** |
| **result 时** | LLM advisory 提示后台化 | PR#3809 | nudge **legitimate-but-long** 命令 |

意义：今天 foreground bash 跑几分钟（build watcher / soak test / 慢 `npm install` / 轮询循环）会**无限期阻塞 agent**——用户已经付了等待成本，agent 下一个 turn 本可以在 `is_background: true` 下并行跑。双层防御覆盖了"显式 sleep"和"业务上合理但实际很长"两种情况。

---

### 已落地 7：Kind framework 第 4 消费者：dream 任务（PR#3836）✓ 2026-05-06

[PR#3836](https://github.com/QwenLM/qwen-code/pull/3836) ✓ 2026-05-06（**+1714/-100** · 体量从 OPEN 时 +598/-19 增长 3x）—— auto-memory consolidation 后台任务接入 BackgroundTasksDialog。framework 现有 **agent / shell / monitor / dream** 四消费者——"generic framework" 声称变为强证据。

**之前**：managed auto-memory dream 任务静默后台运行（每 UserQuery 通过 `MemoryManager.scheduleDream` 调度），用户只能看到完成时的 `memory_saved` toast，无法看到正在 review 什么 / 失败原因。

**新设计**：

| 维度 | 实现 |
|---|---|
| Footer pill 计数 | `1 shell, 1 dream` 同款分类显示 |
| Dialog 列表 | `[dream] memory consolidation reviewing N sessions` |
| Detail body 字段 | sessions reviewing / progress text / topics touched / failures |
| API 复用 | `MemoryManager.subscribe()` / `listTasksByType()`——**zero core-package changes** |
| Terminal cap | `MAX_RETAINED_TERMINAL_DREAMS = 3`（镜像 `MonitorRegistry`）|
| 过滤 | `pending` / `skipped` 不显示（每 UserQuery 创建 task，多数被 gated） |
| 排除 | `extract` tasks 不进 framework（每 UserQuery fire 会 flood pill，已有 `memory_saved` toast）|

**MERGED 版超出 OPEN scope** 包含 cancellation：`MemoryTaskStatus 'cancelled'` + `MemoryManager.cancelTask` + `task_stop` 第 4 dispatch route + dialog `x` 键路由。

---

### 已落地 8：foreground subagents 也接入 pill+dialog（PR#3768）✓ 2026-05-06

[PR#3768](https://github.com/QwenLM/qwen-code/pull/3768) ✓ 2026-05-06（**+1008/-108**）—— 同步 Agent 调用运行期间 inline `AgentExecutionDisplay` 抑制，转通过 footer pill + `BackgroundTasksDialog` 呈现；父 turn commit 后完整 frame 出现在 scrollback 不变。

**核心动机**：原 live frame 每 tool call/审批都 mutate，verbose subagent / 长 tool list 超 terminal 高度时 `pendingHistoryItems` repaint 产生**可见闪烁**。改走 pill 完全消除该闪烁类。

**关键设计**：

| 设计点 | 实现 |
|---|---|
| 区分前后台 | `isBackgrounded: boolean`（v0.16.0 正式名；旧 `flavor: 'foreground' \| 'background'` 已重命名，保留一个版本作 type alias；类型名 `BackgroundTaskEntry` → `AgentTask`）|
| 前台 bypass | `emitNotification` / `hasUnfinalizedTasks` / cancel grace timer 全跳过 |
| Abort 传播 | `agent.ts` 同步路径用**复合 AbortController**——parent abort 向下传播，child cancel 不向上 |
| 资源清理 | finally 兜底 unregister（成功 / 失败 / cancel / 异常都覆盖）|
| 误按防御 | dialog 内 foreground entry **两步 cancel 确认**（防误按 `x` 终结当前 turn）|
| 审批 UX | 持 focus lock 的 approval prompt 仍 inline 渲染小 banner，标 originating agent 名 |
| pending plumbing | `isPending` 信号让 dialog 区分"等审批" vs "执行中" |

**意义**：完成"前/后台 subagent 同 UI"统一——之前 foreground 走 inline 模式（闪烁），background 走 pill+dialog（稳定）。现在 inline 仅保留给"审批 prompt 需要焦点锁"的场景，**主流程统一走 pill+dialog**。

---

### 已落地 9：Subagent 稳定性与隔离（PR#3735 + PR#3873 + PR#3887 + PR#3892 + PR#3707）✓ 2026-05-06 → 05-08

**5 个连续 PR** 闭合 subagent 的根本性问题：上下文溢出 + Config 隔离（3 个 wrapper sites 全覆盖）+ 4 fork path 全覆盖 + per-agent ContentGenerator view。

#### PR#3735 ✓ 2026-05-06：subagent 上下文 auto-compact

[PR#3735](https://github.com/QwenLM/qwen-code/pull/3735) ✓ 2026-05-06（**+1518/-1091**）

**之前的 bug**：长 multi-turn subagent run（如 small-context model 上的 Explore subagent）会增长超模型上限，触发 400 `maximum context length exceeded`。subagent 完全没接 compaction。

**新设计**：subagent chat 现也走与主 agent **相同的阈值自动 compaction**。compaction 移到 chat 层，主 agent + subagent 共用一个 trigger；移除主 session loop 的 eager pre-call 避免重复；手动 `/compress` reset 路径不变。

**实测对比**：

| 测试 | 修复前 | 修复后 |
|---|---:|---:|
| Subagent 压缩调用次数 | 0 | 665 |
| Subagent 跑到 400 前的轮数 | 5（~32K tokens）| 不再 400，跑到 session 自然结束 |
| 主 agent 压缩调用次数 | n/a | 772（与 send 交替，符合预期）|

#### PR#3873 ✓ 2026-05-07：subagent Config 真正隔离（PR#3774 follow-up）

[PR#3873](https://github.com/QwenLM/qwen-code/pull/3873) ✓ 2026-05-07（**+862/-41**）

**之前的 bug**：`Object.create(parent)` 创建的 subagent Config 没**重建 tool registry**——`Config.createToolRegistry()` 在 parent `initialize()` 时只跑一次，lazy factory close over `this`，导致 `EditTool` / `WriteFileTool` / `ReadFileTool` 实例的 `this.config` 仍绑 parent。结果 subagent 工具 read 走 parent 的 `FileReadCache` + parent approval mode。

PR#3774 加了 per-Config lazy-init `FileReadCache`（让 wrapper Config 直接读时获得自己的 cache），但 bound tools 走的是 parent registry——这个 gap 在 PR#3774 review 中被 #4234090906 标出但延期到本 PR。

**修复**：subagent Config override 触发 tool registry 重建，让 bound tools 重新绑到 subagent 的 `this.config`，正确解析到 subagent 的 cache + approval mode。

PR#3873 review 标出**三个 adjacent Config-wrapper sites**，PR#3873 + PR#3887 修了前两个，**第三个由 PR#3892 收尾**（见下）。

#### PR#3887 ✓ 2026-05-07：foreground-fork path 漏掉的 ToolRegistry stop（PR#3873 review follow-up）

[PR#3887](https://github.com/QwenLM/qwen-code/pull/3887) ✓ 2026-05-07（**+69/-3**）

**遗漏的路径**：PR#3873 加了 4 个 spawn path 的 per-subagent ToolRegistry stop，但 `agent.ts:execute` 的 **foreground-fork** 分支 `void runInForkContext(runFramedFork)` **没 try/finally 包**——其他 3 path（foreground non-fork / background fork / background non-fork）都已有 finally block stop registry，唯独这条漏了。

**后果**：fork 的 model 后续实例化的任何 `AgentTool` / `SkillTool` 会**泄漏 change-listener** 给共享的 `SubagentManager` / `SkillManager`，session 余生不释放。

**修复**：5 行加 try/finally：

```ts
const runFramedFork = () =>
  runWithAgentContext({ agentId: hookOpts.agentId }, async () => {
    try {
      await this.runSubagentWithHooks(subagent, contextState, hookOpts);
    } finally {
      void agentConfig.getToolRegistry().stop().catch(() => {});
    }
  });
```

`stop()` 已被其他 3 path 验证为 fire-and-forget 安全；`DiscoveredTool` / `DiscoveredMCPTool` 不实现 `dispose` 跳过；只有刚刚释放 listener 的工具会被 dispose。

#### PR#3892 ✓ 2026-05-08：runForkedAgent YOLO wrapper 第三 Config-wrapper site 闭合

[PR#3892](https://github.com/QwenLM/qwen-code/pull/3892) ✓ 2026-05-08 05:42（**+394/-48**）—— PR#3873 review 标出的第三个 adjacent Config-wrapper site。

**bug**：`runForkedAgent` 的 AgentHeadless path 用 `Object.create(parent) + getApprovalMode = YOLO` 局部 helper，**没有重建 tool registry**——parent 已绑的 `EditTool`/`WriteFileTool`/`ReadFileTool` 实例继续把 `this.config` 解析到 parent。

三个具体后果：

| 后果 | 表现 |
|---|---|
| **YOLO override 在 bound-tool path 静默忽略** | bound tools 调 `this.config.getApprovalMode()` 走 wrapper prototype 到 parent，返回 parent mode 而非 YOLO |
| **Per-fork `FileReadCache` 被 bypass** | reads / mutations 被记到 parent cache |
| **Memory-extraction 栈级最坏** | extract 调度器创建 fork 调 fork —— 每层都缺自己的 cache，cache hit 命中 wrong session |

**修复**：runForkedAgent 的 YOLO wrapper 也走 PR#3873 同样的 tool registry 重建路径。**PR#3873 review 标出的 3 个 wrapper sites 全部闭合**：subagent Config（PR#3873）+ foreground-fork path（PR#3887）+ runForkedAgent YOLO wrapper（PR#3892）。

#### PR#3707 ✓ 2026-05-08：per-agent ContentGenerator view via AsyncLocalStorage

[PR#3707](https://github.com/QwenLM/qwen-code/pull/3707) ✓ 2026-05-08 01:56（**+983/-471**）—— subagent 使用不同 model 时的 ContentGenerator 隔离。

**bug**：subagent 在 image-capable model 上跑（如 `qwen3.6-plus`），parent 在 text-only model（如 `glm-5.1`）—— `read_file` 工具的 modality 检查（决定是否 inline images / PDFs）解析到 **parent 的 config**，subagent 看到 `[Unsupported image file: ...]` 而不是实际图片。

**修复**：`Config.getContentGenerator{,Config}()` 现在**先查 AsyncLocalStorage frame**，再 fallback 到 instance field。每个 subagent execution frame 都有自己的 ContentGenerator view（含 modality table），跨 sync tool path + user-approval continuation 都一致。

**意义**：补齐 subagent 隔离最后一公里——之前 PR#3873 / PR#3887 / PR#3892 修的是 `getApprovalMode` / `FileReadCache` / `tool registry`，这次修的是 `getContentGenerator{,Config}`。**5 个 PR 套至此 subagent 完整 Config 隔离闭合**：approval mode / FileReadCache / tool registry / ContentGenerator / modality table 全部 per-subagent。

---

### 已落地 10：LiveAgentPanel port Claude CoordinatorTaskPanel 模式（PR#3909）✓ 2026-05-07

**这是设计收敛事件**——Qwen 之前选择"差异化"（pill + dialog 折叠），现在主动**对齐 Claude 的 always-on panel 模式**。

[PR#3909](https://github.com/QwenLM/qwen-code/pull/3909) ✓ 2026-05-07 13:38（**+1439/-1126**）`feat(cli): replace inline AgentExecutionDisplay with always-on LiveAgentPanel`

#### 为什么收敛

PR#3768（抑制 inline `AgentExecutionDisplay` 闪烁）+ inline 模式三大问题：

| 问题 | 现象 |
|---|---|
| **Live phase 不可见** | PR#3768 抑制 inline 后，live phase 完全没东西在屏幕上跟踪 active work——用户必须按 Down 打开 `BackgroundTasksDialog` 才能看到 |
| **Committed phase 太重** | agent 完成后 full frame 进 scrollback：task prompt + 完整 tool list + execution summary + tool-usage stats，**~15 行/agent** |
| **Cost 不可见** | 没有 elapsed time + token count 显示在 running agent 旁——而这正是用户想 at-a-glance 看的两个数 |

#### Claude pattern 移植

PR#3909 直接 port `CoordinatorTaskPanel`：

| 设计点 | 实现 |
|---|---|
| **位置** | borderless，always-on，**锚定在 input footer 下方**（与 Claude 同款）|
| **格式** | 一行一个 agent |
| **右列 pin** | elapsed + tokens 用 `flex-shrink:0` pin 在右，永不被截断 |
| **Visual conventions（逐字 port）** | `○` bullet（active）/ `✔`（completed）/ 标点 `▶` 分隔 / `name: desc (activity)` 格式 |
| **理由（原文）** | "so the two products feel consistent for users coming from Claude Code" |
| **Detail / cancel / resume** | 仍走现有 `BackgroundTasksDialog`（不变）|

#### Live / Committed phase 演进

```
Before (PR#3768 后 / PR#3909 前):
  Live: 屏幕没东西 → 必须按 Down 打开 dialog
  Committed: ~15 行 verbose frame 进 scrollback

After (PR#3909):
  Live: Active agents (1/1)
        ○ scan the repository for TODO… (Glob **/*.ts) ▶ 13s · 2.4k tokens
  Committed: nothing inline → 完成 summary 在 panel 上保留 8s
             → 长期归档在 BackgroundTasksDialog
```

#### 终端宽度自适应

| 宽度 | 行为 |
|---|---|
| **200 cols** | left column 内在宽度，slack 落 row tail，无截断 |
| **100 cols** | left column 末尾 `…` 截断；**right column（time + tokens）保留** |
| **60 cols** | left column 截更多；right column 仍 pin |
| **9 agents / maxRows=5** | overflow 显示 `^ 4 more above (↓ to view all)` 引导用户进 dialog |

#### 设计收敛后的双层 UI

```
LiveAgentPanel（PR#3909，新增）       BackgroundTasksDialog（PR#3488 起）
─────────────────────────────       ─────────────────────────────
Always-on glance                    On-demand detail
1 line per agent                    full per-agent state
elapsed + tokens at-a-glance        tools / progress / per-agent transcript
nothing inline anymore              full Running/Completed/Failed/Cancelled 4 状态
锚定输入框 footer 下方                按 Down/Ctrl+T 打开
```

**Qwen 现在比 Claude 多一层**：Claude 只有 always-on panel；Qwen 是 **LiveAgentPanel（glance）+ BackgroundTasksDialog（detail）双层**——更精细。

#### 历史记录

这是文档系列追踪期间**首次出现 Qwen 主动对齐 Claude 设计**的事件。之前 PR#3488 / PR#3720 / PR#3739 等都是"差异化或反超 Claude"，PR#3909 反向——理由是 Claude pattern（always-on glance panel）在 PR#3768 抑制 inline 后被实测为更优解，差异化实验（折叠 pill）反而留下"live phase invisible"的 UX 缺口。

> **设计哲学反思**：差异化不是目的，UX 最优才是。Qwen 团队 2026-04 走 pill 路线 → 5 月发现 PR#3768 后 live phase 不可见 → 5 月 7 日决定 port Claude pattern 补缺口。这是**经验主义优于路线一致性**的工程决策范例。

#### PR#3919 ✓ 2026-05-08：LiveAgentPanel ownership filter follow-up

[PR#3919](https://github.com/QwenLM/qwen-code/pull/3919) ✓ 2026-05-08 05:42（**+676/-50**）—— PR#3909 review 标出的两个 follow-up（`AUQHn` / `AUQGc` Copilot threads）。

**修复 #1：Live-phase panel-ownership filter**

`SubagentExecutionRenderer` 在 PR#3909 后开始在 subagent 进入 terminal status 时渲染 `SubagentScrollbackSummary`。但 `isPending` 也在同 PR 从 `ToolMessageProps` 移除——**panel-owned subagent rows（running / background）通过 `ToolGroupMessage` 漏到 live area**，重复 LiveAgentPanel 已经在 composer 下面画的 row。

**修复**：per-tool ownership filter（不是 render-time gate on summary）。`ToolGroupMessage.tsx` 在任何 compact decision 之前 derive `inlineToolCalls`：live phase（`isPending=true`）下 drops panel-owned subagent rows，留给 LiveAgentPanel 独家渲染。

**修复 #2：post-delete `statusChange` emit**

subagent 完成后从 panel 删除时，原 path 漏发 `statusChange` event——subscriber（如外部 hook）miss 这个状态变化。修复：post-delete 也 emit。

**意义**：闭合 PR#3909 的两个 review 评论。LiveAgentPanel 设计现在**完全没有重复渲染 / 漏 event 问题**。

---

### 已落地 11：`/branch` (alias `/fork`) session 分支（PR#3539）✓ 2026-05-08

[PR#3539](https://github.com/QwenLM/qwen-code/pull/3539) ✓ 2026-05-08（**+1538/-18**）`feat(session): add /branch to fork the current conversation`——OPEN 14 天后合入，作者 qqqys，2 轮 wenshao CHANGES_REQUESTED 后通过。

**对标 Claude `--fork-session` CLI flag**，但选 slash 命令实现，运行中即时 fork 比 Claude 启动 flag 更顺手。

**核心设计**：

| 维度 | 实现 |
|---|---|
| 入口 | `/branch [name]` 主名 + **`/fork` alias** |
| JSONL 复制 | 完整 in-memory copy + 写入新 sessionId 的 JSONL |
| 每记录 stamp | `forkedFrom: { sessionId, messageUuid }`（per-record 审计，记录孤立查阅时自描述）|
| `parentUuid` 链 | 重建 in write order（fork 是 parent 的干净线性后裔）|
| **原子创建** | `fs.openSync(path, 'wx', 0o600)`——一次 syscall 同时断言不存在并创建（无 TOCTOU 窗口）|
| 守卫（拒绝条件）| invalid sessionId / 跨 project source（`getProjectHash(records[0].cwd)` 校验）/ pre-existing target / `isIdleRef`（mid-stream fork 会撕断 parent chain）/ empty source / brand-new empty session |
| 标题 | `<name> (Branch)` collision bump → `(Branch 2)` `(Branch 3)` ... cap 99 → timestamp fallback |
| 标题派生 | 从 first real user `ChatRecord` 派生（**避开 environment bootstrap messages 污染**）；`subtype` 记录（cron / notification / slash-command echo）跳过 |
| Swap 顺序 | **"core first, UI last"** —— `useBranchCommand` 顺序：finalize recorder → `forkSession` (disk) → `loadSession` → `config.startNewSession` → `getGeminiClient().initialize()` → UI sessionId swap → `historyManager.clearItems` + `loadHistory` → title + hook + announce。任何还能 throw 的逻辑跑完再切 UI——throw 时用户**安全留在 parent**而不是被 strand 在 cleared history + half-live client |
| Hook 区分 | `SessionStartSource.Branch` 独立 enum 变体（**不复用 `Resume`**，因 fork 语义是 derivative transcript under new id 不是 resume）|
| Announcement | 2-line info items（match Claude 格式）："Branched conversation \"name\". You are now in the branch." + 提示 `/resume <oldSessionId>` 回原 session |
| 命令防递归 | `/branch` 加入 `SLASH_COMMANDS_SKIP_RECORDING`——命令本身不录入 fork 尾部 |

**关键文件**（13 文件 ~1500 行 net）：
- `packages/cli/src/ui/commands/branchCommand.ts`（59 行）
- `packages/cli/src/ui/hooks/useBranchCommand.ts`（293 行）
- `packages/core/src/services/sessionService.ts`（+147 行 `forkSession` API）
- `packages/core/src/services/chatRecordingService.ts`（+18 行 `forkedFrom` 字段）
- `packages/core/src/hooks/types.ts`（+1 行 `SessionStartSource.Branch`）
- 完整测试：`branchCommand.test.ts` + `useBranchCommand.test.ts`（466 行）+ `sessionService.test.ts`（382 行）+ `slashCommandProcessor.test.ts`（49 行）

**与 Claude `--fork-session` 的对比**：

| 维度 | Claude `--fork-session` | Qwen `/branch` (`/fork` alias) |
|---|---|---|
| 入口 | CLI flag 启动时 | slash 命令运行中 |
| 触发场景 | 启动时配合 `--resume` / `--continue` | session 内即时（更顺手）|
| 持久化细节（公开）| 未公开 | JSONL 完整复制 + per-record `forkedFrom` stamp |
| 原子性 | 未公开 | `fs.openSync 'wx'`（无 TOCTOU）|
| Rollback 安全 | 未公开 | "core first, UI last" 显式设计 |
| Hook 区分 | 未公开 | `SessionStartSource.Branch` 独立 enum |
| 标题 collision | 未公开 | `(Branch 2)` ... cap 99 → timestamp fallback |

设计对标 Claude pattern + 工程实现质量更高（atomic create / rollback-safe swap / hook 独立 enum 都是 Qwen 加的安全 / 语义边界）。

---

### 已落地 12：foreground → background promote（PR#3894 + PR#3969）✓ 2026-05-08

**Phase D part (b) of #3634 / #3831 of 3-PR stack**——把正在跑的 foreground shell 命令在运行中升为 background task。

| PR | 状态 | 内容 |
|---|---|---|
| [PR#3842](https://github.com/QwenLM/qwen-code/pull/3842) | ✓ 2026-05-07 | **PR-1 of 3**：`signal.reason` foundation —— `ShellAbortReason = { kind: 'cancel' } \| { kind: 'background'; shellId? }` |
| [PR#3894](https://github.com/QwenLM/qwen-code/pull/3894) | ✓ 2026-05-08 11:56 (+935/-15) | **PR-2 of 3**：`shell.ts` 集成——检测 `result.promoted: true`，snapshot 输出到 `bg_xxx.output` 文件，注册 `BackgroundShellEntry`，return model-facing ToolResult 指向 `/tasks` + dialog + `task_stop` |
| [PR#3969](https://github.com/QwenLM/qwen-code/pull/3969) | ✅ 已合并入 v0.16.0 | **PR-3 of 3**：Ctrl+B 用户键绑——按 Ctrl+B 让正在跑的 foreground shell 命令转 background，agent 当前 turn 立即 unblock，子进程继续跑 |

**完整流程**（PR#3894 描述的 caller flow）：

```
[User presses Ctrl+B during foreground shell command]
  ↓
TUI Ctrl+B handler → AbortController.abort({ kind: 'background', shellId })
  ↓
shell.ts execute() detects abort signal.reason
  ↓
检测 result.promoted: true  (而非 result.aborted: true)
  ↓
snapshot stdout/stderr 到 bg_xxx.output 文件
  ↓
register BackgroundShellEntry to BackgroundShellRegistry
  ↓
return ToolResult to model：
  "Command moved to background. Inspect via /tasks or stop via task_stop."
  ↓
agent 当前 turn 立即 unblock（return 不等 child 退出）
  ↓
child process 继续跑（独立 AbortController）
  ↓
用户后续可通过 BackgroundTasksDialog 看输出 / cancel
```

**设计巧思**：`result.aborted: false` when `result.promoted: true`——让现有 `if (result.aborted)` consumer 分支自动 fall through，不需要任何 consumer 记得检查 `promoted` 才检查 `aborted`（review 提到的 "design question 7"）。

**意义**：长跑命令（build / soak test / npm install）可在中途 promote 到后台不阻塞 agent。配合 [§六.5 PR#3684 sleep interception](#已落地-5phase-c-event-monitor-toolpr3684-系列追踪以来最大单-pr) + [§六.6 PR#3809 长跑后台化提示](#已落地-6phase-d-part-a-长跑-foreground-bash-后台化提示pr3809-2026-05-04-收官) 形成**完整三层防御**：
1. validate 时（PR#3684）：拦截显式 sleep
2. 跑到一半时（**PR#3894 + PR#3969**）：用户 Ctrl+B 主动 promote
3. result 时（PR#3809）：完成后 advisory nudge

---

### 已落地 13：subagent approval banner 工具细节（PR#3956）✓ 2026-05-08

[PR#3956](https://github.com/QwenLM/qwen-code/pull/3956) ✓ 2026-05-08 12:20（+179/-53）

**修的 bug**：subagent（如 `general-purpose`）请求工具权限时，inline approval banner 只显示 agent name + 通用 `Do you want to proceed?` + 三个选项——**实际命令 / file diff / MCP tool 全被隐藏**，parent 不知道在 approve 什么。

**根因**：`ToolConfirmationMessage` 的 `compactMode` early-return 在 per-type body 和 question 构建之前就执行了。

**修复**：
- 把 compactMode 处理移到统一 return path——同一 body 在 compact 模式也渲染
- swap type-specific exec/mcp question 为通用 prompt（body 已显示 command 或 labeled server+tool，重复就是冗余信号）
- 用现有 `MaxSizedBox` overflow 把 body cap 在 5 行内

**意义**：审批 subagent 工具时用户能看到具体动作（"`rm -rf /tmp/foo`" / "Edit src/x.ts: +5 -2 lines" / "MCP `github::create_pr` 参数 ..."）而非黑盒——**比之前更安全的审批 UX**。

---

### 已落地 14：inline dense panel + LiveAgentPanel keyboard nav（PR#4477）🔧 2026-05-24 OPEN

[PR#4477](https://github.com/QwenLM/qwen-code/pull/4477) 🔧 2026-05-24 08:37（**+809/-95 12 files, 9 commits, OPEN REVIEW_REQUIRED**） `feat(cli): dense inline panel + keyboard navigation for parallel agent fan-out`

**两个独立但配套的能力**：

#### 1. `InlineParallelAgentsDisplay`（dense inline panel for parallel fan-out）

**修的痛点**：`/review <pr-url>` 类命令 fan out 出 9 个并行 agent，每个跑数分钟；旧渲染两端都不好：

| 模式 | 旧效果 | 问题 |
|---|---|---|
| Compact | `Agent × 9 / Code Quality`（折叠到一行） | 9 agent 跑几分钟，0 信息密度 |
| 非 Compact | 每 agent 一个完整 `ToolMessage`（多行 chrome）| 信息密度低，刷屏 |

**新效果**：对**纯并行 agent 组**（≥2 个 agent call + 0 non-agent tool + 无 pending approval）渲染密集面板：

```
╭─ Parallel agents · 9 · 3/9 done ──────────────────────────────╮
│ ✔ Agent 1: Correctness                      12s · 8.1k tok    │
│ ✔ Agent 2: Security                          8s · 3.4k tok    │
│ ○ Agent 3: Code Quality ReadFile index.ts   3m 38s · 9.0k tok │
│ ○ Agent 4: Performance  Shell grep ...      3m 38s · 1.2k tok │
│ ✔ Agent 5: Test Coverage                     5s · 605 tok     │
│ ...                                                            │
╰────────────────────────────────────────────────────────────────╯
```

每行：status (`○` running / `✔` done) · name · activity · elapsed · tokens；列宽 `NAME_COL_WIDTH = 26`（fit `/review` 最长 agent label `Code Quality` 在 100-col 终端）；活动列 (`ReadFile index.ts` / `Shell grep ...`) 从 `BackgroundTaskRegistry.recentActivities` 1s tick 实时拉；完成后 unregister 时 fall back to `AgentResultDisplay.executionSummary` 的 elapsed + tokens 防 blank-out。

**两阶段渲染**：
- **Live phase**（`isPending=true`）：dense panel 渲所有 agent；`LiveAgentPanel`（输入框下方）仍同时渲 running agent（短暂 overlap，agent 完成后 expire 自动消除）
- **Committed phase**：dense panel commit 到 `<Static>` 永久 scrollback 记录

**Routing 条件**（`ToolGroupMessage.isPureParallelAgentGroup` 新 predicate）：
- 组 ≥2 calls 且 **全是 agent**（mixed groups 保留 legacy renderer）
- 无 pending confirmation（approval focus 不被劫持）

**Iteration history**（9 commits）：
- 初版（05-24 08:37）：`InlineAgentClaimContext` 让 inline panel 声明 agentIds，`LiveAgentPanel` filter 掉，防双显示（refcount avoid React commit/cleanup interleave drop）
- review fold（05-24 09:25）：split into read+write context（claimers 不为别处 claim 重渲染）+ 抽 `isPureParallelAgentGroup` predicate + `NAME_COL_WIDTH = 26` 文档化
- committed-only refactor（05-24 15:56）：live phase 让位 LiveAgentPanel；删 `InlineAgentClaimContext`（一度反向）
- 改两阶段（05-24 17:08）：dense panel 同时 live + committed；`LiveAgentPanel.DEFAULT_MAX_ROWS` **5 → 12** 让 9 agent 全可见

#### 2. LiveAgentPanel keyboard navigation

**修的痛点**：输入框到运行中 agent 无键盘路径——用户得知道 footer pill 才能进 `BackgroundTasksDialog`。

**新交互**：

```
> _                                          ← 输入框
▸ main  Active agents (6)                    ← ↓ 选 "main"
  ○ Agent 3: Code Quality (Read) ▶ 3m       ← ↓ 又一次选 agent
  ○ Agent 4: Performance (Shell) ▶ 3m
  ○ Agent 6: Attacker (Read)     ▶ 3m
  ...
  ↑↓ navigate · Enter detail · Esc back
```

- `↓` from 输入框 → focus LiveAgentPanel，select "main"
- `↑↓` → 在 "main" + agent rows 间导航，selection `▸` 指示
- `Enter` on agent → 直开 `BackgroundTasksDialog` **detail mode**（full agent view，不经过 list）
- `←` from detail → 回 LiveAgentPanel selection（**不是** dialog list；新 `detail-from-panel` dialog 模式）
- `Esc` / `↑ at top` → 回输入框
- 可打印字符 → auto-unfocus + 字符 type into 输入框

**实现要点**：
- `BackgroundTaskViewContext` 加 `livePanelFocused` / `livePanelSelectedIndex` / `enterBgDetailFromPanel`
- Header 从 `Active agents (N/N)` 简化为 `Active agents (N)`（PR-G 后再简化为单 `main` 标题）
- `bgAgentCount`（agent-only）替代 `bgEntries.length`（含 shell / monitor / dream）作键盘 nav bounds——避免选到非 agent entry
- LiveAgentPanel 返回 null 时 auto-clear `livePanelFocused` 防 stuck focus
- `InlineAgentClaimProvider` sit inside `BackgroundTaskViewProvider`（两个 surface 都可见，不跨 provider boundary）

#### 与已落地 10（PR#3909）的关系

| 层级 | PR#3909（2026-05-07）| PR#4477（本 PR, 2026-05-24）|
|---|---|---|
| **Always-on glance** | LiveAgentPanel 输入框下方常驻 1 行/agent | ✅ 保留 + maxRows 5→12 + 键盘导航 |
| **Live inline** | inline `AgentExecutionDisplay` 已移除 | **新加 dense panel for 并行 fan-out**（信息密度高） |
| **Detail view** | `BackgroundTasksDialog`（按需，光标 enter）| 新增 `detail-from-panel` 模式：从 LiveAgentPanel 直进 detail，`←` 回 panel |

**意义**：PR#3909 让 Qwen 与 Claude Coordinator panel 对齐（**glance 层**对齐），本 PR 让 Qwen 在 inline 层（dense panel）+ 交互层（keyboard nav）**领先 Claude** —— Claude `CoordinatorAgentStatus.tsx` 至今仍只是 always-on panel 显示信息，没有键盘 detail-from-panel 路径，并行 agent fan-out 也没有专门 dense rendering（每 agent 通过 inline `AgentProgressLine` + Coordinator panel 折叠双显示）。

**验证**：手动 `tmux` `/review <pr-url> --comment` 跑 9-agent fan-out（包括对 PR#4472 自己 review）：9 agent 全渲 with live status / activity / elapsed / tokens，`○ → ✔` glyph transition，LiveAgentPanel 正确去重；11 new tests + 57 prior tests on touched files pass + `tsc --noEmit` clean。

**review fold-in** (10 reviews 至 2026-05-26)：拆 read/write context 防误重渲染 / `bgAgentCount` 替代 `bgEntries.length`（Critical：之前算 shell+monitor+dream 进 bound）/ auto-clear focus on empty agent set / `useCallback`/`useEffect` ESLint deps 修齐 / `AgentTabBar.test` `setLivePanelFocused` 入参更新。

---

### 还有什么可以做？（剩余 gap）

主体已落地（**roadmap #3634 四阶段全部 ✓** + **PR#3969 / PR#3970 / PR#3933 均已合并入 v0.16.0**），仍有 2 个值得追踪的方向：

1. **`/agents --history` 归档对比视图**：当前 `BackgroundTasksDialog` 偏运行时管理；历史归档 + 对比 diff 仍未实现
2. **monitor → `send_message` 集成**：PR#3684 自述"未做"清单第 2 项 —— `task_stop` 已通过 PR#3791 顺带覆盖，但 `send_message` 让 monitor 接收外部消息（如 LLM 主动 hint）暂未对接（详见 [§六.5](#已落地-5phase-c-event-monitor-toolpr3684-系列追踪以来最大单-pr)）

---

## 七、Claude Code 可借鉴 Qwen 的 3 个机会（反向）

### 1. Ctrl+E / Ctrl+F 三档展示切换

**Qwen 源码**：`AgentExecutionDisplay.tsx:124-140`

**价值**：Claude Task 工具当前固定格式，加入按键切档能极大提升信息密度调节能力。

### 2. 焦点锁并发审批

**Qwen 源码**：`ToolGroupMessage.tsx:99-123, 256-287`

**价值**：Claude 多 subagent 触发审批时目前无明确排队机制，焦点锁可大幅改善 UX。

### 3. 执行摘要 4 行信息长期保留

**Qwen 源码**：`AgentExecutionDisplay.tsx:464-526`

**价值**：Claude Coordinator 30s 驱逐太激进——用户 30s 后无法回顾刚完成的任务。保留摘要行（不保留全部 tool list）是折中方案。

---

## 八、相关追踪 item

| item | 方向 | 状态（2026-05-22 / v0.16.0 更新）|
|---|---|---|
| [item-56](./qwen-code-improvement-report-p2-stability.md#item-56) | 真正后台并发 + TTL 驱逐 | **✓ 已实现**（PR#3471 + PR#3488 + PR#3642 + PR#3687 + PR#3720 共 5 件套，且超出 Claude 设计）|
| [item-57](./qwen-code-improvement-report-p2-stability.md#item-57) | `/agents` 独立管理视图 | 🟡 部分（`/tasks` 命令 + dialog 已有运行时管理 + PR#3801 hint 路径分流；历史归档/对比 diff 仍缺）|
| [item-58](./qwen-code-improvement-report-p2-stability.md#item-58) | Coordinator 协调器面板 | **✓ 已实现**（PR#3488 pill + combined dialog + detail view，与 Claude footer 常驻面板设计取舍不同）|
| [item-18](./qwen-code-improvement-report-p0-p1-engine.md#item-18) | Agent 恢复与续行 | **✓ 已实现**（PR#3739 +4087/-165，transcript-first fork resume 比 Claude 更稳健）|
| [p0-p1-engine item-14](./qwen-code-improvement-report-p0-p1-engine.md#item-14) | Coordinator/Swarm 多 Agent 编排 | 🟡 持续推进（PR#3433 ⚠️ revert，但 PR#3471/3488 已落地控制面 + UI）|
| **长跑 foreground bash 后台化提示** | foreground 命令 ≥ effective timeout 一半时 LLM nudge | **✓ 已实现**（PR#3809 +649/-1 · Phase D part (a) · 配合 PR#3684 sleep interception 形成双层防御）|
| **🆕 Foreground subagent UI 闪烁解决** | inline AgentExecutionDisplay 抑制，转 pill+dialog 渲染 | **✓ 已实现**（PR#3768 ✓ 2026-05-06 +1008/-108 · 复合 AbortController + 两步 cancel 确认）|
| **🆕 Subagent 上下文溢出防御** | subagent chat 自动压缩与主 agent 同 trigger | **✓ 已实现**（PR#3735 ✓ 2026-05-06 +1518/-1091 · long-running Explore 不再 400）|
| **🆕 Subagent Config 真正隔离** | `Object.create(parent)` 重建 tool registry 让 subagent 工具绑自己 cache + approval | **✓ 已实现**（PR#3873 ✓ 2026-05-07 +862/-41 · PR#3774 follow-up 闭合）|
| **🆕 Session fork（branch off）** | slash 命令 fork 当前 session 创建分支副本 | **✓ 已实现**（[PR#3539](https://github.com/QwenLM/qwen-code/pull/3539) ✓ 2026-05-08 +1538/-18 · `/branch` + `/fork` alias · JSONL 完整复制 + 每记录 stamp `forkedFrom: {sessionId, messageUuid}` + 重建 `parentUuid` 链 + 原子 `fs.openSync 'wx' 0o600` 创建 + collision-safe 标题 `<name> (Branch N)` + "core first, UI last" rollback-safe swap + `SessionStartSource.Branch` 独立 enum + `isIdleRef` 拒 mid-stream fork · 对标 Claude `--fork-session` CLI flag 但 slash 命令更顺手） |

---

## 九、关键文件速查表（2026-05-24 / v0.16.0 + Claude v2.1.150 binary 复核）

| 技术 | Claude Code | Qwen Code |
|---|---|---|
| Coordinator/后台面板 | `components/CoordinatorAgentStatus.tsx:34-76`（**输入框 footer 下方**屏幕底部常驻——源码注释 "Renders below the prompt input footer"）| **🆕 `LiveAgentPanel`（PR#3909，port Claude pattern · 输入框 footer 下方常驻 · 1 行/agent · 右列 pin elapsed+tokens）** + **`BackgroundTasksDialog.tsx`**（按需打开 dialog · detail / cancel / resume）|
| Agent 任务状态 | `tasks/LocalAgentTask/LocalAgentTask.js` | **`packages/cli/src/ui/contexts/BackgroundTaskViewContext.tsx`** + **`hooks/useBackgroundTaskView.ts`** |
| 模型侧控制工具 | `tools/TaskStop/TaskStopTool.ts` + `tools/SendMessage/SendMessageTool.ts` | **`packages/core/src/tools/agent/agent.ts`** 暴露 `task_stop` / `send_message` / per-agent transcript（PR#3471）|
| TTL 驱逐 | `TaskListV2.tsx:21` `RECENT_COMPLETED_TTL_MS = 30_000`（自动驱逐）| **保持可见，用户主动 `x` 取消**（PR#3488 设计差异）|
| 驱逐执行 | `utils/task/framework.js:evictTerminalTask` | dialog 内 `x` 键路由到 `task_stop` 工具 |
| Agent 进度行 | `components/AgentProgressLine.tsx` | dialog 内 list item + per-agent rolling tool activity buffer（PR#3488）|
| `/agents` 菜单 | `components/agents/AgentsMenu.tsx` + 10 文件子目录（agent 定义管理）+ **v2.1.120 起加 `● N running` 计数指示**（2026-04-28）+ **v2.1.132→145 间加 `background-tasks-dialog` / `BackgroundTasksSettings` / `BackgroundAppearance`**（binary 复核，源码未确认）| **`/tasks` 命令**（运行时管理，PR#3642）+ subagent 定义在 `subagents/` 目录 |
| 工具内联 | `tools/AgentTool/AgentTool.tsx` | `components/messages/ToolGroupMessage.tsx` |
| SubAgent 嵌入展示 | 无（Task 工具简洁展示）| ~~`components/subagents/runtime/AgentExecutionDisplay.tsx`~~ ⚠ **PR#3909 已替换为 LiveAgentPanel**（inline AgentExecutionDisplay 在 PR#3768 抑制后由 PR#3909 移除并替换为 always-on panel）|
| 三档切换 | 无 | ~~`AgentExecutionDisplay.tsx:124-140`~~（PR#3909 后过时——LiveAgentPanel 是单一格式 1 行/agent）|
| 焦点锁 | 无 | `ToolGroupMessage.tsx:99-123` + PR#3771 修复 |
| `/tasks` 命令 | 无（Claude 没有这个 CLI 入口）| **`packages/cli/src/ui/commands/tasksCommand.ts`**（PR#3642 · 显示 BackgroundShellEntry 状态）|
| Background agent resume | `tools/AgentTool/resumeAgent.ts:resumeAgentBackground()` | **`BackgroundAgentResumeService`**（PR#3739 +4087/-165）+ transcript-first fork resume + `system/agent_bootstrap` + `system/agent_launch_prompt` |
