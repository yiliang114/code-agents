# Todo / Plan 展示 Deep-Dive——4 方对比（Qwen Code / OpenCode / Codex CLI / Claude Code）

> Code Agent 的"任务列表 / Plan"展示，是 LLM 跟踪工作进展的核心 UX。本文 4 方源码层对比工具命名、数据结构、UI 展示、智能集成、resize 行为、设计哲学。
>
> **更新日期**：2026-05-07

## 零、4 方源码定位

| Agent | 数据来源 | 工具 / UI 关键文件 |
|---|---|---|
| **Claude Code** | **v2.1.133 prod binary 实测**（2026-05-08 安装版）+ leaked 仓（v2.1.81 时点）交叉验证 | binary `strings` 提取 prompt + `tools/TodoWriteTool/TodoWriteTool.ts`（leaked）|
| **Qwen Code** | v0.16.0 GitHub 公开源码 | `packages/core/src/tools/todoWrite.ts`（606 行）+ `cli/src/ui/components/TodoDisplay.tsx`（72 行）+ **`StickyTodoList.tsx`**（135 行）|
| **OpenCode** | GitHub 公开源码 | `packages/opencode/src/tool/todo.ts` + `src/session/todo.ts` + `cli/cmd/tui/component/todo-item.tsx` + **`app/src/pages/session/composer/session-todo-dock.tsx`** + `feature-plugins/sidebar/todo.tsx` + `app/e2e/todo.spec.ts` + `ui/src/components/todo-panel-motion.stories.tsx` |
| **Codex CLI** | GitHub 公开源码 | `codex-rs/core/src/tools/spec_tests.rs`（`update_plan` 注册）+ `codex-rs/tui/src/history_cell.rs:2557 new_plan_update` + `PlanUpdateCell` + `ProposedPlanCell` + `ProposedPlanStreamCell` |

> **重要更新（2026-05-08）**：本节 Claude Code 数据**已升级**——之前仅基于反编译的 leaked 仓（v2.1.81 时点 + feature-gated 代码），现新增 **v2.1.133 prod binary 实测**（`/root/.local/share/claude/versions/2.1.133`）交叉验证。两份数据有显著差异：leaked 仓含 `verificationNudgeNeeded` / `isTodoV2Enabled` 等 feature-gated 代码，但 v2.1.133 prod binary 实测**这些字符串均为 0 计数**——确认是 build-time DCE 掉了（参考 [Claude Code 22 个 Feature Flag DCE](../tools/claude-code/03-architecture.md)）。本文 Claude 部分以 **v2.1.133 prod binary 为准**，leaked 仓数据仅作"开发分支可能能力"参考。

## 一、TL;DR

```
Claude Code  → 智能化最深（VerificationNudge + Auto Mode 集成 + V2 feature gate）
Qwen Code    → 唯一 sticky 常驻列表（StickyTodoList 屏幕固定位置展示）
OpenCode     → 多端 UI 最丰富（CLI + Web dock + Sidebar + 4 状态 + 优先级）
Codex CLI    → 设计分叉（不叫 todo，叫 update_plan，含 explanation 叙事）
```

**共识**：4 方都用"工具触发 + UI 渲染"两层架构，但 4 方有 4 种不同侧重——智能化、视觉一致性、多端 UX、表达力。

## 二、工具命名 + 状态种类

| Agent | 工具名 | 状态种类（数）| 视觉规范 |
|---|---|---|---|
| **Claude Code** | `TodoWrite`（v2.1.133 binary 中变量名 `$R="TodoWrite"`）| **3 类**：pending / in_progress / completed（v2.1.133 binary prompt 实测确认；**无 cancelled**；`isTodoV2Enabled` / `cancelled` / 等扩展状态在 prod binary 中均**未发现**）| 组件名未在 binary 暴露 |
| **Qwen Code** | `todoWrite` | 3 类：pending / in_progress / completed | `○ ◐ ●` |
| **OpenCode** | `todowrite` | **4 类**：pending / in_progress / completed / **cancelled** | Checkbox + animated dot（in_progress）|
| **Codex CLI** | `update_plan`（**不叫 todo**）| 2 状态：✔ completed / □ pending（Codex 文档实测中 in_progress 也存在）| `• Updated Plan` + `└ explanation` + `✔ □` |

