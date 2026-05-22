# Claude Code `/agents` 命令 Deep-Dive

> **核心问题**：Claude Code 的 `/agents` slash command 是什么？为什么是 Stage 1.5c daemon-side state CRUD 的最佳参考实现？Qwen Code 可借鉴哪些设计？
>
> 返回 [Qwen Code 改进建议总览](./qwen-code-improvement-report.md)
>
> **文件历史**：本文原名 `claude-code-agents-view-deep-dive.md`，2026-05-16 重命名为 `claude-code-agents-command-deep-dive.md`——避免与 Qwen Code 的 `agent-view/` 多 tab 交互 UI 撞名（两者形态完全不同：本文写的是**定义管理 UI**，Qwen 的写的是**运行时交互式多 tab UI**，详 [Qwen Code `agent-view` 多 tab UI Deep-Dive](./qwen-code-agent-view-deep-dive.md)）。
>
> **本质澄清**：`/agents` **不是** "subagent 实时状态监控"（那是 [SubAgent 展示 Deep-Dive](./subagent-display-deep-dive.md) 范畴），也**不是** Qwen 那种"多 subagent tabbed 对话窗口"（详 [qwen-code-agent-view-deep-dive.md](./qwen-code-agent-view-deep-dive.md)），而是一个完整的 **subagent 定义 CRUD UI**——管理 agent 配置文件、不管运行状态、不切对话上下文。

## 零、TL;DR

Claude Code `/agents` 是一个 **~3042 LOC 的 Subagent 定义管理 UI**，用 Ink TUI 渲染本地 React 组件让用户在 CLI 内：

| 操作 | 实现 |
|---|---|
| **列出** | 7-mode 状态机，按 source filter（6 source: built-in / user / project / local / policy / flag / plugin）|
| **查看详情** | system prompt + tools + model + color + memory + hooks + skills + isolation |
| **创建** | 11-step wizard，支持 **AI 生成** agent（长 system prompt 调 LLM 自动生成 identifier / whenToUse / systemPrompt）|
| **编辑 / 删除** | inline 编辑器 + delete-confirm dialog |

**关键文件格式**：`.claude/agents/<name>.md` markdown + YAML frontmatter（含 17+ 字段）。

**对 Qwen Code 的意义**：这是 **Stage 1.5c daemon-side state CRUD** 的范本——Claude Code 已 ship 完整 7-mode 状态机管理 subagent；Qwen daemon Stage 1.5c 需要把同等功能暴露给远端 client（通过 HTTP route 而不是 local-jsx）。

## 一、`/agents` 不是什么 vs 是什么

### 容易混淆的 3 个相邻概念

| 概念 | 含义 | Claude Code 实现 | 本文范围 |
|---|---|---|---|
| **`/agents` UI** | Subagent 定义 CRUD | `commands/agents/agents.tsx` → `<AgentsMenu>` | ✅ 本文 |
| **SubAgent 运行状态展示** | 后台 subagent 进度 pill / dialog | `LiveAgentPanel` + `CoordinatorTaskPanel` | ❌ 详 [subagent-display-deep-dive.md](./subagent-display-deep-dive.md) |
| **`AgentTool`** | 主 agent spawn subagent 时调用的工具 | `tools/AgentTool/` | ❌ 详 [fork-subagent-deep-dive.md](./fork-subagent-deep-dive.md) |

本文专聚焦 **`/agents` UI**——用户管理 agent **定义文件**的界面，不涉及运行状态。

### 触发方式

| 触发 | 用户操作 |
|---|---|
| Slash command | TUI 输入 `/agents` |
| 内部 | `LocalJSXCommand` 类型，返回 `<AgentsMenu>` React 组件，TUI 内本地渲染 |
| 是否 wire 化 | ❌ **local-jsx，不出 wire**（Mode A 本地 TUI 用户可用；Mode B 远端 client 看不到）|

## 二、源码结构（~3042 LOC，21 文件）

