# 工具并行执行 Deep-Dive

> 当模型一次返回多个工具调用时，Agent 如何执行它们？串行逐个执行还是智能并行？本文基于 Claude Code（v2.1.89 反编译）和 Qwen Code（v0.16.0 开源）的源码分析，对比两者在工具执行并发模型、依赖分析和流式处理方面的架构差异。

---

## 1. 问题定义

现代 LLM 可在一次响应中返回多个 `tool_use` block。例如模型可能同时请求：

```
tool_use: Read("src/main.ts")
tool_use: Read("src/config.ts")  
tool_use: Grep("TODO", "src/")
tool_use: Bash("npm test")
```

前三个是只读操作，可安全并行；第四个可能依赖前三个结果。Agent 如何处理这种混合场景？

---

## 2. Claude Code：智能分批 + 流式执行

### 2.1 并发配置

```typescript
// 源码: services/tools/toolOrchestration.ts#L8-L12
function getMaxToolUseConcurrency(): number {
  return parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
}
// 默认最大 10 个工具并发，可通过环境变量调整
```

### 2.2 分批算法

Claude Code 将工具调用分为**连续的批次**，每批要么全部并行，要么单独串行：

```typescript
// 源码: services/tools/toolOrchestration.ts#L91-L116
function partitionToolCalls(toolUseMessages, toolUseContext): Batch[] {
  return toolUseMessages.reduce((acc, toolUse) => {
    const isConcurrencySafe = tool?.isConcurrencySafe(parsedInput.data) ?? false
    // fail-closed: 解析失败时视为不安全
    
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1].blocks.push(toolUse)  // 追加到当前并行批次
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })  // 新批次
    }
    return acc
  }, [])
}
```

**分批规则**：
- 连续的并发安全工具 → 合并为一个并行批次
- 遇到非并发安全工具 → 独立为一个串行批次
- 非并发安全工具后的并发安全工具 → 新的并行批次

**示例**：

```
输入: [Read, Read, Grep, Edit, Read, Read]
分批: [Read, Read, Grep]  →  [Edit]  →  [Read, Read]
       ↑ 并行批次(3个)    ↑ 串行      ↑ 并行批次(2个)
```

### 2.3 isConcurrencySafe() 分类

每个工具定义自己是否并发安全：

```typescript
// 源码: Tool.ts#L402, L759
// 默认实现（fail-closed）
isConcurrencySafe: (_input?: unknown) => false
```

| 工具 | 并发安全 | 原因 |
|------|:--------:|------|
| FileReadTool | ✅ | 纯读取 |
| GlobTool | ✅ | 纯读取 |
| GrepTool | ✅ | 纯读取 |
| WebFetchTool | ✅ | 无副作用 |
| WebSearchTool | ✅ | 无副作用 |
| BashTool | ⚠️ 条件 | 仅当命令被判定为只读时 |
| FileEditTool | ❌ | 文件修改 |
| FileWriteTool | ❌ | 文件写入 |
| AgentTool | ❌ | 子进程副作用 |
| 其他 | ❌ | 默认不安全 |

### 2.4 并行执行路径

```typescript
// 源码: services/tools/toolOrchestration.ts#L152-L177
async function* runToolsConcurrently(toolUseMessages, ...): AsyncGenerator<MessageUpdate> {
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      // 标记为执行中
      toolUseContext.setInProgressToolUseIDs(prev => new Set(prev).add(toolUse.id))
      // 执行工具
      yield* runToolUse(toolUse, ...)
      // 标记完成
      markToolUseAsComplete(toolUseContext, toolUse.id)
    }),
    getMaxToolUseConcurrency(),  // 并发上限: 10
  )
}
```

`all()` 是自定义的并发 AsyncGenerator 合并器，限制最大并发数。

### 2.5 上下文修改队列（防竞态）

并行执行的工具可能修改共享上下文（如文件状态缓存）。Claude Code 使用**队列化**策略：

```typescript
// 源码: services/tools/toolOrchestration.ts#L31-L62
// 并行批次：上下文修改先队列化，批次结束后按工具顺序串行应用
const queuedContextModifiers: Record<string, Function[]> = {}
for await (const update of runToolsConcurrently(...)) {
  if (update.contextModifier) {
    queuedContextModifiers[toolUseID].push(modifyContext)
  }
}
// 批次完成后：
for (const block of blocks) {
  for (const modifier of queuedContextModifiers[block.id] ?? []) {
    currentContext = modifier(currentContext)  // 按工具顺序串行应用
  }
}
```

