# 09 - Multi-Agent 系统

## 1. Agent Runtime 架构

Qwen Code 的多智能体系统构建在三层 Agent Runtime 之上：

### AgentCore - 共享执行引擎

`AgentCore` 是所有 agent 的底层执行引擎，负责推理循环、工具调度、统计收集和事件发射。每次调用无状态。

核心方法：

- `runReasoningLoop(options)` — 主推理循环，交替执行模型推理与工具调用
- `processFunctionCalls(parts)` — 并行调度工具执行
- `prepareTools(config)` — 根据 ToolConfig 组装可用工具声明
- `createChat(systemPrompt, history)` — 创建 GeminiChat 实例

关键常量 `EXCLUDED_TOOLS_FOR_SUBAGENTS` 定义了子 agent 不可使用的工具集合：

```typescript
const EXCLUDED_TOOLS_FOR_SUBAGENTS = new Set([
  AGENT, CRON_CREATE, CRON_LIST, CRON_DELETE,
  TASK_STOP, SEND_MESSAGE, ENTER_WORKTREE, EXIT_WORKTREE,
]);
```

推理循环的返回结果：

```typescript
interface ReasoningLoopResult {
  text: string;
  terminateMode: AgentTerminateMode;
  turnsUsed: number;
}
```

终止模式枚举 `AgentTerminateMode`：

| 值 | 含义 |
|---|---|
| ERROR | 运行时错误 |
| TIMEOUT | 超时 |
| GOAL | 正常完成 |
| MAX_TURNS | 达到最大轮次 |
| CANCELLED | 用户取消 |
| SHUTDOWN | 系统关闭 |

### AgentHeadless - 一次性任务执行器

`AgentHeadless` 封装 AgentCore 用于一次性任务执行，生命周期为 Born → execute() → die。

```typescript
class AgentHeadless {
  execute(context: ContextState, externalSignal?: AbortSignal): Promise<ReasoningLoopResult>;
}
```

`ContextState` 提供模板变量替换，支持 `${variable}` 语法在 systemPrompt 中引用运行时上下文（如 `${cwd}`、`${date}`）。

### AgentInteractive - 持久交互 Agent

`AgentInteractive` 维护持久会话，通过 `AsyncMessageQueue` 处理用户消息流。

状态机：`INITIALIZING → RUNNING → IDLE ⇄ RUNNING → COMPLETED/FAILED/CANCELLED`

三级取消机制：

1. `cancelCurrentRound()` — 取消当前推理轮次，保持 agent 存活
2. `shutdown()` — 优雅关闭，等待当前工具执行完成
3. `abort()` — 立即终止所有执行

### 运行时配置接口

```typescript
interface PromptConfig {
  systemPrompt?: string;
  renderedSystemPrompt?: string;
  initialMessages?: Content[];
}

interface ModelConfig { model?: string; }

interface RunConfig {
  max_time_minutes?: number;
  max_turns?: number;
}

interface ToolConfig {
  tools: Array<string | FunctionDeclaration>;
  disallowedTools?: string[];
}
```

---

## 2. 执行后端 (Backend)

### Backend 接口

```typescript
interface Backend {
  init(): Promise<void>;
  spawnAgent(config: AgentSpawnConfig): Promise<string>;
  stopAgent(agentId: string): Promise<void>;
  stopAll(): Promise<void>;
  cleanup(): Promise<void>;
  switchTo(agentId: string): Promise<void>;
  getActiveSnapshot(): AgentSnapshot | null;
  forwardInput(data: string): void;
  resizeAll(cols: number, rows: number): void;
  getAttachHint(agentId: string): string | null;
}
```

支持的 `DisplayMode`：`'in-process' | 'tmux' | 'iterm2'`

### 当前状态

目前仅 `InProcessBackend` 处于激活状态。Tmux 和 iTerm2 后端已实现但被禁用。