```
commands/
├─ agents/
│  ├─ agents.tsx          11 LOC   slash command 入口 → 返回 <AgentsMenu>
│  └─ index.ts            10 LOC   命令注册

components/agents/
├─ AgentsMenu.tsx        799 LOC   ★ 7-mode 状态机控制器
├─ AgentsList.tsx        439 LOC   列表视图（按 source filter）
├─ AgentDetail.tsx       219 LOC   详情视图（含 markdown 渲染 system prompt）
├─ AgentEditor.tsx       177 LOC   inline 编辑器
├─ AgentNavigationFooter.tsx 25 LOC  导航 footer（键盘提示）
├─ ToolSelector.tsx      561 LOC   ★ 工具勾选器（含 MCP tools 合并展示）
├─ ColorPicker.tsx       111 LOC   agent 颜色选择
├─ ModelSelector.tsx      67 LOC   model 选择
├─ agentFileUtils.ts     272 LOC   markdown 文件读写（YAML frontmatter）
├─ generateAgent.ts      197 LOC   ★ AI 生成 agent
├─ validateAgent.ts      109 LOC   字段验证
├─ types.ts               27 LOC   ModeState 类型定义
└─ utils.ts               18 LOC   utils

components/agents/new-agent-creation/
├─ CreateAgentWizard.tsx  96 LOC   wizard provider
└─ wizard-steps/         1503 LOC  ★ 11 个 wizard step
   ├─ LocationStep.tsx     79 LOC   选放在哪（user/project/local）
   ├─ MethodStep.tsx       79 LOC   Generate 还是 Manual
   ├─ GenerateStep.tsx    142 LOC   AI 生成（仅 Generate 路径）
   ├─ TypeStep.tsx        102 LOC   agent type 命名
   ├─ PromptStep.tsx      127 LOC   system prompt 编辑
   ├─ DescriptionStep.tsx 122 LOC   whenToUse 描述
   ├─ ToolsStep.tsx        60 LOC   工具勾选
   ├─ ModelStep.tsx        51 LOC   model 选择
   ├─ ColorStep.tsx        83 LOC   颜色
   ├─ MemoryStep.tsx      112 LOC   memory scope（条件 GrowthBook gate）
   ├─ ConfirmStep.tsx     377 LOC   ★ 确认 + 写文件
   └─ ConfirmStepWrapper.tsx 73 LOC
```

**总计 ~3042 LOC**。星标项是核心组件。

## 三、7-Mode 状态机（AgentsMenu.tsx）

```typescript
// components/agents/types.ts
export type ModeState =
  | { mode: 'main-menu' }
  | { mode: 'list-agents'; source: SettingSource | 'all' | 'built-in' }
  | ({ mode: 'agent-menu' } & WithAgent & WithPreviousMode)
  | ({ mode: 'view-agent' } & WithAgent & WithPreviousMode)
  | { mode: 'create-agent' }
  | ({ mode: 'edit-agent' } & WithAgent & WithPreviousMode)
  | ({ mode: 'delete-confirm' } & WithAgent & WithPreviousMode)
```

### 状态转移图

```
                main-menu
                    ↓ select source
              list-agents (filtered by source)
                    ↓ select agent | create-new
        ┌───────────┼────────────────────┐
        ↓           ↓                    ↓
   agent-menu  create-agent       (cancel → list-agents)
        ↓           ↓
   ┌────┼────┐   wizard 11-step
   ↓    ↓    ↓
view-  edit- delete-confirm
agent  agent      ↓
                 yes → write file → list-agents
                 no  → previousMode
```

### 5 个核心键盘交互

| 键 | 行为 |
|---|---|
| `Enter` | 选择 |
| `Esc` | 返回 `previousMode` |
| `j/k` 或 `↑/↓` | 移动焦点 |
| `Ctrl+C` (× 2) | 退出 dialog（一次确认，两次强退）|
| `Tab` | 切换 source filter |

## 四、Agent 定义文件格式（关键标准）

`.claude/agents/<name>.md` 是 **markdown + YAML frontmatter**：