```typescript
// 源码: services/tools/toolOrchestration.ts#L118-L150
// 串行批次：上下文修改立即应用
for (const toolUse of toolUseMessages) {
  for await (const update of runToolUse(toolUse, ..., currentContext)) {
    if (update.contextModifier) {
      currentContext = update.contextModifier.modifyContext(currentContext)  // 立即
    }
  }
}
```

### 2.6 StreamingToolExecutor（流式路径）

当 `config.gates.streamingToolExecution` 开启时，工具在 API 响应**流式到达时**就开始执行，无需等待完整响应：

```typescript
// 源码: services/tools/StreamingToolExecutor.ts#L129-L150
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executingTools = this.tools.filter(t => t.status === 'executing')
  return (
    executingTools.length === 0 ||                              // 无工具执行中
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))  // 都是安全的
  )
}
```

**工具状态机**：

```
queued → executing → completed → yielded
```

**Bash 错误级联**：

```typescript
// 源码: StreamingToolExecutor.ts#L359-L363
if (tool.block.name === BASH_TOOL_NAME) {
  this.hasErrored = true
  this.siblingAbortController.abort('sibling_error')
  // Bash 失败时取消同批次其他工具（隐式依赖假设）
}
```

仅 Bash 工具的错误会级联取消兄弟工具——因为 Bash 命令常有隐式依赖（如 `mkdir` 失败后续命令无意义）。

### 2.7 查询循环集成

```typescript
// 源码: query.ts#L561-L568, L1366-L1382
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()  // 流式路径
  : runTools(toolUseBlocks, ...)                  // 非流式路径（partitionToolCalls）

for await (const update of toolUpdates) {
  yield update.message       // 逐条 yield 结果
  toolResults.push(...)      // 收集
}
```

---

## 3. Qwen Code：智能分批并行（v0.16.0 架构升级）

> **重要变更**：v0.16.0 的 `coreToolScheduler.ts` 彻底重构了并发模型，从 v0.15.0 的"类型分流（Agent 并发 / 其他顺序）"升级为 Claude Code 同款的 **`isConcurrencySafe` + `partitionToolCalls` 分批并行**。以下分析基于 v0.16.0 源码。

### 3.1 执行模型（v0.16.0）

```typescript
// 源码: qwen-code/packages/core/src/core/coreToolScheduler.ts（3,284 行）
// 分批算法与 Claude Code 高度一致：连续并发安全工具合并为并行批次，
// 每个不安全工具独立为串行批次

const batches = partitionToolCalls(callsToExecute);
for (const batch of batches) {
  if (batch.concurrent && batch.calls.length > 1) {
    await this.runConcurrently(batch.calls, signal);  // 并行执行
  } else {
    for (const call of batch.calls) {
      await this.executeSingleToolCall(call, signal);  // 串行执行
    }
  }
}
```

### 3.2 并发安全判定（`isConcurrencySafe`）

```typescript
// 源码: coreToolScheduler.ts#L747-L764
function isConcurrencySafe(call: ScheduledToolCall): boolean {
  // Agent 工具（独立子代理，无共享状态）→ 并发安全
  if (canonicalToolName(call.request.name) === ToolNames.AGENT) return true;
  // Shell 命令：使用同步 regex checker（isShellCommandReadOnly）判断只读 → 安全
  // 注意：这里用的是同步 shellReadOnlyChecker，而非异步 AST 版本，
  // 因为 partitionToolCalls 同步执行。AST 版本仅用于权限决策。
  if (call.tool.kind === Kind.Execute) {
    const command = (call.request.args as { command?: string }).command;
    try { return isShellCommandReadOnly(stripShellWrapper(command)) }
    catch { return false; }  // fail-closed
  }
  // Read、Search、Fetch 类型工具 → 并发安全
  return CONCURRENCY_SAFE_KINDS.has(call.tool.kind);
}
```

**`CONCURRENCY_SAFE_KINDS`**（源码: `tools.ts`）：

```typescript
export const CONCURRENCY_SAFE_KINDS: ReadonlySet<Kind> = new Set([
  Kind.Read,    // 读文件、ReadFile
  Kind.Search,  // Grep、Glob、LS
  Kind.Fetch,   // WebFetch
]);
```