**独家命名**：Codex 把工具叫 **`update_plan`** 而非 `todo_write`——这暗示语义差异（plan 是"叙事 + 步骤"，todo 是"任务列表"）。

**Claude Code 状态种类校正（v2.1.133 binary 实测）**：之前推测 v2.1.133 可能有 `cancelled` 或 V2 扩展状态——实测确认**仍是 3 类**（与 v2.1.81 一致）。OpenCode 是 4 方里唯一有 cancelled 状态的。

## 三、数据结构差异

### 3.1 Claude Code（v2.1.133 binary 实测 + leaked 仓交叉验证）

**v2.1.133 prod binary 中 prompt 原文**（`strings` 提取）：

> "Each todo has `content`, `status` ("pending" | "in_progress" | "completed"), and **`activeForm`** (present-tense label shown while in progress)."

> "Update the todo list for the current session. To be used proactively and often to track progress and pending tasks. **Make sure that at least one task is in_progress at all times.** Always provide both content (imperative) and activeForm (present continuous) for each task."

→ **`activeForm` 字段在 v2.1.133 是真实字段，不是暗示**。LLM 必须为每个 task 提供两个版本：
- `content`: imperative 形式（"Investigate error paths"）
- `activeForm`: present continuous 形式（"Investigating error paths"，显示在 in_progress 时）

**Schema 实测**（v2.1.133 prod 简化版）：

```ts
{
  content: string,        // imperative
  status: 'pending' | 'in_progress' | 'completed',
  activeForm: string,     // present continuous（in_progress 显示用）
}
```

**leaked 仓（v2.1.81 时点 + feature-gated）补充信息**：

```ts
// tools/TodoWriteTool/TodoWriteTool.ts:21-26
const outputSchema = lazySchema(() =>
  z.object({
    oldTodos: TodoListSchema(),
    newTodos: TodoListSchema(),
    verificationNudgeNeeded: z.boolean().optional(),  // ⚠ feature-gated（VERIFICATION_AGENT + tengu_hive_evidence）
  }),
)
```

→ `verificationNudgeNeeded` 字段在 leaked 仓存在但 v2.1.133 prod binary 中**未发现相关字符串**——意味着 feature flag DCE 掉了。当前 prod 不启用 verification nudge。

### 3.2 Qwen Code

```ts
// packages/core/src/hooks/types.ts（v0.16.0 移至此处，todoWrite.ts re-export）
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;  // = 'pending' | 'in_progress' | 'completed'
}
```

最简洁 schema：3 字段（字段不变，类型定义从 `todoWrite.ts` 移至 `hooks/types.ts`，通过 `export type { TodoItem } from '../hooks/types.js'` re-export）。v0.16.0 新增 `TodoCreated` / `TodoCompleted` hook 生命周期事件，`todoWrite.ts` 增至 606 行（原 v0.15.7 约 470 行）——增量主要是 hook 验证阶段（Validation Phase）和 postWrite 回调逻辑，不影响 schema 字段和 UI 渲染。

### 3.3 OpenCode

```ts
// packages/opencode/src/tool/todo.ts
const TodoItem = Schema.Struct({
  content: Schema.String,
  status: Schema.String,           // pending | in_progress | completed | cancelled
  priority: Schema.String,         // 独家：high | medium | low
})

export const Parameters = Schema.Struct({
  todos: Schema.mutable(Schema.Array(TodoItem)),
})
```

**独家 priority 字段**——4 方里只有 OpenCode 有任务优先级。

### 3.4 Codex CLI