`InProcessBackend` 在当前进程内创建 `AgentCore` + `AgentInteractive` 实例，而非启动 PTY 子进程。每个 agent 拥有独立的 `ContentGenerator` 和 `ToolRegistry`。

检测优先级（文档化但未全部激活）：

1. 用户显式指定 → 使用指定后端
2. 当前在 tmux 内 → 使用 Tmux 后端
3. tmux 可用 → 使用 Tmux 后端
4. Fallback → InProcess 后端

---

## 3. SubAgent 子智能体系统

### SubagentManager

`SubagentManager` 提供子 agent 配置的 CRUD 操作，支持多级解析和缓存管理。

配置存储格式为 Markdown + YAML frontmatter，存储路径：

- Project 级别：`.qwen/agents/` 目录
- User 级别：`~/.qwen/agents/` 目录
- Extension/Builtin：代码内嵌

解析优先级（高到低）：`session > project > user > extension > builtin`

核心 `SubagentConfig` 接口：

```typescript
interface SubagentConfig {
  name: string;
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  approvalMode?: string;  // 'default' | 'plan' | 'auto-edit' | 'yolo'
  systemPrompt: string;
  level: SubagentLevel;   // 'session' | 'project' | 'user' | 'extension' | 'builtin'
  filePath?: string;
  model?: string;         // 'inherit' | 'fast' | 'model-id' | 'authType:model-id'
  runConfig?: Partial<RunConfig>;
  color?: string;
  background?: boolean;
  isBuiltin?: boolean;
}
```

关键方法：

- `createAgentHeadless(config, runtimeContext, options?)` — 将 SubagentConfig 转换为运行时 agent
- `buildRuntimeContentGeneratorView` — 为不同 provider 创建独立的 ContentGenerator
- `buildSubagentContextOverride` — 创建拥有独立 FileReadCache 和 ToolRegistry 的隔离 Config

### 内置 Agent (BuiltinAgentRegistry)

| 名称 | 模型 | 用途 | 工具集 |
|------|------|------|--------|
| `general-purpose` | inherit | 通用研究/搜索/多步任务 | 全部工具 |
| `Explore` | fast | 只读代码库探索 | ReadFile, Grep, Glob, Shell, Ls, WebFetch, TodoWrite, Memory, Skill, LSP, AskUserQuestion |
| `statusline-setup` | inherit | 配置状态栏 | ReadFile, WriteFile, Edit, AskUserQuestion |

`DEFAULT_BUILTIN_SUBAGENT_TYPE = 'general-purpose'` 是默认子 agent 类型。

### 模型选择策略

`model` 字段支持四种模式：

1. 省略或 `'inherit'` — 使用主对话模型
2. `'fast'` — 使用配置的快速模型（支持 authType 限定）
3. `'model-id'` — 使用指定模型 + 主对话 authType
4. `'authType:model-id'` — 使用指定 authType 和模型

---

## 4. Fork 子 Agent

Fork 是一种特殊的子 agent 类型，继承父对话的完整上下文，不可通过 `subagent_type` 显式选择。

### 递归 Fork 防护

使用 `AsyncLocalStorage` 实现递归 fork 检测：

```typescript
const forkExecutionStorage = new AsyncLocalStorage<{ readonly marker: true }>();

function runInForkContext<T>(fn: () => Promise<T>): Promise<T> {
  return forkExecutionStorage.run({ marker: true }, fn);
}

function isInForkExecution(): boolean {
  return forkExecutionStorage.getStore() !== undefined;
}
```

选择 AsyncLocalStorage 而非历史扫描的原因：嵌套 AgentTool 的 `this.config` 指向主进程 Config，`getGeminiClient().getHistory()` 返回父对话而非 fork 子对话的 chat。异步上下文传播自然地跨越 fork 的 await 链。

### 历史构建

`buildForkedMessages(directive, assistantMessage)` 构建 fork 子 agent 的上下文历史：