```markdown
---
name: code-reviewer
description: "Reviews code for quality and security. Use when user asks for review after writing code.
              <example>User: 'review my recent PR'</example>"
tools: Bash, Edit, Read, Glob, Grep
disallowedTools: WriteFile
model: claude-opus-4-7
effort: high
permissionMode: ask
color: blue
memory: project
mcpServers:
  - filesystem
  - github
hooks:
  pre-prompt: |
    echo "Reviewing branch $(git branch --show-current)"
skills:
  - code-review
  - security-audit
maxTurns: 20
background: false
isolation: worktree   # ant-only: worktree | remote
initialPrompt: "Start by listing recent commits..."
criticalSystemReminder_EXPERIMENTAL: "Always verify with tests."
omitClaudeMd: false   # read-only agents 省 ~5-15 Gtok/周
requiredMcpServers:
  - github
---

You are an elite code reviewer specialized in...
```

### 字段全表（17+ 字段）

| 字段 | 类型 | 必填 | 含义 |
|---|---|:---:|---|
| `name` (= `agentType`) | string | ✅ | agent 标识符（lowercase + hyphen，2-4 词）|
| `description` (= `whenToUse`) | string | ✅ | 何时使用此 agent（含 `<example>` 标签）|
| `tools` | `string[]` | ❌ | 允许的工具（默认 `*` 全部）|
| `disallowedTools` | `string[]` | ❌ | 禁用的工具 |
| `model` | string | ❌ | model 名（`inherit` 表跟随主 agent）|
| `effort` | enum / int | ❌ | thinking effort level |
| `permissionMode` | enum | ❌ | `ask` / `allow` / `deny` / `yolo` |
| `mcpServers` | string[] / record | ❌ | 特定 MCP server（名字引用 or inline 定义）|
| `hooks` | record | ❌ | session-scoped hooks |
| `skills` | string[] | ❌ | 预加载 skill 名 |
| `color` | enum | ❌ | UI 区分色 |
| `memory` | enum | ❌ | `user` / `project` / `local` —— 持久 memory scope |
| `maxTurns` | int | ❌ | 最大 agentic turns |
| `background` | bool | ❌ | 永远 background task |
| `isolation` | enum | ❌ | `worktree` / `remote`（ant-only）|
| `initialPrompt` | string | ❌ | 首轮自动 prepend |
| `criticalSystemReminder_EXPERIMENTAL` | string | ❌ | **每个 user turn 重注入**——确保关键约束不被遗忘 |
| `omitClaudeMd` | bool | ❌ | **省 CLAUDE.md 上下文**——read-only agents（Explore/Plan）启用省 ~5-15 Gtok/周 |
| `requiredMcpServers` | string[] | ❌ | 必须的 MCP server pattern |

## 五、6 种 Settings Source（放置策略）

| Source | 路径 | 共享范围 | git commit? | UI 是否可编辑 |
|---|---|---|---|:---:|
| `built-in` | 代码内嵌 | 全用户 | — | ❌（read-only）|
| `userSettings` | `~/.claude/agents/*.md` | 当前用户 | ❌ | ✅ |
| `projectSettings` | `<cwd>/.claude/agents/*.md` | 项目所有协作者 | ✅ 可 commit | ✅ |
| `localSettings` | `<cwd>/.claude/agents/*.md`（gitignore）| 个人项目级 | ❌ | ✅ |
| `policySettings` | managed path（企业）| 组织强制 | — | ❌（read-only）|
| `flagSettings` | CLI flag 运行时注入 | 本次启动 | — | ❌ |
| `plugin` | 插件提供（动态）| 安装该插件用户 | — | ❌ |

`AgentsList.tsx` 通过 `source` filter 让用户筛选不同来源的 agent；同名 agent 按优先级解析（flagSettings > projectSettings > localSettings > userSettings > built-in）。

## 六、11-Step Create Wizard

```typescript
// components/agents/new-agent-creation/CreateAgentWizard.tsx:69
const steps = [
  LocationStep,    // 0  选放在哪
  MethodStep,      // 1  Generate / Manual
  GenerateStep,    // 2  AI 生成（仅 Generate）
  TypeStep,        // 3  agent type 命名
  PromptStep,      // 4  system prompt
  DescriptionStep, // 5  whenToUse
  ToolsStep,       // 6  工具勾选
  ModelStep,       // 7  model
  ColorStep,       // 8  颜色
  ...(isAutoMemoryEnabled() ? [MemoryStep] : []),  // 9  GrowthBook 条件 gate
  ConfirmStep,     // 10 确认 + 写文件
]
```