```rust
// codex-rs/protocol-types/src/plan_tool.rs
struct UpdatePlanArgs {
    explanation: String,      // 独家：plan 整体叙事（独立于 items）
    plan: Vec<PlanItemArg>,
}

struct PlanItemArg {
    step: String,
    status: PlanItemStatus,   // pending | in_progress | completed
}
```

**独家 `explanation` 字段**——4 方里只有 Codex 有"plan 叙事"概念，把"为什么这个 plan"和"plan 的 steps"分开。

### 3.5 关键 schema 差异速览

| 字段 | Claude（v2.1.133）| Qwen | OpenCode | Codex |
|---|---|---|---|---|
| id | ✓ | ✓ | ✗（隐式 index）| ✗（隐式 index）|
| content / step | ✓ content（imperative）| ✓ content | ✓ content | ✓ step |
| status | ✓ 3 类 | ✓ 3 类 | ✓ 4 类 | ✓ 3 类 |
| **priority** | ✗ | ✗ | **✓ high/medium/low** | ✗ |
| **explanation**（叙事）| ✗ | ✗ | ✗ | **✓** |
| **activeForm**（动名词，in_progress 时显示）| **✓ 实测确认（v2.1.133 binary）** | ✗ | ✗ | ✗ |
| **at least one in_progress 强约束**（prompt 级）| **✓ "at least one task is in_progress at all times"** | ✗ | ✗ | ✗ |

## 四、UI 展示位置详解

### 4.1 Claude Code

| 维度 | 现状 |
|---|---|
| TUI 渲染位置 | leaked 仓未导出独立组件（推测 inline tool result）|
| 持久化 | `appState.todos[todoKey]`，**sessionId-keyed**（每 session 独立）|
| 多端 | CLI only（推测 web 版有但未 leaked）|
| renderToolUseMessage | `return null`（不渲染默认 tool message）|

### 4.2 Qwen Code

| 维度 | 现状 |
|---|---|
| TUI 渲染（基础）| `TodoDisplay.tsx`（72 行 · 列表内联）|
| **Sticky 常驻**（独家）| **`StickyTodoList.tsx`**（135 行 · `STICKY_TODO_MAX_VISIBLE_ITEMS` 限高 · `getOrderedStickyTodos` 排序 · `getStickyTodosRenderKey` 重渲染信号）|
| 持久化辅助 | `cli/src/ui/utils/todoSnapshot.ts`（snapshot diff 工具）|
| 多端 | CLI only |

```tsx
// StickyTodoList.tsx 核心结构（推测 layout）
<Box flexDirection="column">
  {orderedTodos.slice(0, STICKY_TODO_MAX_VISIBLE_ITEMS).map(todo => (
    <Text>{STATUS_ICONS[todo.status]} {todo.content}</Text>
  ))}
</Box>
```

**独家**：屏幕**固定位置常驻**显示 Todo——4 方里仅 Qwen 有这种"屏幕边缘任务栏"。

### 4.3 OpenCode

OpenCode 的 Todo UI 是 4 方里**最丰富的**：

| 位置 | 文件 | 形态 |
|---|---|---|
| TUI inline | `cli/cmd/tui/component/todo-item.tsx` | 列表内联 |
| **Web UI dock** | `app/src/pages/session/composer/session-todo-dock.tsx` | **dock-tray + Checkbox + AnimatedNumber + TextReveal + TextStrikethrough + motion-spring 动画** |
| Sidebar plugin | `cli/cmd/tui/feature-plugins/sidebar/todo.tsx` | 侧栏插件展示 |
| E2E 测试 | `app/e2e/todo.spec.ts` | 完整端到端测试 |
| 图标 | `ui/src/assets/icons/file-types/todo.svg` | UI 资产 |
| Storybook | `ui/src/components/todo-panel-motion.stories.tsx` | 动画 stories |

```tsx
// session-todo-dock.tsx (摘录)
function dot(status: Todo["status"]) {
  if (status !== "in_progress") return undefined
  return (
    <svg ...>
      <circle cx="6" cy="6" r="3"
        style={{ animation: "var(--animate-pulse-scale)" }}/>
    </svg>
  )
}
```