- 若最后一条模型消息无 function call → 返回空数组，由 agent-headless 通过 `task_prompt` 传递指令
- 若有 function call → 构建 functionResponse 占位符 + 指令的 user 消息，确保 user/model 消息交替

### Worktree 隔离

`buildWorktreeNotice(parentCwd, worktreeCwd)` 为运行在 git worktree 中的 fork agent 注入隔离通知，要求其将所有文件操作限制在 worktree 路径下。

---

## 5. Arena 模式

Arena 是多模型竞争执行机制，让多个 agent 使用不同模型同时处理同一任务，用户从结果中选择最优方案。

### ArenaManager 架构

```typescript
// 核心流程
start(options) → validateOptions → initializeBackend
  → setupWorktrees → runAgents → collectResults
```

关键约束：`ARENA_MAX_AGENTS = 5`，要求在 git 仓库中运行。

每个参赛 agent 通过 `GitWorktreeService` 获得独立的 git worktree 环境，确保并发修改互不干扰。

### ArenaAgentClient - 子进程 IPC

子 agent 进程通过环境变量自激活：

- `ARENA_AGENT_ID` — agent 标识
- `ARENA_SESSION_ID` — 会话标识
- `ARENA_SESSION_DIR` — 会话目录（文件 IPC 根路径）

通信方法：

- `updateStatus()` — 向 manager 报告状态
- `checkControlSignal()` — 轮询控制信号（shutdown/cancel）
- `reportCompleted()` — 报告完成 + 统计数据
- `reportError()` / `reportCancelled()` — 报告异常

### 结果选择机制

Arena 不自动投票。完成后，`ArenaManager` 收集所有 agent 的结果：

```typescript
interface ArenaAgentResult {
  agentId: string;
  model: ArenaModelConfig;
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  worktree: { path: string; branch: string };
  finalText?: string;
  diff?: string;
  diffSummary?: string;
  approachSummary?: string;  // AI 生成的方案摘要
  stats: { turnsUsed, tokensUsed, durationMs };
}
```

`generateAgentApproachSummary` 使用 `runSideQuery` 调用 AI 模型为每个 agent 的 diff 生成方案摘要，帮助用户理解各方案的策略差异。

用户选择获胜方案后，`applyAgentResult(agentId)` 将对应 worktree 的变更应用到主工作目录。

### 会话状态

`ArenaSessionStatus`：`INITIALIZING | RUNNING | IDLE | COMPLETED | CANCELLED | FAILED`

---

## 6. 后台任务 (Background Tasks)

### BackgroundTaskRegistry

跟踪所有后台 agent 的生命周期：

```typescript
interface AgentTask {
  kind: 'agent';
  agentId: string;
  subagentType?: string;
  isBackgrounded: boolean;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  result?: string;
  error?: string;
  stats?: AgentStats;
  prompt?: string;
  recentActivities?: string[];
  metaPath?: string;
  pendingMessages?: MessageQueueEntry[];
}
```

消息队列机制：

- `queueMessage(agentId, message)` — 向后台 agent 发送消息
- `drainMessages(agentId)` — 消费所有待处理消息
- `waitForMessages(agentId, signal)` — 等待新消息到达

完成通知通过 XML `<task-notification>` 信封传递给主 agent。保留上限 `MAX_RETAINED_TERMINAL_AGENTS = 32`。取消操作有 5000ms 宽限期。

### BackgroundAgentResumeService - 持久化与恢复

后台 agent 通过 JSONL transcript 文件持久化其执行历史，支持会话重启后恢复。

核心方法：

- `loadPausedBackgroundAgents(sessionId)` — 扫描 meta 文件，重建状态
- `resumeBackgroundAgent(agentId, initialMessage?)` — 从 transcript 恢复执行
- `recoverTranscript(records)` — 从 JSONL 记录重建对话历史

恢复策略区分 fork 和 named subagent：

- Fork agent：重建完整父对话上下文 + fork 指令
- Named subagent：仅恢复该 agent 自身的对话历史