### Wizard 关键技术点

1. **`isAutoMemoryEnabled()` GrowthBook gate**——MemoryStep 是 progressive rollout，用 feature flag 控制是否暴露给用户
2. **Generate / Manual 分支**：Generate 路径走 `GenerateStep`（AI 生成预填后续 step）；Manual 路径跳过 GenerateStep
3. **数据传递**：`WizardProvider<AgentWizardData>` 维护 wizard data；每个 step `({ data, setData, next, prev }) => ReactNode`
4. **取消**：任意 step 按 `Esc` → `onCancel` 回 main-menu，不写文件

## 七、AI 生成 Agent（杀手 feature）

`components/agents/generateAgent.ts` 用一个 ~1500-token system prompt 调 LLM 生成完整 agent 配置。

### 系统 prompt 节选

```
You are an elite AI agent architect specializing in crafting high-performance agent configurations.

When a user describes what they want an agent to do, you will:

1. **Extract Core Intent**: 识别 fundamental purpose / key responsibilities / success criteria
2. **Design Expert Persona**: 创建 compelling expert identity
3. **Architect Comprehensive Instructions**: 行为边界 + 方法论 + edge case 处理
4. **Optimize for Performance**: 决策框架 + 自检 + escalation
5. **Create Identifier**: lowercase + hyphen + 2-4 词 + 避免 "helper" / "assistant"
6. **Example agent descriptions**: whenToUse 中加 <example> 标签

Output JSON:
{
  "identifier": "code-reviewer",
  "whenToUse": "...",
  "systemPrompt": "You are an elite code reviewer..."
}
```

### 实现流程

```ts
// generateAgent.ts
const response = await queryModelWithoutStreaming({
  systemPrompt: asSystemPrompt(AGENT_CREATION_SYSTEM_PROMPT),
  messages: prependUserContext([createUserMessage(userDescription)]),
  toolPermissionContext: getEmptyToolPermissionContext(),
})

const parsed = jsonParse(response.content[0].text)
// → { identifier, whenToUse, systemPrompt }

// 注入到 wizard data，预填后续 TypeStep / PromptStep / DescriptionStep
```

**关键设计点**：
- 用 **`queryModelWithoutStreaming`** 而非主 agent loop——独立 sub-query 不污染主 conversation
- **`prependUserContext`** 注入 CLAUDE.md / 项目上下文——生成的 agent 自动 align 项目 conventions
- **`toolPermissionContext: empty`**——LLM 不能调工具，只能生成文本
- **`asSystemPrompt`** 类型化 wrapper 防误用
- 输出 JSON 严格 schema（`{identifier, whenToUse, systemPrompt}`）

### `logEvent` 分析埋点

```ts
logEvent({
  eventName: 'tengu_agent_generated',
  fields: { /* AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS */ },
})
```

—— 注意类型名 `I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`——Anthropic 用 type-level 强制确认埋点不含敏感数据。

## 八、ToolSelector — MCP 工具合并展示

`ToolSelector.tsx` (561 LOC) 是 wizard 内最大组件，关键能力：

1. **合并展示内置 + MCP 工具**：用 `useMergedTools(tools, mcpTools, toolPermissionContext)` hook
2. **wildcard 处理**：`*` 表示全部允许，UI 显示 "All tools"
3. **invalidTools 警告**：agent 引用了不存在的工具 → 渲染 `figures.warning` + 黄色提示
4. **嵌套 namespace**：MCP tool 名 `mcp__server__tool_name` 分组展示
5. **resolveAgentTools(agent, tools, false)** 解析最终允许集

## 九、与 Qwen Code 的对比