**独家**：**in_progress 状态有 pulse-scale 动画 dot**——视觉反馈最丰富。

### 4.4 Codex CLI

| 维度 | 现状 |
|---|---|
| 渲染入口 | `codex-rs/tui/src/history_cell.rs:2557 new_plan_update` |
| 持久 cell 类型 | `PlanUpdateCell { explanation, plan }`（结构化）|
| **Streaming cell** 类型 | `ProposedPlanStreamCell { lines, is_stream_continuation }`（瞬时）|
| **Source-backed cell** 类型 | `ProposedPlanCell { plan_markdown, cwd }`（finalized · 含 cwd 用于 link reflow）|
| Snapshot 渲染（实测）| `• Updated Plan / └ explanation / ✔ ✓ items / □ pending items` |

```rust
// 实测 snapshot 输出（codex_tui__history_cell__tests__plan_update_with_note_and_wrapping_snapshot.snap）
• Updated Plan
  └ I'll update Grafana call
    error handling by adding
    retries and clearer messages
    when the backend is
    unreachable.
    ✔ Investigate existing error
      paths and logging around
      HTTP timeouts
    □ Harden Grafana client
      error handling with retry/
      backoff and user-friendly
      messages
    □ Add tests for transient
      failure scenarios and
      surfacing to the UI
```

**独家**：**streaming → finalized 双 cell 结构**——streaming 期间用 `ProposedPlanStreamCell`（已渲染 lines 但不可重 reflow），完成后 consolidate 为 `ProposedPlanCell`（store raw markdown + cwd，**支持 terminal resize 时 reflow 重渲染**）。

## 五、智能集成深度对比

### 5.1 Claude Code — 双层智能化（v2.1.133 prod 实测）

**Layer 1：v2.1.133 prod binary 中实际启用的 nudge 系统（"turnsSinceLastTodoWrite" 计数器）**

binary 实测原文（system reminder 注入到对话）：

> "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. **This is just a gentle reminder — ignore if not applicable. Make sure that you NEVER mention this reminder to the user.**"

机制：
- `turnsSinceLastTodoWrite` 计数器跟踪上次 TodoWrite 调用距今轮数
- 超阈值 → system 注入"gentle reminder" 提示 LLM
- LLM 不能向用户提及这个 reminder（强约束）

**Layer 2：activeForm 强约束（v2.1.133 prompt 内）**

binary 实测原文：

> "**Make sure that at least one task is in_progress at all times.** Always provide both content (imperative) and activeForm (present continuous) for each task."

机制：
- prompt 级约束 LLM 始终保持至少一个 in_progress
- `activeForm`（动名词，"Investigating ..."）vs `content`（imperative，"Investigate ..."）双形态
- in_progress 时 UI 显示 activeForm 给用户看（present continuous 比 imperative 更自然）

**Layer 3（leaked 仓里的 feature-gated 代码，v2.1.133 prod 中已 DCE）**

```ts
// leaked: tools/TodoWriteTool/TodoWriteTool.ts:64-76
let verificationNudgeNeeded = false
if (
  feature('VERIFICATION_AGENT') &&
  getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&
  !context.agentId &&
  allDone &&
  todos.length >= 3 &&
  !todos.some(t => /verif/i.test(t.content))
) {
  verificationNudgeNeeded = true
}
```

⚠️ **状态**：v2.1.133 prod binary 实测中 `verificationNudgeNeeded` / `VERIFICATION_AGENT` / `tengu_hive_evidence` 均**未发现字符串**——feature flag 关着，build 时 DCE 掉了。**当前 prod 用户不会触发此功能**。leaked 仓数据仅作"开发分支正在做"的参考。