### 3.3 分批算法（`partitionToolCalls`）

```typescript
// 源码: coreToolScheduler.ts#L775-L784
function partitionToolCalls(calls: ScheduledToolCall[]): ToolBatch[] {
  return calls.reduce<ToolBatch[]>((batches, call) => {
    const safe = isConcurrencySafe(call);
    const lastBatch = batches[batches.length - 1];
    if (safe && lastBatch?.concurrent) {
      lastBatch.calls.push(call);   // 追加到当前并行批次
    } else {
      batches.push({ concurrent: safe, calls: [call] });  // 新批次
    }
    return batches;
  }, []);
}
```

示例（与 Claude Code 分批逻辑相同）：

```
输入: [Read, Read, Grep, Edit, Read, Read]
分批: [Read, Read, Grep]  →  [Edit]  →  [Read, Read]
       ↑ 并行批次(3个)    ↑ 串行      ↑ 并行批次(2个)
```

### 3.4 并发执行（`runConcurrently`）

```typescript
// 源码: coreToolScheduler.ts#L473-L493
private async runConcurrently(calls: ScheduledToolCall[], signal: AbortSignal): Promise<void> {
  const parsed = parseInt(process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] || '', 10);
  const maxConcurrency = Number.isFinite(parsed) && parsed >= 1 ? parsed : 10;
  // 信号量限流：最大 10 个并发（可通过 QWEN_CODE_MAX_TOOL_CONCURRENCY 调整）
  const executing = new Set<Promise<void>>();
  for (const call of calls) {
    const p = this.executeSingleToolCall(call, signal).finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= maxConcurrency) await Promise.race(executing);
  }
  await Promise.all(executing);
}
```

### 3.5 工具状态机（7 状态）

```
validating → scheduled → awaiting_approval → executing → success / error / cancelled
```

```typescript
// 源码: coreToolScheduler.ts
type Status = 'validating' | 'scheduled' | 'awaiting_approval'
             | 'executing' | 'success' | 'error' | 'cancelled'
```

### 3.6 权限流程

5 阶段权限评估（源码: `coreToolScheduler.ts`）：

```
L3(Tool 默认) → L4(PermissionManager 策略) → L5(ApprovalMode/Auto mode) → Hooks → 非交互处理
```

v0.16.0 新增 Auto 模式（#4151）：LLM 分类器自动评估工具调用风险，低风险自动批准，减少打断。

### 3.7 无流式工具执行

Qwen Code 等待完整 API 响应后才开始工具执行，不支持流式到达时即执行（Claude Code 的 StreamingToolExecutor 特性）。

---

## 4. 逐维度对比

| 维度 | Claude Code | Qwen Code v0.16.0 |
|------|------------|-----------|
| **并发模型** | 按 `isConcurrencySafe()` 智能分批 | 按 `isConcurrencySafe()` 智能分批（v0.16.0 升级，与 Claude Code 同款） |
| **默认并发上限** | 10（`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`） | 10（`QWEN_CODE_MAX_TOOL_CONCURRENCY`） |
| **安全判定** | 每个工具实现 `isConcurrencySafe(input)`（含动态参数判断） | `isConcurrencySafe()` 基于 Kind（Read/Search/Fetch）+ Agent + Shell 只读检测 |
| **分批策略** | 连续并发安全工具合并为一批 | 同左（`partitionToolCalls` 逻辑相同） |
| **Shell 并发** | ✅ 只读 Bash 可并行（AST 检测） | ✅ 只读 Shell 可并行（同步 regex checker） |
| **流式执行** | ✅ 工具在 API 响应流到达时开始执行 | ❌ 等待完整响应 |
| **上下文修改** | 并行时队列化，批次后串行应用 | 顺序执行（各 call 独立，无全局队列化机制） |
| **错误级联** | Bash 错误取消同批次兄弟 | 无级联，各工具独立 |
| **工具状态机** | 4 状态（queued/executing/completed/yielded） | 7 状态（含 validating/awaiting_approval） |
| **进度显示** | 并行工具各自独立显示进度 | 并行工具同时显示 |

---

## 5. 性能影响

### 5.1 典型场景对比

