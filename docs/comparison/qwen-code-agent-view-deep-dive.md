# Qwen Code `agent-view` 多 tab UI Deep-Dive

> **核心问题**：Qwen Code 的 `agent-view/` 是什么？为什么 Claude Code 和 Codex 都没有等价形态？它和 Qwen 自家的 `/agents` CRUD UI 是什么关系？
>
> 返回 [Qwen Code 改进建议总览](./qwen-code-improvement-report.md)
>
> **本质澄清**：`agent-view/` **不是** "subagent 定义管理"（那是 `packages/cli/src/ui/components/subagents/` 的 `/agents manage` / `/agents create` 范畴，类似 [Claude Code `/agents`](./claude-code-agents-command-deep-dive.md)），而是一个 **运行时多 tab 交互式 chat UI**——多个 in-process subagent 各自一个对话 tab，方向键切换、独立 composer 输入。Claude Code 和 Codex 都没有等价形态。

## 零、TL;DR

Qwen Code `packages/cli/src/ui/components/agent-view/` 是一个 **~950 LOC 的多 tab subagent chat UI**，用 Ink TUI 渲染让用户在同一终端窗口里：

| 能力 | 实现 |
|---|---|
| **多 agent 并行** | `AgentViewContext` 维护 `Map<agentId, RegisteredAgent>`，每个 agent 有独立 `AgentInteractive` 实例 + 独立 `agentCore`（独立 conversation history） |
| **顶部 tab 切换** | `AgentTabBar.tsx` 187 LOC，5 态状态指示器，方向键导航 |
| **每 tab 独立 chat** | `AgentChatContent.tsx` 274 LOC + `AgentComposer.tsx` 308 LOC——agent tab 有自己的 history 渲染 + 输入框 |
| **Arena 桥接** | `useArenaInProcess` hook 把 `ArenaManager` 的 spawn/cancel 事件桥接到 `registerAgent` / `unregisterAgent` |

**关键独特性**：Claude `LiveAgentPanel` 只显示状态、用户**不能切到 subagent 对话里**给指令；Codex `/side` 是 thread-fork（SQL-backed thread 切换）但**没有 tabbed 多对话同屏**。Qwen 是唯一支持"**多 subagent 同时跑、可任意切入任一对话直接对话**"的形态。