**Claude 智能化总结**：
- ✓ **使用频率 nudge**（turnsSinceLastTodoWrite + system reminder）—— **v2.1.133 prod 实际启用**
- ✓ **强约束在 prompt**（at least one in_progress + dual content/activeForm）—— **v2.1.133 prod 实际启用**
- ⚠ Verification Agent nudge —— **feature-gated 关着**（leaked 仓里有，prod 没有）
- ⚠ V2 演进 —— **DCE 掉**（leaked 仓有 `isTodoV2Enabled()` gate，prod binary 找不到字符串）

→ Claude 实际策略是"**用 prompt 约束 + 用 reminder 推动**"，而非纯 schema 字段创新。verification 走的是**别的工具**（不是 TodoWrite 内置）。

### 5.2 Qwen Code — 基础展示

- 工具 + 2 个 UI 组件（TodoDisplay + StickyTodoList）
- 无 nudge / 无 classifier / 无 V2 演进
- 470 行工具实现（远比 Claude 120 行多）—— 但不在智能化方向，可能是 i18n / 验证 / sticky 集成的工程量

→ Qwen 把 todo 视为**视觉 UX**——重心在常驻显示（StickyTodoList）让用户始终看到进展。

### 5.3 OpenCode — UI 最佳，无智能化

- Effect Schema 替代 zod
- 4 状态（含 cancelled）+ 优先级
- Web UI 动画（AnimatedNumber / TextReveal / TextStrikethrough / motion-spring / pulse-scale dot）
- 无 verification nudge / 无 classifier 集成

→ OpenCode 把 todo 视为**多端共享 UX**——CLI + Web dock + Sidebar 三处展示，体验最丰富但智能化最弱。

### 5.4 Codex CLI — 表达力最强

- `explanation` 字段：plan 整体叙事独立于 items
- streaming → finalized 双 cell 结构
- 完整 resize reflow（store raw markdown + cwd）

→ Codex 把 plan 视为**LLM 输出的结构化展示**——重心在"如何展示 plan 让用户理解 LLM 思路"，而非追踪进度。这与其他 3 方的"任务列表"哲学不同。

## 六、跨终端 reflow / 持久化 / 多端

| Agent | resize 行为 | 持久化 | 多端同步 |
|---|---|---|---|
| **Claude Code** | 推测静态（leaked 仓未见 reflow 代码）| `appState.todos[todoKey]`（sessionId-keyed）| 推测无 |
| **Qwen Code** | sticky list 按宽度截断（`STICKY_TODO_MAX_VISIBLE_ITEMS`）| 内存 state | 无 |
| **OpenCode** | TUI 静态 + **Web UI 响应式 CSS** | Effect `Todo.Service` + `@opencode-ai/sdk/v2` | **✓ CLI ↔ Web SDK 同步** |
| **Codex CLI** | **完整 reflow**（store raw markdown + 重新渲染）| history cell（消息流持久化）| 无 |

**Codex 独家 reflow**：

```rust
/// Finalized proposed-plan history that can render itself again for a new width.
/// 
/// This is the source-backed counterpart to `ProposedPlanStreamCell`. It owns 
/// raw markdown and the session cwd needed for stable local-link rendering 
/// during later transcript reflow.
pub(crate) struct ProposedPlanCell {
    plan_markdown: String,
    cwd: PathBuf,
}
```

reflow 设计的**意义**：用户调整终端宽度时，plan 不会变成乱码——4 方里只有 Codex 显式处理这个问题。

## 七、设计哲学一句话

| Agent | 设计目标 |
|---|---|
| **Claude Code** | "智能跟踪 + 防 LLM 跳过验证"（VerificationNudge + Auto Mode 集成）|
| **Qwen Code** | "视觉一致性 + 持续可见"（StickyTodoList 屏幕常驻）|
| **OpenCode** | "多端最佳 UX"（Web dock-tray 动画 + 优先级 + 多 status 维度）|
| **Codex CLI** | "plan = 叙事 + checkbox 一体"（explanation 字段独立 + 完整 resize reflow）|

## 八、关键差异化矩阵

