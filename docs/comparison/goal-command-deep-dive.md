# `/goal` 命令对比 — 3 方实现深度对比

> Codex CLI / Claude Code / Qwen Code 三家都实现了 `/goal` slash command（"声明任务目标 → agent 持续 turn 直到达成"模式）。本文基于 **Codex 主分支 source** + **Qwen Code PR#4123 + 4 个 follow-up source** + **Claude Code v2.1.139+ 二进制分析** 的逐项对比，覆盖完成判定 / 持久化 / 状态机 / Bootstrap / UI / 安全门禁 / 后续演进。
>
> 数据来源：Codex `/root/git/codex/codex-rs/` ([core/goals.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/goals.rs) + [ext/goal/](https://github.com/openai/codex/tree/main/codex-rs/ext/goal) + tui/goal_*.rs + app-server/thread_goal_processor.rs)；Qwen Code `/root/git/qwen-code/packages/core/src/goals/` ([PR#4123](https://github.com/QwenLM/qwen-code/pull/4123) 已合 + PR#4208/4230/4273 follow-up)；Claude Code v2.1.139+ 二进制（Qwen `goalJudge.ts:23` 注释明确对标 Claude binary `cRK` 函数实现）。
>
> **最后核对**：2026-05-24（三方源码均已 `git pull` 刷新）。

## 一、TL;DR

| 维度 | Codex CLI | Claude Code | Qwen Code |
|---|---|---|---|
| 首次落地 | 2026-04-25（5-PR 系列 #18074-#18078）| 2026-05-11（v2.1.139）| 2026-05-16（[PR#4123](https://github.com/QwenLM/qwen-code/pull/4123)）|
| 实现规模 | core +1641 / tools +280 / TUI 5 文件 ≈ 2,300 LOC + SQL schema + protocol events | 二进制混淆未开源 | 2,089 LOC 业务 + ~1,061 LOC 测试 ≈ **PR +3,476 / 40 files** |
| **完成判定算法** | **模型工具自判** — `create_goal` / `update_goal(complete)` / `get_goal` 三件套；continuation 模板内嵌 completion-audit 指令 | **Stop prompt-hook evaluator** — `cRK` 函数（同 session 内判官 prompt，基于 transcript evidence 判定）| **LLM-as-judge subquery** — 独立 evaluator `runSideQuery`（可走 fast model）+ 严格 JSON schema `{ok, reason}` |
| 底层机制 | **新 subsystem** `GoalRuntimeState` + `GoalRuntimeEvent` 10+ 事件状态机 + dedicated DB | local-jsx + post-text（推断）| **0 新 subsystem**，复用 PR#3471/3488 Stop function-hook plumbing |
| 持久化 | ✅ SQLite `thread_goals` 表 + `StateDbHandle` 跨重启（[#23300](https://github.com/openai/codex/pull/23300) dedicated DB）| ❌ session 内存 | ❌ `activeGoalStore` 进程内存；`restoreGoal.ts` (158 LOC) 仅协助同进程内 history 重渲染 |
| 状态机 | `active` / `paused` / `budget_limited` / `complete`（4 态） | `active` / `cleared`（2 态）| `set` / `achieved` / `aborted` / `cleared`（4 态，无 `paused`）|
| Token 预算 | ✅ `token_budget` 字段 + `budget_limit.md` 模板 steering（[#23696](https://github.com/openai/codex/pull/23696) accounting）| unknown | ❌ 仅迭代数 cap `MAX_GOAL_ITERATIONS=50` |
| Bootstrap 注入 | continuation 模板由模型读取 | — | **首轮 `submit_prompt` 自动注入** `goalInstructionPrompt(q)`（免去 user 手动"开始"）|
| Default 状态 | **2026-05 起 default-on**（非 experimental，[#23732](https://github.com/openai/codex/pull/23732)）| default-on | default-on |

**核心设计哲学差异**：
- **Codex** → "agent 自己声明 + 自己审计 + DB 持久化" —— 完整 subsystem，model-self-judge 风险与扩展性兼顾
- **Claude** → "evaluator 嵌在主 prompt 里" —— 实现轻 + 但耦合 main model 上下文
- **Qwen** → "evaluator 剥出为 fast-model subquery + 零新 subsystem" —— 复用现有 Stop hook plumbing，judge 走独立 LLM 节省主模型 context + 可控性最高

---

## 二、设计哲学对比

### 2.1 Codex：完整 subsystem 范式

Codex 的 `/goal` 是**完整新增子系统**：

- **新 crate `ext/goal/`** —— extension API 形式，含 `lib.rs` / `accounting.rs` / `events.rs` / `tool.rs` / `spec.rs`
- **新 core/goals.rs** + **新 context/goal_context.rs** —— 状态机 + context 注入
- **新 app-server/request_processors/thread_goal_processor.rs** —— RPC 处理
- **5 个 TUI 文件**：`goal_display.rs` / `goal_menu.rs` / `goal_status.rs` / `goal_validation.rs` / `app/thread_goal_actions.rs`
- **新 SQLite 表** `thread_goals` 跨进程持久化
- **新 wire 协议事件** `GoalRuntimeEvent` 10+ 状态转换

**设计取向**：goal 是 first-class concept，值得给它一整套垂直栈。代价是 ~2,300 LOC 业务代码 + DB schema + 协议事件 + UI 5 文件。

**完成判定**：模型自己调 tools `create_goal` / `update_goal(complete)` / `get_goal`；continuation 模板内嵌 completion-audit 指令告诉模型每轮自己审视是否达成。

### 2.2 Claude Code：evaluator 嵌主 prompt

Claude v2.1.139+ 的 `/goal` 用**Stop prompt-hook evaluator**：每轮即将 Stop 前注入一段判官 prompt，让**主 LLM** 基于 transcript evidence 判定是否达成 goal。

- 函数二进制名 `cRK`（Qwen `goalJudge.ts:23` 注释明确对标）
- 实现走 local-jsx + post-text 注入（推断，未开源）
- 状态机简单：`active` / `cleared`

**设计取向**：复用主 LLM 上下文做判定，零额外 inference 成本（在主 turn 末尾 piggy-back），但牺牲了判定的**独立性**（主 model 容易自我说服 "我达成了"）。

### 2.3 Qwen Code：subquery 剥离 + 零新 subsystem

Qwen PR#4123 走第三条路：**LLM-as-judge subquery**，evaluator 完全剥出为独立 sub-call。

- `runSideQuery({model: 'fast'})` 走 fast model（如 GPT-4o-mini / DeepSeek-Lite），不占主模型 context
- 严格 JSON schema `{ok: boolean, reason: string}` 结构化输出，便于程序判定
- **复用现有 hook plumbing** —— 0 新 subsystem，把 goal 包成一个 Stop function-hook，"达成" 等价于"hook 返回 stop"
- 顺带 fix latent bug：`hasHooksForEvent` 之前忽略 session-scoped function hooks

**设计取向**：用最小新增成本（PR +3,476 行包含 ~1,061 行测试，业务实质只 2,089 行）实现等价能力，judge 独立避免自欺。

---

## 三、架构对比

### 3.1 完成判定算法 — 三种范式

```
┌────────────────────────────────────────────────────────────────────┐
│ Codex：模型自判 + 工具调用                                          │
│                                                                     │
│ Turn N:  agent → "tool: update_goal(complete, evidence=...)"        │
│                  ↓                                                  │
│         GoalRuntimeState.transition(active → complete)              │
│                  ↓                                                  │
│         SQLite: UPDATE thread_goals SET status='complete'            │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│ Claude：Stop prompt-hook evaluator                                  │
│                                                                     │
│ Turn N end:  main LLM context + "<evaluator-prompt>判定 goal 是否    │
│                                  达成？基于 transcript evidence..." │
│                  ↓                                                  │
│         同一 main model 给出 yes/no（同 prompt 内）                 │
│                  ↓                                                  │
│         若 no → 注入 continuation 触发 turn N+1                     │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│ Qwen：LLM-as-judge subquery                                         │
│                                                                     │
│ Turn N end:  Stop hook 触发                                         │
│                  ↓                                                  │
│         goalJudge.ts: runSideQuery({                                 │
│           model: 'fast',          ← 独立 sub-call，fast model        │
│           prompt: judgePrompt(goal, transcript),                     │
│           schema: { ok: boolean, reason: string }                    │
│         })                                                          │
│                  ↓                                                  │
│         若 ok=false → 注入 continuation 触发 turn N+1               │
└────────────────────────────────────────────────────────────────────┘
```

**质量与成本权衡**：

| 范式 | 判定独立性 | 成本 | 风险 |
|---|---|---|---|
| Codex 模型自判 | 中（同模型但显式 tool call）| 0 额外 inference | 模型可能自欺 |
| Claude evaluator-in-prompt | 低（同 LLM 同 prompt）| 0 额外 inference | 主模型自我说服 |
| Qwen subquery | **高**（独立 sub-call + fast model）| +1 fast model call/turn | fast model 误判风险 |

### 3.2 状态机对比

```
Codex (4 态)           Claude (2 态)       Qwen (4 态)
                                          
   active                  active             set
     │                       │                 │
     ├──→ paused             │                 │  ←┐ 复用 Stop hook
     │    (mode/plan 切换)   │                 │   │
     │                       │                 │   │
     ├──→ budget_limited     │                 │   │
     │    (token cap 触发)   │                 │   │
     │                       │                 │   │
     └──→ complete           ↓                 ├──→ achieved
                          cleared              │
                                               ├──→ aborted
                                               │
                                               └──→ cleared
```

**关键差异**：
- Codex **独有 `paused`**：plan-mode / approval-mode 切换时 goal 不丢，挂起待恢复
- Codex **独有 `budget_limited`**：token 烧完时显式标识（不像 Qwen 那样直接 abort）
- Qwen 缺 `paused` —— **deferred 项**，daemon 重启 / `/compact` / 临时切走时 goal 会被 cleared（Codex commit `3463324a29` "keep plan mode from pausing goals" 是参照对象）

### 3.3 持久化策略

| Agent | 存储 | 跨重启 | 跨 session resume |
|---|---|---|---|
| Codex | SQLite `thread_goals` 表 + `StateDbHandle` | ✅ | ✅ |
| Claude | session 内存 | ❌ | ❌ |
| Qwen | `activeGoalStore` 进程内存 | ❌ | ⚠️ `restoreGoal.ts` (158 LOC) 仅协助同进程内 history 重渲染（非真持久化）|

**Qwen 设计抉择**：明确**不跨进程持久化**。理由：
- `/clear` `/resume` `/branch` 主动清 goal 是 explicit 用户语义
- daemon 模式下，每个 daemon 进程绑定 1 workspace × N session，goal 跟 session 走，daemon 重启 = "fresh start"
- 避免 SQLite schema 迁移 / migration 复杂度

**代价**：daemon 重启 = goal 丢失。如果 goal 是 "重构整个 auth flow"（5 小时任务），用户中间 Ctrl+C 重启 daemon 就全凉。

### 3.4 Bootstrap 注入

**Codex** —— 模型读 continuation 模板，由 model 自己 trigger first action。

**Claude** —— 用户输入 `/goal "<text>"` 后由 user 手动发下一句话才开始 turn。

**Qwen** —— **首轮 `submit_prompt` 自动注入** `goalInstructionPrompt(q)`：
```typescript
// packages/cli/src/ui/commands/goalCommand.ts:79-216 大致逻辑
const bootstrapPrompt = goalInstructionPrompt(userGoal);
await submitPrompt(bootstrapPrompt);  // 自动发首轮，免用户手动"开始"
```

**UX 差异**：
- Codex / Claude：`/goal "重构 auth"` → 显示 "goal set" → 用户**还要手动输入** "好，开始" 才有 turn
- Qwen：`/goal "重构 auth"` → 显示 "goal set" + **立即触发 turn**

### 3.5 Token 预算与安全

**Codex** —— 完整 token budget 体系：
- `token_budget` 字段记录额度
- `budget_limit.md` 模板 prompt 让模型在接近 budget 时主动收尾
- [#23696](https://github.com/openai/codex/pull/23696) `account active goal progress` 累计追踪
- [#23717](https://github.com/openai/codex/pull/23717) `preserve failed goal accounting flushes` 失败时不丢账

**Claude** —— unknown（二进制）

**Qwen** —— **仅迭代数硬上限**：
- `MAX_GOAL_ITERATIONS=50` —— 50 轮硬停（防 runaway loop）
- `GOAL_JUDGE_TIMEOUT_MS=25s` + `AbortController` 防泄漏
- `GOAL_HOOK_TIMEOUT_SECONDS=30` 对齐 Claude `cRK` 默认
- ⚠️ **重要 safety 缺口** —— 50 轮 × 几万 token 仍可能是 $$$，无 token budget 早期警告

**Qwen 额外安全门禁**（PR#4123 加）：
- `sanitizeConditionForPrompt`（去换行 + 双引号降级单引号，防 prompt injection）
- `isTrustedFolder()` 检查
- `getHookSystem()` 必备
- `disableAllHooks` 短路
- 4000-char goal description cap

### 3.6 底层机制 —— LOC 经济性

| Agent | 新 subsystem | 新文件数 | 新 LOC | 复用现有 |
|---|---|---|---|---|
| Codex | ✅ 大量 | core/goals.rs + context/goal_context.rs + 5 tui/* + app-server/thread_goal_processor.rs + ext/goal/{lib,accounting,events,tool,spec}.rs + SQL schema | ~2,300 | 仅 turn 机制 |
| Claude | 推断少（二进制混淆）| unknown | unknown | Stop hook + main LLM context |
| Qwen | ❌ **0 新 subsystem** | `goals/{activeGoalStore,goalHook,goalJudge,restoreGoal,index}.ts` 5 文件 + `goalCommand.ts` + cli hooks 4 处适配 | 2,089 业务 + 1,061 测试 | **PR#3471/3488 Stop function-hook plumbing 100% 复用** |

**Qwen 哲学**：把 goal 当成 "一个 Stop hook 的特例" —— 既然 Stop hook plumbing 能做 "每轮都问问要不要继续"，goal judging 就是 "每轮都问问 goal 达成没"。本质同构。

---

## 四、UI 状态机对比（GoalPill 4 态）

来自 [`info-display-axis-deep-dive.md`](./info-display-axis-deep-dive.md) §0.2：

| 状态 | Codex | Claude v2.1.139+ | Qwen GoalStatusIndicator |
|---|---|---|---|
| **Active** | ✅ "🎯 goal: ..." | ✅ goal pill overlay | ✅ `◎ goal active` Footer pill |
| **Paused** | ✅ "(paused — switched to plan mode)" | ❌ | ❌（**deferred**）|
| **Budget-limited** | ✅ "(budget limit reached)" | ❌ | ❌ |
| **Achieved / Complete** | ✅ "✅ goal complete" | unknown | ✅ "✓ achieved" |
| **Cleared** | — | ✅ "goal cleared" | ✅（默认无 pill）|
| **Aborted** | — | — | ✅（Qwen 特有，达不到时 explicit）|

Qwen 的 `aborted` 是显式失败终态（如 judge 持续返 ok=false 50 轮后），与 `cleared`（用户主动清）语义区分。

---

## 五、与其他 mode / command 的协同

| 场景 | Codex | Qwen |
|---|---|---|
| `/plan` 切到 plan mode | goal **paused** 待恢复 | goal **cleared**（deferred，应改 paused）|
| `/compact` 压缩历史 | goal **preserved** (context 重建) | goal **cleared**（context 丢，goal 也丢）|
| `/resume` 加载 session | goal **从 SQLite 恢复** | goal **不恢复**（`restoreGoal.ts` 仅同进程 history 重渲染）|
| `/branch` / fork | goal **preserved per branch** | goal **clearned**（fork 是 fresh state）|
| daemon 重启 | goal **preserved**（SQLite）| goal **lost** |
| `/clear` | goal cleared | goal cleared |

**Qwen 的取向**：goal 是 ephemeral state，应该 explicit reset on context change。这是 minimalism 选择 —— 用户清楚知道什么时候 goal 还在、什么时候没了。代价是长 goal（重构 / migration）跨 daemon 重启就要重设。

---

## 六、Qwen Code 后续 follow-up（PR#4123 之后）

PR#4123 (2026-05-16 MERGED) 之后还有 4 个 follow-up PR 完善 `/goal`：

| PR | 时间 | 内容 |
|---|---|---|
| [#4208](https://github.com/QwenLM/qwen-code/pull/4208) `Add stop hook blocking cap` | 2026-05-17 | Stop hook 阻断上限 —— 防 hook 链无限触发把 stop 一直阻塞下去 |
| [#4230](https://github.com/QwenLM/qwen-code/pull/4230) `feat(core): fail impossible goals` | 2026-05-17 | judge 判定**不可达成** goal 时立即 fail（如 "make this 失败的命令成功"），不要再跑 50 轮 |
| [#4273](https://github.com/QwenLM/qwen-code/pull/4273) `feat: support active goal stream events and non-interactive /goal` | 2026-05-19 | stream JSON 输出 goal lifecycle events；`/goal` non-interactive 模式（CI / 自动化）|
| [#4314](https://github.com/QwenLM/qwen-code/pull/4314) `Expose active goal in stream JSON` | 2026-05-21 | stream JSON 顶层暴露 active goal 让外部工具读取 |

收尾后 Qwen `/goal` 已能在 CI 流水线 / 自动化脚本里用（non-interactive + stream JSON 反馈）。

---

## 七、Codex 后续演进（2026-05 主线）

Codex `/goal` 自 2026-04-25 首发后，2026-05 仍在密集迭代：

| commit | 内容 |
|---|---|
| [#23300](https://github.com/openai/codex/pull/23300) `feat: dedicated goal DB` | goal 从共享 DB 独立到专用 thread_goals DB（解耦其他 state）|
| [#23685](https://github.com/openai/codex/pull/23685) `feat: wire goal extension tools to the dedicated goal store` | goal extension tool 接专用 store |
| [#23688](https://github.com/openai/codex/pull/23688) `feat: expose turn-start metadata to extensions` | extension API 加 turn-start metadata |
| [#23696](https://github.com/openai/codex/pull/23696) `feat: account active goal progress in the goal extension` | 积分制累计 progress |
| [#23717](https://github.com/openai/codex/pull/23717) `[codex] Preserve failed goal accounting flushes` | 失败时 accounting 不丢 |
| [#23718](https://github.com/openai/codex/pull/23718) `[codex] Steer budget-limited goal extension turns` | budget 接近时 prompt steering |
| [#23732](https://github.com/openai/codex/pull/23732) `Make goals feature on by default and no longer experimental` | **goal default-on**（脱离 experimental）|
| [#23792](https://github.com/openai/codex/pull/23792) `TUI: skip goal replace prompt for completed goals` | UX 改进 |
| [#23796](https://github.com/openai/codex/pull/23796) `Improve /goal error messages for ephemeral sessions` | 错误消息友好化 |
| [#23963](https://github.com/openai/codex/pull/23963) `Expose conversation history to extension tools` | extension 能读 conversation history |
| [#24151](https://github.com/openai/codex/pull/24151) `[codex] Use TurnInput for session task input` | session task input 统一类型 |

Codex 走 "extension architecture" 路线 —— `ext/goal/` crate 作为 first-class extension，所有 goal-related 逻辑住一个 crate；其他 turn / app-server / TUI 通过 extension API 访问。这是比 Qwen "复用 Stop hook" 更**显式分层**的方案。

---

## 八、设计启示对 Qwen Code 后续工作

| 方向 | 现状 | 可借鉴 |
|---|---|---|
| **`paused` 中间态** | Qwen 缺，daemon 重启 / `/compact` 都 cleared | Codex 状态机 + commit `3463324a29` "keep plan mode from pausing goals" |
| **Token budget guard rail** | 仅 `MAX_GOAL_ITERATIONS=50`，无 token cap | Codex `token_budget` + `budget_limit.md` 模板 + accounting 三件套 |
| **跨 daemon 重启持久化** | 完全无 | Codex SQLite `thread_goals` 表（取舍：增 schema migration 复杂度）|
| **Extension architecture** | 复用 Stop hook 简洁但隐式 | Codex `ext/goal/` first-class crate 显式分层 |
| **CI / 非交互模式** | ✅ 已 ship（#4273）| - |
| **fail impossible 早停** | ✅ 已 ship（#4230）| - |

**反向看 Qwen 比 Codex 强的点**：
1. **Judge 独立性最高** —— LLM-as-judge subquery 走 fast model，主模型不污染、不自欺。Codex model-self-judge + Claude evaluator-in-prompt 都可能自我说服
2. **Bootstrap 自动注入** —— `/goal "重构 auth"` 立即触发 turn，无需用户手动"开始"。Codex / Claude 都需 user 多敲一次
3. **测试覆盖率最高** —— 1,061 LOC test / 2,089 LOC 业务 ≈ 50% 测试比例。Codex 5-PR 拆分中测试分散，Qwen 单 PR 集中
4. **零新 subsystem** —— 2,089 LOC 业务 vs Codex ~2,300 LOC 新增 + DB schema + 协议事件 + 5 TUI 文件
5. **Prompt 注入防护** —— `sanitizeConditionForPrompt` 显式去换行 + 引号转换，Codex/Claude unknown

---

## 九、源码索引

### Codex
| 文件 | 用途 |
|---|---|
| `core/src/goals.rs` | `GoalRuntimeState` + transition |
| `core/src/context/goal_context.rs` | context 注入 |
| `app-server/src/request_processors/thread_goal_processor.rs` | RPC 处理 |
| `tui/src/goal_display.rs` | 状态显示 |
| `tui/src/chatwidget/{goal_menu,goal_status,goal_validation}.rs` | TUI 交互 |
| `tui/src/app/thread_goal_actions.rs` | 用户 action |
| `ext/goal/src/{lib,accounting,events,tool,spec}.rs` | extension crate |
| `ext/goal/tests/{goal_extension_backend,accounting}.rs` | tests |
| SQLite schema | `thread_goals` 表 |

### Claude Code
| 标识 | 用途 |
|---|---|
| 二进制函数 `cRK` | Stop prompt-hook evaluator（Qwen `goalJudge.ts:23` 注释明确对标）|
| 触发方式 | 推断 `local-jsx` + post-text 注入 |

### Qwen Code
| 文件 | 用途 |
|---|---|
| `packages/core/src/goals/activeGoalStore.ts` | 进程内 store |
| `packages/core/src/goals/goalHook.ts:34-91` | 迭代/超时常量 |
| `packages/core/src/goals/goalJudge.ts:23-54` | JSON schema judge + Claude `cRK` 对齐注释 |
| `packages/core/src/goals/goalLoop.integration.test.ts` | 端到端测试 209 LOC |
| `packages/core/src/goals/restoreGoal.ts` | session resume 协同 158 LOC |
| `packages/cli/src/ui/commands/goalCommand.ts:79-216` | 命令分支 + bootstrap |

---

## 十、相关报告

- [`info-display-axis-deep-dive.md`](./info-display-axis-deep-dive.md) §0.2 — GoalPill UI 4 态对比
- [`qwen-code-improvement-report.md`](./qwen-code-improvement-report.md) "2026-05-16 增量" — 时间线 / 历史演进
- [`claude-code-agents-command-deep-dive.md`](./claude-code-agents-command-deep-dive.md) — Claude `/agents` 命令对比（顺带提及 `/goal` 用 LLM-as-judge 思路类似）
- [`qwen-code-codex-improvements.md`](./qwen-code-codex-improvements.md) — Codex 对标改进项
- [`review-command.md`](./review-command.md) + [`qwen-code-review-improvements.md`](./qwen-code-review-improvements.md) — `/review` 对比的同款双层结构参考

---

*分析基于 Codex CLI (openai/codex main, 909K 行 Rust) + Qwen Code (PR#4123 + #4208/4230/4273/4314 follow-up, 631K 行 TS) + Claude Code v2.1.139+ 二进制分析。最后核对：2026-05-24。Claude `/goal` 二进制混淆，相关声明基于 Qwen `goalJudge.ts:23` 注释 "aligned with Claude Code 2.1.140's Stop prompt-hook evaluator (function cRK in the compiled binary)" 的对标关系推断。*