安全约束：非受信目录下恢复时，permissive 的 approvalMode（如 `yolo`）会被降级。

---

## 7. Agent 间通信

### 外部消息队列

`AgentHeadless` 通过 `ReasoningLoopOptions` 的三个回调实现外部消息接收：

- `getExternalMessages()` — 非阻塞获取待处理消息
- `waitForExternalMessages()` — 阻塞等待消息到达
- `shouldWaitForExternalMessages()` — 判断当前是否应进入等待

### SendMessage 工具

主 agent 可通过 `SendMessage` 工具向后台 agent 发送消息，消息进入目标 agent 的 `pendingMessages` 队列，在下一次推理循环迭代时被消费。

### Monitor 通知

后台任务完成时，`BackgroundTaskRegistry` 生成 XML 格式的通知：

```xml
<task-notification task_id="xxx" status="completed">
  Result summary here
</task-notification>
```

通知被注入主 agent 的消息流，确保主 agent 感知后台任务状态变化。

### Arena 文件 IPC

Arena 模式下，agent 与 manager 通过文件系统通信：

- Agent → Manager：状态文件写入 `ARENA_SESSION_DIR`
- Manager → Agent：控制信号文件（`ArenaControlSignal`）

```typescript
interface ArenaControlSignal {
  type: 'shutdown' | 'cancel';
  reason: string;
  timestamp: number;
}
```

---

## 8. 执行隔离

### 工具隔离

每个子 agent 通过 `buildSubagentContextOverride` 获得独立的：

- `FileReadCache` — 独立文件读取缓存
- `ToolRegistry` — 独立工具注册表
- `ContentGenerator` — 独立内容生成器（支持不同 provider）

`EXCLUDED_TOOLS_FOR_SUBAGENTS` 集合阻止子 agent 使用 Agent 工具（防止无限嵌套）、Cron 工具、Worktree 工具等。

### Git Worktree 隔离

Arena 模式和带 `isolation: 'worktree'` 选项的 fork agent 使用 git worktree 实现文件系统级隔离。每个 agent 在独立分支的工作副本中操作，变更互不干扰。

### AsyncLocalStorage 上下文隔离

- `subagentNameContext` — 标记当前执行属于哪个子 agent
- `RuntimeContentGenerator` — 每个 agent 的 ALS frame 绑定独立的内容生成器
- `forkExecutionStorage` — 标记当前在 fork 执行帧内（阻止递归 fork）

---

## 9. 与 Claude Code 对比

| 维度 | Qwen Code | Claude Code |
|------|-----------|-------------|
| 执行引擎 | AgentCore（Gemini API） | 内置推理循环（Anthropic API） |
| 子 agent 配置 | Markdown + YAML frontmatter | Markdown agents 文件 |
| 存储层级 | 5 级 (session/project/user/extension/builtin) | 3 级 (project/user/builtin) |
| Fork 机制 | AsyncLocalStorage 防递归 + 完整上下文继承 | 类似的 fork 模式 |
| Arena 竞争 | git worktree 隔离 + 文件 IPC + AI 方案摘要 | 无对应功能 |
| 后台任务 | JSONL 持久化 + 会话恢复 | 类似的后台 agent |
| 执行后端 | InProcess/Tmux/iTerm2（仅 InProcess 激活） | InProcess + Tmux |
| 模型选择 | inherit/fast/model-id/authType:model-id | 固定模型 |
| 工具过滤 | allowlist + disallowedTools + MCP server 级模式 | allowlist |
| 消息通信 | 外部消息队列 + SendMessage + Monitor 通知 | 类似队列机制 |

Qwen Code 的 Arena 模式是独有特性，允许用户同时比较多个模型的实现方案。而 Claude Code 的 Tmux 后端实际处于活跃使用状态，Qwen Code 目前仅 InProcess 后端激活。两者在 fork 子 agent 的设计上高度相似（上下文继承 + 递归防护），但 Qwen Code 额外支持 Extension 级别的 agent 注入。