| 能力 | Claude | Qwen | OpenCode | Codex |
|---|---|---|---|---|
| 工具命名 | TodoWrite | todoWrite | todowrite | **update_plan** |
| 状态数 | 3 | 3 | **4**（+ cancelled）| 3（实测含 in_progress）|
| 优先级字段 | ✗ | ✗ | **✓** | ✗ |
| 叙事字段（explanation）| ✗ | ✗ | ✗ | **✓** |
| activeForm（动名词）| ✓ 暗示 | ✗ | ✗ | ✗ |
| **Sticky 屏幕常驻** | ✗ | **✓** | ✗（dock 在 Web）| ✗ |
| **Web UI dock** | ✗ | ✗ | **✓ + 动画** | ✗ |
| **In_progress 动画 dot** | ✗ | ✗ | **✓ pulse-scale** | ✗ |
| **VerificationNudge** | **✓ feature-gated** | ✗ | ✗ | ✗ |
| **Auto Mode classifier 集成** | **✓ toAutoClassifierInput** | ✗ | ✗ | ✗ |
| **shouldDefer**（不阻塞 tool flow）| **✓** | ? | ? | ? |
| **streaming / finalized 双 cell** | ✗ | ✗ | ✗ | **✓** |
| **Resize reflow**（raw markdown 重渲染）| ✗ | partial（截断）| Web 响应式 | **✓ raw markdown + cwd** |
| **多端 SDK 同步** | ✗（推测）| ✗ | **✓ CLI ↔ Web SDK** | ✗ |
| 状态视觉规范 | 未公开 | `○ ◐ ●` | Checkbox + dot | `✔ □` + `• `+`└` |
| Schema 引擎 | zod | zod | **Effect Schema** | Rust struct（serde）|

## 九、关键洞察

### 9.1 Codex 走分叉路线

把"todo"抽象成 **plan = explanation + checkbox steps**——工具叫 `update_plan` 不叫 todo。设计上更接近"LLM 输出的结构化叙事 + 进度",而非"用户任务列表"。

### 9.2 OpenCode UI 最丰富但智能化最弱

4 状态（多一个 cancelled）+ 优先级（high/medium/low）+ Web dock + 动画 + Sidebar + Storybook + e2e test——但**无 verification nudge / 无 LLM-in-the-loop 智能集成**。

### 9.3 Claude 智能化策略：prompt 约束 + reminder（v2.1.133 prod 实测）

binary 实测显示 Claude 的智能化是**两层组合**：
1. **prompt 强约束**："at least one task is in_progress at all times" + dual content/activeForm
2. **system reminder**：`turnsSinceLastTodoWrite` 计数器超阈值时注入"gentle reminder"

之前推测的 VerificationNudge / Auto Mode classifier 集成 / V2 gate **均在 v2.1.133 prod binary 中找不到字符串**——确认是 feature flag DCE 掉了（仅 leaked 开发分支可见）。

UI 层面 binary 也未暴露独立 TodoDisplay 组件名——可能 Claude 走 inline tool result 渲染（与 Codex 同思路）。

### 9.4 Qwen 独家 StickyTodoList

4 方里**唯一有"sticky 屏幕常驻"展示**——其他 3 方要么在消息流内（Claude/Codex）要么在 Web dock（OpenCode）。`STICKY_TODO_MAX_VISIBLE_ITEMS` 限高的设计避免占屏过多。

### 9.5 Verification Agent 思路（leaked 仓有 / v2.1.133 prod DCE）

leaked 仓代码显示 Anthropic 在做"todo 关闭 → 自动启动 verification agent"的思路（feature flag `VERIFICATION_AGENT` + `tengu_hive_evidence`）——但 v2.1.133 prod binary 实测**未启用**。这是"开发分支可能能力"，不是当前用户能用到的功能。

如未来 feature flag 打开，将是 4 方里 Claude 独家的 LLM-in-the-loop 反馈思路。

### 9.6 Codex resize reflow 设计精细