| 维度 | Claude Code `/agents` | Qwen Code 当前 |
|---|---|---|
| Slash command | `/agents` local-jsx | `/agents` slash command（实现简单）|
| Agent 文件格式 | markdown + YAML frontmatter | 同款（PR#3873 subagent config 隔离已用）|
| Wizard 步数 | 11 step | 较简（无 wizard）|
| AI 生成 agent | ✅ 长 system prompt + LLM | ❌ **无等价能力** |
| 6 Source 分层 | built-in / user / project / local / policy / flag / plugin | 较简 |
| 工具选择 UI | 含 MCP tools 合并展示 + invalid 警告 | 较简 |
| `isolation: worktree/remote` | ✅ ant-only | PR#4073 Worktree* tools OPEN（[builtin-tools §3.10](./claude-code-vs-qwen-code-builtin-tools.md) P1 借鉴）|
| `omitClaudeMd` 优化 | ✅ 省 ~5-15 Gtok/周 | ❌ **无** |
| `criticalSystemReminder_EXPERIMENTAL` | ✅ 每 user turn 重注入 | ❌ **无** |
| `memory` scope（user/project/local 持久化）| ✅ + 自动 snapshot 恢复（GrowthBook gated）| ❌ **无** |
| `effort` thinking level | ✅ enum / int | 部分（详 [reasoning-effort-deep-dive.md](./reasoning-effort-deep-dive.md)）|
| `hooks` per-agent | ✅ session-scoped | PR#4072 Agent hooks via headless subagent OPEN |
| 整体 LOC | ~3042 | 较少 |

## 十、对 Qwen Code daemon-design 的启发

### 10.1 Stage 1.5c daemon-side state CRUD 的范本

Claude Code `/agents` 是 **local-jsx 不出 wire** 的典型 dialog——这与 [daemon-design §04 §二 "wire 只承载 agent↔user conversation；TUI mutations 不出 wire"](./qwen-code-daemon-design/04-deployment-and-client.md) 完全契合。**Stage 1.5c 需要把同等功能暴露给远端 client**：

```
当前（Stage 1）：
  Mode A 本地 TUI 用户 → /agents → Ink TUI 内本地 render ✅
  Mode B 远端 client → ??? → 看不到 daemon-side agent state ❌

Stage 1.5c 加 wire route：
  GET    /workspace/agents              — list agents（含 source filter）
  GET    /workspace/agents/:agentType   — agent 详情
  POST   /workspace/agents              — 创建 agent
  PUT    /workspace/agents/:agentType   — 编辑 agent
  DELETE /workspace/agents/:agentType   — 删除 agent
  POST   /workspace/agents/generate     — AI 生成 agent ★（启发自 Claude）
  GET    /workspace/agents/sources      — 列出所有 source 路径
```

详 [daemon-design §06 §三 Stage 1.5c](./qwen-code-daemon-design/06-roadmap.md)。

### 10.2 文件格式 + Source 分层可直接借鉴

Claude 的 markdown + YAML frontmatter 是 **事实标准**（OpenAI Codex / Cursor / Cline 都用类似格式）—— **Qwen 应保持兼容**（互通性 + 用户跨工具迁移）。Source 6 层分层（built-in / user / project / local / policy / flag / plugin）也是合理抽象，建议直接 port。

### 10.3 AI 生成 agent 是缺失的杀手 feature