**代价**：每个 tab 持有完整 `agentCore` + history，**多 tab × 长 session = OOM 放大器**——直接关联 [PR#4188](https://github.com/QwenLM/qwen-code/pull/4188) / [Issue #4185](https://github.com/QwenLM/qwen-code/issues/4185) 的 long-session OOM 风险（详见 §七）。

## 一、不是什么 vs 是什么

### 容易混淆的 3 个相邻概念

| 概念 | 含义 | Qwen Code 实现 | 本文范围 |
|---|---|---|---|
| **`/agents` 命令** | Subagent 定义 CRUD | `packages/cli/src/ui/components/subagents/` (~3007 LOC) | ❌ 类比 [Claude `/agents`](./claude-code-agents-command-deep-dive.md) |
| **`agent-view/` 多 tab UI** | 运行时 subagent 交互式 chat | `packages/cli/src/ui/components/agent-view/` (~950 LOC) | ✅ 本文 |
| **`arena` 工具组** | spawn / cancel subagent 的核心层 | `packages/core/src/agents/arena/` | ❌ 详 [SubAgent 展示 Deep-Dive](./subagent-display-deep-dive.md) |

`agent-view/` 是 `arena` 的**唯一 UI 消费者**，但通过 `useArenaInProcess` 桥接层解耦——arena 不感知 UI。

### 触发方式

| 触发 | 用户操作 |
|---|---|
| Slash command | 不直接触发——`agent-view/` 是被动渲染的 |
| 实际触发 | `arena` 工具组（agent spawn 时）→ `ArenaManager` 发 spawn 事件 → `useArenaInProcess` 调 `registerAgent` → `AgentTabBar` 出现新 tab |
| 用户感知 | "我让主 agent spawn 一个 subagent 干活，**顶部出现一个 tab**，我可以方向键切过去**直接跟它对话**" |
| 是否 wire 化 | ❌ **in-process only**——多 agent 都在同一 Node 进程内的不同 `agentCore` 中，daemon Mode B 远端 client 看不到这些 tab |

## 二、源码结构（~950 LOC，6 + 1 文件）

```
packages/cli/src/ui/components/agent-view/
├─ AgentTabBar.tsx       187 LOC   ★ 顶部水平 tab 条 + 焦点模型 + 状态指示
├─ AgentChatView.tsx      39 LOC   单 tab 容器（包装 AgentChatContent）
├─ AgentChatContent.tsx  274 LOC   ★ 每 tab 的 chat 历史渲染主体
├─ AgentComposer.tsx     308 LOC   ★ 每 tab 独立 composer（输入框）
├─ AgentHeader.tsx        64 LOC   tab 顶部元信息（agent name / model / status）
├─ AgentFooter.tsx        66 LOC   tab 底部状态条
└─ index.ts               12 LOC   export 聚合

# 配套层（不在 agent-view/ 目录但是核心依赖）
packages/cli/src/ui/contexts/AgentViewContext.tsx    309 LOC   ★ React Context + 注册表
packages/cli/src/ui/hooks/useArenaInProcess.ts       177 LOC   ★ arena 事件 → context 桥接
packages/cli/src/ui/hooks/useAgentStreamingState.ts  165 LOC   流式状态聚合（composer/footer 共用）
```

**总计 ~950 LOC（agent-view/）+ ~650 LOC 配套 = ~1600 LOC 完整 feature**。星标项是核心组件。

## 三、AgentViewContext — 状态模型（核心）

`packages/cli/src/ui/contexts/AgentViewContext.tsx:34-56`：

```typescript
export interface RegisteredAgent {
  interactiveAgent: AgentInteractive;     // 独立 agent 运行时实例
  modelId: string;                         // "glm-5" 等
  modelName?: string;                      // "GLM 5" 人友显示
  color: string;                           // tab 区分色
}

export interface AgentViewState {
  activeView: string;                      // 'main' 或 agentId
  agents: ReadonlyMap<string, RegisteredAgent>;
  agentShellFocused: boolean;              // embedded shell 是否抢焦点
  agentInputBufferText: string;            // 当前 active tab 的输入缓冲
  agentTabBarFocused: boolean;             // tab bar 是否有键盘焦点（独立于 input）
  agentApprovalModes: ReadonlyMap<string, ApprovalMode>;  // 每 agent 独立 approval mode
}
```

### 11 个 actions

```typescript
export interface AgentViewActions {
  switchToMain(): void;
  switchToAgent(agentId: string): void;
  switchToNext(): void;                    // 循环：'main' → agent1 → agent2 → 'main'
  switchToPrevious(): void;
  registerAgent(agentId, interactiveAgent, modelId, color, modelName?): void;
  unregisterAgent(agentId: string): void;
  unregisterAll(): void;                   // session 退出 / clear 时
  setAgentShellFocused(focused: boolean): void;
  setAgentInputBufferText(text: string): void;
  setAgentTabBarFocused(focused: boolean): void;
  setAgentApprovalMode(agentId: string, mode: ApprovalMode): void;
}
```

### 关键设计点

1. **`'main'` 是隐式 tab**——`switchToNext()` 的 id 序列是 `['main', ...agents.keys()]`，主对话也是一个 tab。
2. **`agentApprovalModes` per-tab**——每个 subagent 可以独立 approval mode（一个 yolo / 一个 ask）。`setAgentApprovalMode` 同步写回 `interactiveAgent.getCore().runtimeContext.setApprovalMode(mode)`，确保工具调度看到正确的 mode。
3. **`unregisterAgent` 自动切回 main**：`setActiveView((current) => (current === agentId ? 'main' : current))`——当前看的 agent tab 被卸载时，焦点回主。

## 四、AgentTabBar 焦点模型（最不直观的部分）

`AgentTabBar.tsx` 头部注释直接说明了三态焦点机制：

> On the main tab, Left/Right switch tabs when the input buffer is empty.
> On agent tabs, the tab bar uses an exclusive-focus model:
>   - Down arrow at the input's bottom edge focuses the tab bar
>   - Left/Right switch tabs only when the tab bar is focused
>   - Up arrow or typing returns focus to the input

### 状态转移

```
         ┌─────────────────┐
         │  main tab       │
         │  (input focus)  │
         │   ←/→ switch    │   <-- 仅当 input buffer 为空
         └────────┬────────┘
                  │ ↓ (down at input bottom)
                  ↓
         ┌─────────────────┐
         │  agent tab      │ <----→ ┌──────────────┐
         │  (input focus)  │        │  tab bar     │
         │   ↑ typing →    │ ←──────│  focused     │
         │   input focus   │        │  ←/→ switch  │
         └─────────────────┘        │  ↑ input     │
                                    │  ↓ bg pill   │
                                    └──────────────┘
```

### 实现核心（`AgentTabBar.tsx:77-109`）

```typescript
useKeypress(
  (key) => {
    if (embeddedShellFocused || agentShellFocused) return;
    if (!agentTabBarFocused) return;

    if (key.name === 'left')        switchToPrevious();
    else if (key.name === 'right')  switchToNext();
    else if (key.name === 'up')     setAgentTabBarFocused(false);
    else if (key.name === 'down') {
      // 切到 main 才能 focus 底部 bg pill（pill 只在 main 渲染）
      if (hasBgAgents) {
        setAgentTabBarFocused(false);
        switchToMain();
        setBgPillFocused(true);
      }
    }
    else if (key.sequence?.length === 1 && !key.ctrl && !key.meta) {
      // 任何可打印字符 → 焦点回 input（按键透传给 BaseTextInput）
      setAgentTabBarFocused(false);
    }
  },
  { isActive: true },
);
```

**最巧妙的点**：可打印字符自动 fall-through——用户按 `a` 想打字，焦点先到 tab bar 时不抢字符，而是把焦点交回去再让 `BaseTextInput` 接收。这避免了"按 a 没反应需要先按 ↑"的尴尬。

## 五、Agent 状态指示（5 态）

`AgentTabBar.tsx:39-58`：

| `AgentStatus` enum | 符号 | 颜色 | 含义 |
|---|---|---|---|
| `RUNNING` / `INITIALIZING` | `●` | warning（黄）| 正在干活 |
| `IDLE` | `●` | success（绿）| 等待用户输入 |
| `COMPLETED` | `✓` | success（绿）| 任务完成 |
| `FAILED` | `✗` | error（红）| 失败 |
| `CANCELLED` | `○` | text.secondary（灰）| 用户取消 |

### 状态变更如何 re-render（容易踩的坑）

```typescript
// AgentTabBar.tsx:111-129
const [, setTick] = useState(0);
const forceRender = useCallback(() => setTick((t) => t + 1), []);

useEffect(() => {
  const cleanups: Array<() => void> = [];
  for (const [, agent] of agents) {
    const emitter = agent.interactiveAgent.getEventEmitter();
    if (emitter) {
      emitter.on(AgentEventType.STATUS_CHANGE, forceRender);
      cleanups.push(() => emitter.off(AgentEventType.STATUS_CHANGE, forceRender));
    }
  }
  return () => cleanups.forEach((fn) => fn());
}, [agents, forceRender]);
```

**为什么需要 forceRender**：`statusIndicator(agent)` 读的是 `agent.interactiveAgent.getStatus()`——这是个 imperative API，不是 React state。状态变化时 React 不知道要重渲染。所以订阅 `STATUS_CHANGE` event 后手动 tick 强制重渲染。

## 六、Arena 桥接 — useArenaInProcess

`AgentViewContext.tsx:299` 调用 `useArenaInProcess(config, actions)`，把 `ArenaManager` 的事件流转换成 `registerAgent` / `unregisterAgent`。

```typescript
// AgentViewContext.tsx:294-299
// ── Arena in-process bridge ──
// Bridge arena manager events to agent registration. The hook is kept
// in its own file for separation of concerns; it's called here so the
// provider is the single owner of agent tab lifecycle.
useArenaInProcess(config ?? null, actions);
```

**职责切分**：
- `arena/` 层（`packages/core/src/agents/arena/ArenaManager.ts`）：管 spawn 子进程 / 文件 worktree / 事件总线——**不知道 UI**
- `useArenaInProcess.ts`：订阅 arena 事件 → 调 context actions——**桥接层**
- `AgentViewContext` + `AgentTabBar` + `AgentChatView`：**纯 UI**

这种分层的结果是：未来 daemon Mode B 想做远端 multi-tab 时，把桥接层换成 wire-events 订阅即可，arena 层和 UI 层都不用动。

## 七、内存代价 + OOM 风险（必读）

**每个 agent tab 持有的状态**：
1. 独立 `AgentInteractive` 实例
2. 独立 `agentCore`（含完整 conversation history）
3. 独立 streaming state（`useAgentStreamingState.ts` 165 LOC）
4. 独立 composer state（`AgentComposer.tsx` 308 LOC）
5. 独立 approval mode

**单 tab 内存量级**（粗估）：和主 session 相当——长 session 单 tab 4GB heap 上限差不多。

### 多 tab × 长 session = OOM 放大器

| 场景 | 主 session heap | 每 agent tab heap | 4GB heap limit 撑得住吗 |
|---|---|---|---|
| 主 + 1 agent (空闲) | 500MB | 100MB | ✅ |
| 主 + 1 agent (长任务 1h) | 2GB | 2GB | ⚠️ 接近 |
| 主 + 2 agents (长任务) | 2GB | 4GB | ❌ OOM |
| 主 + 3+ agents (长任务) | — | — | ❌ 直接崩 |

### 跟其他 OOM 相关 PR 的关系

| PR / Issue | 焦点 | agent-view 相关度 |
|---|---|---|
| [Issue #4185](https://github.com/QwenLM/qwen-code/issues/4185) | V8 heap pressure compaction | 高——多 tab 加剧 |
| [PR#4127](https://github.com/QwenLM/qwen-code/pull/4127) | `heapUsed > 2GB` 强制 compact 主 session | 间接——只补主 session |
| [PR#4186](https://github.com/QwenLM/qwen-code/pull/4186) | ratio-based `heapUsed / heap_size_limit >= 70%` 自动 compact | 间接——主 session 阈值 |
| [PR#4188](https://github.com/QwenLM/qwen-code/pull/4188) | `crawlCache` / `fileReadCache` size cap | 几乎无关——不是 agent-view 的内存大户 |

**未解决的 gap**：现有 OOM 修复**都只针对主 session 的 chat compaction**，没有任何 PR 针对"agent-view 的多 tab × 长 session"做 per-tab compaction 或 idle tab eviction。**这是一个值得专门治理的方向**——可能需要：
- 每 tab 也用 heap-pressure based compaction
- IDLE 状态超过 N 分钟的 tab 自动 dehydrate（卸载 history 到磁盘）
- `agent-view` 集成 `/doctor memory` 显示 per-tab heap 占用

## 八、与 Claude / Codex 同维度对比

| 维度 | Qwen `agent-view/` | Claude Code | Codex |
|---|---|---|---|
| 形态 | **顶部 tab 条 + 每 tab 独立 chat** | `LiveAgentPanel`（dialog overlay，只读状态）| `/side` thread fork + `/agent` picker |
| 进程模型 | **in-process 多 agentCore** | in-process（subagent 也在主进程）| **SQL-backed thread**（多 thread 在同 process 但 state 持久化）|
| 用户能否切到 subagent 对话 | ✅ 直接 chat | ❌ 只看状态 | ✅ 切 thread |
| 多 tab 同屏 | ✅ AgentTabBar | ❌ | ❌（thread 切换是串行）|
| 每 tab 独立 approval mode | ✅ | ❌ | ❌ |
| 每 tab 独立 composer | ✅ 308 LOC `AgentComposer` | — | — |
| 状态指示 | 5 态 + 颜色符号 | running / done / failed | 10+ Collab 协议事件 |
| 协议化 / 远端 client | ❌ in-process only | ❌ local-jsx | ✅ Collab 协议天然多 client |
| 整体 LOC | ~950 (+ ~650 配套) | — (不在 `/agents` 范围)| `multi_agents.rs` 806 + `app/side.rs` 620 |

**三家形态总结**：
- **Claude**: "subagent 是黑盒，主 agent 协调，结果回流" —— 用户不直接接触 subagent
- **Codex**: "subagent 是 thread，可 fork 可切，但单时间点看一个" —— 串行多 thread
- **Qwen**: "subagent 是 tab，可同屏可独立对话" —— 并行多 chat

Qwen 的形态对用户友好度最高，但**单进程多上下文的内存代价也是三家最重**。

## 九、关键 PR 时间线

```
5d07c495f  feat(cli): Add agent tab navigation and live tool output for in-process arena mode
             ↑ 多 tab 导航雏形 + arena live tool output
89f875123  feat(cli): add agent composer UI and refactor text input handling
             ↑ 独立 composer（每 tab 自己的输入框）
9f7e3e054  feat(arena): forward chat history to spawned agents
             ↑ 子 agent 继承父 chat history
cecc96025  feat(arena): improve agent UI with header info and simplify worktree branches
             ↑ AgentHeader / 简化 worktree 分支
4ee94715d  feat(arena): improve cancellation handling and simplify to in-process mode
             ↑ in-process only 收敛（之前可能支持子进程模式）
12293033b  refactor(agents): remove outputFile from tool result events
             ↑ 移除 outputFile（统一走 event）
03c88b730  feat(cli): background-agent UI — pill, combined dialog, detail view (#3488)
             ↑ background-agent pill / combined dialog（与 agent-view 并存的另一形态）
```

**整体演化路径**：先有 arena 工具组（spawn subagent 能力）→ 加 tab 导航 → 加独立 composer → 收敛到 in-process only → 与 background-agent UI 并存。说明 Qwen 团队**主动选择了 in-process 多 tab 路线**（不是子进程方案），意识层面承担了内存代价但换来 UI 一致性 + 实现简单。

## 十、相关文档

- [Claude Code `/agents` 命令 Deep-Dive](./claude-code-agents-command-deep-dive.md) —— **定义管理 UI**对照（本文是**运行时多 tab UI**）
- [SubAgent 展示 Deep-Dive](./subagent-display-deep-dive.md) —— `arena` 工具组底层 spawn / cancel 机制
- [Qwen Code 改进建议总览](./qwen-code-improvement-report.md) —— OOM PR#4127 / #4186 / #4188 联动讨论
- [Qwen Code Daemon 架构设计](./qwen-code-daemon-design/04-deployment-and-client.md) —— Mode B 远端 client 是否需要 agent-view 等价 wire 化（TBD）

## 十一、可能的后续工作

| 优先级 | 工作项 | 工作量 | 关键收益 |
|:------:|---|---|---|
| **P0** | per-tab heap-pressure compaction（参 [PR#4186](https://github.com/QwenLM/qwen-code/pull/4186)）| ~2-3d | 多 tab × 长 session OOM 治理 |
| **P0** | IDLE tab dehydration（N 分钟无活动卸 history 到磁盘）| ~3-5d | 长开 tab 占用预算 |
| **P1** | `/doctor memory` 集成 per-tab heap 占用 | ~1-2d | 用户可视化诊断 |
| **P1** | tab 数量上限（避免用户开 10 个 agent tab）| ~0.5d | hard guard rail |
| **P2** | daemon Mode B wire 化 agent-view（远端 client 可见多 tab）| ~5d | 远端等价 Mode A |
| **P2** | agent-view 接 OTel session tracing（参 [PR#4071](https://github.com/QwenLM/qwen-code/pull/4071)）| ~1d | 多 agent 调用链可观测 |

---

> **数据来源**：Qwen Code 2026-05-16 main branch（merge commit `0dde1ad70` 时点）。所有 LOC 数字基于 `wc -l` 实测。