`ProposedPlanStreamCell` 流期间快速渲染（已 layout 的 lines）+ `ProposedPlanCell` finalized 后存 raw markdown + cwd 支持 reflow——是**响应式终端 UI** 思路在 Code Agent 的应用范例。

## 十、推荐借鉴方向

### 10.1 Qwen Code 可借鉴

| 借鉴自 | 内容 | 优先级 |
|---|---|---|
| Claude（v2.1.133 实测）| **dual content/activeForm**（imperative + present continuous）+ "at least one in_progress" prompt 约束 | 高 |
| Claude（v2.1.133 实测）| `turnsSinceLastTodoWrite` 计数器 + system reminder 注入 | 中 |
| OpenCode | priority 字段（high/medium/low） | 中 |
| OpenCode | cancelled 状态（明确非 GOAL 终止） | 中 |
| Claude（leaked，feature-gated）| VerificationNudge 思路（待 Anthropic 公开后再考虑）| 低 |
| Codex | explanation 字段（plan 叙事独立） | 低 |
| Codex | resize reflow（raw markdown + cwd） | 中 |

### 10.2 Claude Code 可借鉴

| 借鉴自 | 内容 |
|---|---|
| Qwen | StickyTodoList 屏幕常驻 |
| OpenCode | Web UI dock-tray 动画 |
| Codex | resize reflow |

### 10.3 OpenCode 可借鉴

| 借鉴自 | 内容 |
|---|---|
| Claude | VerificationNudge + LLM-in-the-loop 智能集成 |
| Qwen | StickyTodoList（CLI 端常驻）|

### 10.4 Codex 可借鉴

| 借鉴自 | 内容 |
|---|---|
| OpenCode | priority + cancelled |
| Claude | nudge / classifier 集成 |
| Qwen | sticky 常驻显示 |

## 十一、关键文件速查

| 项目 | 文件 |
|---|---|
| Claude Code 工具 | `tools/TodoWriteTool/TodoWriteTool.ts`（leaked）|
| Claude Code prompt | `tools/TodoWriteTool/prompt.ts`（9527 字节）|
| Claude Code types | `utils/todo/types.ts`（leaked 仅此暴露）|
| Qwen Code 工具 | `packages/core/src/tools/todoWrite.ts`（606 行，v0.16.0）|
| Qwen Code TodoItem 类型 | `packages/core/src/hooks/types.ts`（v0.16.0 移至此处）|
| Qwen Code 内联展示 | `packages/cli/src/ui/components/TodoDisplay.tsx`（72 行）|
| Qwen Code Sticky | `packages/cli/src/ui/components/StickyTodoList.tsx`（135 行）|
| Qwen Code Snapshot | `packages/cli/src/ui/utils/todoSnapshot.ts` |
| OpenCode LLM 工具 | `packages/opencode/src/tool/todo.ts` |
| OpenCode Service | `packages/opencode/src/session/todo.ts` |
| OpenCode TUI | `packages/opencode/src/cli/cmd/tui/component/todo-item.tsx` |
| OpenCode Web Dock | `packages/app/src/pages/session/composer/session-todo-dock.tsx` |
| OpenCode Sidebar | `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/todo.tsx` |
| OpenCode E2E | `packages/app/e2e/todo.spec.ts` |
| OpenCode Stories | `packages/ui/src/components/todo-panel-motion.stories.tsx` |
| Codex 工具注册 | `codex-rs/core/src/tools/spec_tests.rs:419+`（`update_plan`）|
| Codex Plan types | `codex-rs/protocol-types/src/plan_tool.rs`（`UpdatePlanArgs` + `PlanItemArg`）|
| Codex 渲染 | `codex-rs/tui/src/history_cell.rs:2557 new_plan_update` |
| Codex Snapshot tests | `codex-rs/tui/src/snapshots/codex_tui__history_cell__tests__plan_update_*.snap` |

## 十二、与本系列其他文档的关联