Qwen Code 当前没有 `/agents generate` 能力。可作为 **Stage 2+ candidate**：
- 类似 `/goal` 用 LLM-as-judge 思路（详 [PR#4088 /goal subquery](./qwen-code-improvement-report.md)）
- 但 task 是"生成 agent 定义"而非"判断 goal 完成"
- 实现：`queryModelWithoutStreaming` + 长 system prompt + JSON 输出 schema 验证
- UI：wizard 内"Generate"分支调用

### 10.4 `omitClaudeMd` 优化值得移植

Claude 报告：Explore / Plan 等 read-only agents 启用 `omitClaudeMd` 省 **~5-15 Gtok/周**。按 Qwen Code 用户量推算同等优化可省大量 token cost。**P1 借鉴项**。

实现：
1. `AgentDefinition` 加 `omitClaudeMd?: boolean` 字段
2. `newSessionConfig(cwd, ..., agentType)` 中检查该字段，若 true 则跳过 `prependUserContext` 中 CLAUDE.md 注入
3. 内置 `Explore` / `Plan` 等 read-only agent 默认开启
4. 可加 kill-switch（如 Claude 的 `tengu_slim_subagent_claudemd`）

### 10.5 `criticalSystemReminder_EXPERIMENTAL` — 每 turn 重注入

agent 定义中 `criticalSystemReminder_EXPERIMENTAL` 字段会在**每个 user turn 重新注入**到上下文——确保关键约束（如 "Always verify with tests"）不被 context 滚动遗忘。

实现：
1. `AgentDefinition` 加 `criticalSystemReminder?: string` 字段
2. agent loop 每次构建 user turn message 时，prepend `<system-reminder>${criticalSystemReminder}</system-reminder>`
3. 配合 Qwen 已有 `system-reminder` 机制（详 [improvement-report item-26](./qwen-code-improvement-report.md)）

### 10.6 `isolation: 'worktree'` 与 PR#4073 协调

Claude 已 ship 这个能力（ant-only `worktree | remote`）；Qwen Code PR#4073 Worktree* tools OPEN—— agent 定义中显式声明 `isolation: 'worktree'` 时，agent spawn 在独立 worktree 运行（详 [claude-code-vs-qwen-code-builtin-tools.md §3.10](./claude-code-vs-qwen-code-builtin-tools.md) P1 借鉴项）。

### 10.7 GrowthBook 条件 step（progressive rollout 范本）

`MemoryStep` 用 GrowthBook gate（`isAutoMemoryEnabled()`）控制是否暴露 —— Anthropic 在新功能 GA 前用 feature flag 渐进 rollout 的范本。Qwen Code 可借鉴此模式做 risky 功能（如 AI 生成 agent / `omitClaudeMd` 等）的灰度。

## 十一、潜在 P0 / P1 借鉴项总结

| 优先级 | 借鉴项 | 工作量 | 关键收益 |
|:------:|---|---|---|
| **P0** | `/agents` daemon-side state CRUD（Stage 1.5c）| ~0.5d / route × 7 routes ≈ ~3-5d | 远端 client 等价 Mode A（解 thin shell 限制）|
| **P0** | `omitClaudeMd` for read-only agents | ~1d | 省 ~5-15 Gtok/周 token cost |
| **P1** | AI 生成 agent（`/agents generate`）| ~2-3d | 用户体验提升 + 降低门槛 |
| **P1** | `criticalSystemReminder_EXPERIMENTAL` per-agent | ~1d | 长 session 关键约束防遗忘 |
| **P1** | `isolation: 'worktree'` agent 定义字段（依赖 PR#4073）| ~0.5d（加字段）+ PR#4073 | 隔离 agent 工作空间 |
| **P2** | 6 Source 分层（含 plugin / policy）| ~2-3d | 企业部署 + 插件生态 |
| **P2** | 11-step wizard UI | ~3-5d | 降低 agent 创建门槛 |
| **P2** | ToolSelector MCP 合并展示 | ~1-2d | UI 完整性 |

## 十二、相关文档

- [Agent 创建向导 Deep-Dive](./interactive-agent-creation-deep-dive.md) — **本文 §六 wizard 部分的更深分析**（Qwen Code 借鉴 wizard UX 的 actionable 蓝图）
- [SubAgent 展示 Deep-Dive](./subagent-display-deep-dive.md)—— **运行状态**展示（不是定义管理）
- [Fork Subagent Deep-Dive](./fork-subagent-deep-dive.md) — Subagent 启动机制
- [Agent Tool Access Control Deep-Dive](./agent-tool-access-control-deep-dive.md) — 工具权限控制
- [Agent Memory Persistence Deep-Dive](./agent-memory-persistence-deep-dive.md) — `memory` scope 字段
- [Reasoning Effort Deep-Dive](./reasoning-effort-deep-dive.md) — `effort` 字段对比
- [Claude Code vs Qwen Code 内置工具对比](./claude-code-vs-qwen-code-builtin-tools.md) — Worktree* P1 借鉴项
- [Qwen Code Daemon 架构设计 §04](./qwen-code-daemon-design/04-deployment-and-client.md) — Stage 1.5c daemon-side state CRUD 设计
- [Qwen Code Daemon 架构设计 §06](./qwen-code-daemon-design/06-roadmap.md) — Stage 1.5c roadmap

---

> **数据来源**：claude-code v2.1.139 反编译源码（`/root/git/claude-code-leaked/components/agents/`）；2026-05-15 分析。所有 LOC 数字基于 sourcemap 化简后版本，实际 release 行数会有压缩 / 优化差异。