| 场景 | Claude Code | Qwen Code v0.16.0 |
|------|------------|-----------|
| 模型返回 5 个 Read 调用 | **并行**执行，~1× 延迟 | **并行**执行，~1× 延迟 |
| 模型返回 3 个 Read + 1 个 Edit + 2 个 Read | 批次 1: 3×Read 并行 → 批次 2: Edit 串行 → 批次 3: 2×Read 并行 | 同左（分批逻辑相同） |
| 模型返回 2 个 Agent 调用 | 并行（Agent 工具 `isConcurrencySafe` 返回 true） | **并行**（Agent 工具并发安全） |
| 模型返回 1 个 Bash（非只读）+ 1 个 Read | Bash 串行 → Read 串行 | Bash 串行 → Read 串行 |
| 模型返回 1 个 Bash（只读，如 git log）+ 1 个 Read | **并行**（Bash 只读安全） | **并行**（Shell 只读安全） |

### 5.2 大规模代码探索

v0.16.0 后，Qwen Code 与 Claude Code 在并行读取场景性能对等：

```
Claude Code: [Glob₁ + Glob₂ + Grep₁ + Grep₂ + Read₁ + Read₂ + Read₃]
             → 一个并行批次，~1× 延迟

Qwen Code v0.16.0: 同左（partitionToolCalls 合并为单个并行批次）
             → ~1× 延迟
```

**仍存在的差距**：流式工具执行（Claude Code 在 API 响应流到达时即执行，Qwen Code 需等完整响应）。

---

## 6. 关键源码文件

### Claude Code

| 文件 | 行数 | 职责 |
|------|------|------|
| `services/tools/toolOrchestration.ts` | ~189 | 分批算法 + 并行/串行执行路径 |
| `services/tools/StreamingToolExecutor.ts` | ~531 | 流式工具执行 + 状态机 + Bash 错误级联 |
| `Tool.ts` | L402, L759 | `isConcurrencySafe()` 接口定义 + 默认实现 |
| `utils/generators.ts` | L32-L72 | `all()` 并发 AsyncGenerator 合并器 |
| `query.ts` | L561-L568 | 流式 vs 非流式路径选择 |

### Qwen Code

| 文件 | 行数 | 职责 |
|------|------|------|
| `packages/core/src/core/coreToolScheduler.ts` | 3,284 | 工具调度器（v0.16.0 全面重构：智能分批并行，与 Claude Code 同款） |
| `packages/core/src/tools/tools.ts` | — | `CONCURRENCY_SAFE_KINDS`（Read/Search/Fetch）、`isConcurrencySafe` 辅助 |
| `packages/core/src/agents/runtime/agent-core.ts` | — | `processFunctionCalls` 调用调度器 |
| `packages/core/src/agents/runtime/agent-events.ts` | — | 工具事件类型定义 |

---

## 7. 设计启示

1. **v0.16.0 Qwen Code 并发模型全面对齐 Claude Code**：从 v0.15.0 的"Agent 并发 / 其他顺序"升级为基于 `isConcurrencySafe` + `partitionToolCalls` 的智能分批并行，并发上限同为 10，可通过 `QWEN_CODE_MAX_TOOL_CONCURRENCY` 调整
2. **流式执行仍是 Claude Code 独有优势**：在 API 响应流到达时即执行工具，不等完整响应，进一步重叠 I/O；Qwen Code 仍需等待完整响应
3. **动态参数判断是 Claude Code 的额外精细度**：Claude Code 的 `isConcurrencySafe(input)` 允许根据具体命令参数动态判断（如只读 Bash 命令），Qwen Code 的 Shell 判定依赖同步 regex checker，覆盖相同语义
4. **Bash 错误级联**（Claude Code StreamingToolExecutor）是 Qwen Code 暂未移植的设计：Bash 失败后取消同批次兄弟工具，避免无意义执行

> **免责声明**: 以上分析基于 2026 年 Q1 初稿，2026-05-22 对照 v0.16.0 复核。Claude Code v2.1.89；Qwen Code v0.16.0。**实质变更**：Qwen Code v0.16.0 的 `coreToolScheduler.ts` 从 1,710 行（v0.15.0 类型分流模型）重构为 3,284 行（v0.16.0 智能分批并行），并发模型已与 Claude Code 对齐，原文档关于"Qwen Code 顺序执行"的性能分析已过时。