| 本文 | 相关 codeagents 文档 |
|---|---|
| Claude VerificationNudge → Verification Agent | [SubAgent 展示 Deep-Dive](./subagent-display-deep-dive.md)——LiveAgentPanel + 多 agent 设计 |
| OpenCode Web SDK 同步 | [Qwen daemon §06 §六 OpenCode 详细对比](./qwen-code-daemon-design/06-roadmap.md) |
| OpenCode 开源 Managed Code Agent | [Managed Code Agents 全景](./managed-agents-landscape.md) |
| 4 方功能矩阵 | [features.md](./features.md) |
| Claude Code v2.1.82 → v2.1.132 增量 | [Claude Code §23 近期更新](../tools/claude-code/23-recent-updates.md) |

## 十三、一句话总结

Code Agent 的 Todo / Plan 展示存在 **4 种设计哲学**：

- **Claude Code**（v2.1.133 prod 实测）：走"**prompt 约束 + reminder**"路线
  - dual content/activeForm 字段（imperative + present continuous，in_progress 时显示 activeForm）
  - "at least one task is in_progress at all times" 强 prompt 约束
  - `turnsSinceLastTodoWrite` 计数器超阈值时 system reminder 注入
  - VerificationNudge / Auto Mode 集成 / V2 演进 → leaked 仓有但 prod **DCE 掉**
- **Qwen Code** v0.16.0：走"**视觉一致性**"路线
  - 独家 `StickyTodoList` 屏幕常驻
  - 简洁 3 状态（pending / in_progress / completed）
  - `TodoDisplay` 内联 + `StickyTodoList` 常驻双展示
  - v0.16.0 新增 `TodoCreated` / `TodoCompleted` hook 事件（生命周期回调，不影响 UI 渲染）
- **OpenCode**：走"**多端 UX**"路线
  - CLI + Web dock-tray 动画 + Sidebar 三处展示
  - 4 状态（**含 cancelled**）+ priority 字段（high/medium/low，4 方独家）
  - Effect Schema + CLI ↔ Web SDK 同步 + e2e 测试 + Storybook
- **Codex CLI**：走"**分叉表达力**"路线
  - 不叫 todo 叫 `update_plan`
  - 独家 `explanation` 叙事字段（独立于 items）
  - streaming / finalized 双 cell 结构 + 完整 resize reflow（raw markdown + cwd）

**4 方共识**："工具触发 + UI 渲染"两层架构。**差异化**体现各自工程偏好：Claude 在 prompt 反馈循环、Qwen 在屏幕占位、OpenCode 在多端动画、Codex 在结构化叙事。

**互相借鉴方向**：Qwen 可吸收 Claude dual content/activeForm + OpenCode priority/cancelled + Codex resize reflow；Claude 可吸收 Qwen StickyTodoList + OpenCode dock 动画 + Codex resize reflow；OpenCode 可吸收 Claude reminder 系统 + Qwen sticky 常驻；Codex 可吸收所有方的 priority + cancelled + sticky。

---

> **数据来源**：本文 4 方源码实测日期 2026-05-07 / 2026-05-08，2026-05-22 对照 Qwen Code v0.16.0 复核。Claude Code 数据来自 **v2.1.133 prod binary 实测**（`/root/.local/share/claude/versions/2.1.133`）+ leaked 仓（v2.1.81 时点）交叉验证——v2.1.133 prod binary 显著删减 leaked 仓中 feature-gated 代码（VerificationNudge / V2 gate / Auto Mode classifier 集成均 DCE）。Qwen Code v0.15.7 → v0.16.0 变化：`TodoItem` 接口移至 `packages/core/src/hooks/types.ts`（字段不变），`todoWrite.ts` 新增 `TodoCreated` / `TodoCompleted` hook 生命周期事件（增至 606 行），`TodoDisplay.tsx`（72 行）与 `StickyTodoList.tsx`（135 行）UI 层无变化。OpenCode / Codex CLI 来自当前 GitHub 公开源码。可能未涵盖正在研发但未合并的 PR。
