# Code Agent 上下文压缩机制对比分析

> 分析日期：2026-05-20
> 涉及项目：Claude Code (Anthropic)、Qwen Code (fork from Google Jules / Gemini CLI)

## 1. 为什么需要压缩

Code Agent 在长会话中会积累大量的工具调用结果（文件内容、命令输出、搜索结果等），当 token 数接近模型的上下文窗口限制时，必须对历史进行压缩，否则会触发 API 报错或 OOM。

压缩的核心矛盾在于：**既要让模型保留关键上下文，又要尽可能复用已有的 prompt cache 以减少延迟和成本**。

## 2. Claude Code 的压缩策略

### 2.1 核心思路：Append-and-Summarize

Claude Code 的压缩是在**当前会话上下文末尾追加一条 summarization 指令**，让模型基于已有上下文生成摘要。

```
┌─────────────────────────────────────────┐
│ System Prompt                           │  ← cache hit ✓
├─────────────────────────────────────────┤
│ Tool Declarations                       │  ← cache hit ✓
├─────────────────────────────────────────┤
│ Message 1 (user)                        │  ← cache hit ✓
│ Message 2 (assistant)                   │  ← cache hit ✓
│ ...                                     │  ← cache hit ✓
│ Message N (user)                        │  ← cache hit ✓
├─────────────────────────────────────────┤
│ "Please summarize the conversation..." │  ← 新增，仅这部分需要 prefill
└─────────────────────────────────────────┘
```

**关键优势**：整个前缀（system prompt + tools + 所有历史消息）完全命中 prompt cache，仅新增的 summarization 指令需要 prefill。对于一个 100K token 的会话，这意味着压缩调用几乎是免费的。

### 2.2 压缩后的处理

模型生成摘要后，Claude Code 将会话历史替换为：
- 摘要内容（作为消息插入）
- 保留的最近部分历史

后续的正常对话请求中，system prompt 和 tool declarations 不变，依然可以命中 global scope 的 cache。

### 2.3 Cache 架构

Anthropic API 的 prompt caching 有三个断点（cache breakpoint）：
1. **System prompt** — `scope: 'global'`，跨 session 可复用
2. **Tool declarations（最后一个 tool）** — `scope: 'global'`
3. **最后一条 user message** — per-session scope

压缩操作不改变前两个断点，因此 global cache 始终有效。

## 3. Qwen Code 的压缩策略

Qwen Code 有三层压缩机制，从轻量到重量依次为：

### 3.1 Tier 1: Microcompaction（空闲时工具结果清理）

**触发条件**：用户空闲超过 60 分钟

**机制**：将较早的 tool result 替换为占位符 `[Old tool result content cleared]`，保留最近 5 个 tool result 不动。

**特点**：
- 不涉及 LLM 调用
- 直接原地修改 history entries
- 对 cache 无影响（只是减小 payload 体积）

**代码位置**：`packages/core/src/services/microcompaction/microcompact.ts`

### 3.2 Tier 2: Auto-compaction（LLM 驱动的自动压缩）

**触发条件**：`promptTokenCount >= 0.7 * contextWindowSize`，或 V8 堆内存压力超过阈值。

**机制**：

```
┌──────────────────────────────────────────────┐
│            Side Query（独立 API 调用）          │
├──────────────────────────────────────────────┤
│ System Prompt: getCompressionPrompt()        │  ← 压缩专用 prompt
├──────────────────────────────────────────────┤
│ 待压缩的历史消息（前 70%）                      │  ← 全部重新发送，无 cache
├──────────────────────────────────────────────┤
│ "First, reason in your scratchpad.           │
│  Then, generate the <state_snapshot>."        │
└──────────────────────────────────────────────┘
```

1. 通过 `findCompressSplitPoint()` 将历史按 70/30 分割
2. 对前 70% 部分做 media stripping（去除 base64 图片等）
3. 通过 `runSideQuery()` 发起**独立的 API 调用**，使用专用的压缩 system prompt
4. 模型生成 `<state_snapshot>` XML 格式的摘要
5. 用摘要替换历史：`[summary_user, summary_ack_model, ...historyToKeep]`

**代码位置**：`packages/core/src/services/chatCompressionService.ts`

**压缩后应用**（auto 路径）：
```typescript
// geminiChat.ts:562
this.setHistory(newHistory);  // 仅替换 history，system prompt 不变
```

**压缩后应用**（manual `/compress` 路径）：
```typescript
// client.ts:1802
await this.startChat(compressedHistory, SessionStartSource.Compact);
// startChat() 会重建整个 GeminiChat 实例，重新生成 system prompt
```

### 3.3 压缩 Prompt 模板

Qwen Code 使用结构化 XML 模板要求模型输出：

```xml
<state_snapshot>
    <overall_goal>用户的高层目标</overall_goal>
    <key_knowledge>关键事实、约定、约束</key_knowledge>
    <file_system_state>文件的创建/读取/修改/删除记录</file_system_state>
    <recent_actions>最近的重要操作和结果</recent_actions>
    <current_plan>当前的分步计划，标记完成状态</current_plan>
</state_snapshot>
```

### 3.4 Tier 3: Heap-Pressure Safety Net

**触发条件**：V8 堆使用率超过 `HEAP_PRESSURE_COMPRESSION_RATIO`

**机制**：绕过 token 阈值门控，直接触发 auto-compaction。有 cooldown 机制防止反复触发。

**代码位置**：`packages/core/src/core/geminiChat.ts:512-537`

## 4. 核心差异对比

| 维度 | Claude Code | Qwen Code |
|------|------------|-----------|
| **压缩调用方式** | 在现有会话末尾追加 summarization 指令 | 发起独立的 side query |
| **压缩调用的 system prompt** | 复用主会话 system prompt | 使用独立的 `getCompressionPrompt()` |
| **压缩调用的 cache 命中** | 整个前缀 cache hit，几乎零额外 prefill 成本 | 无 cache 可复用，全部重新 prefill |
| **压缩后 system prompt** | 不变 | auto 路径不变；manual 路径重建（内容相同） |
| **压缩层次** | 单层 | 三层（microcompaction → auto → heap-pressure） |
| **摘要格式** | 自然语言 | 结构化 XML (`<state_snapshot>`) |
| **media 处理** | — | 压缩前 strip inline media |

## 5. Cache 影响分析

### 5.1 压缩调用本身的开销

这是两者最大的差异点。

**Claude Code**：压缩调用追加在已有会话末尾，prefix 完全 cache hit。假设会话有 100K tokens，压缩指令本身约 200 tokens，那么这次调用的 prefill 成本约为 200 tokens（cache 覆盖 100K）。

**Qwen Code**：压缩调用是独立的 side query，使用不同的 system prompt。假设待压缩的历史有 70K tokens（70% of 100K），compression prompt 约 1K tokens，那么这次调用的 prefill 成本约为 71K tokens，全部无 cache。

**差异量级**：在 100K token 会话中，Qwen Code 的压缩调用 prefill 成本约为 Claude Code 的 **350 倍**。

### 5.2 压缩后正常对话的 cache

两者在压缩后都会面临 cache 部分失效——因为会话历史被替换了。但 system prompt + tool declarations 的 global cache 在两者中都保持有效。

### 5.3 成本估算示例

以 100K token 会话、触发一次压缩为例：

| 阶段 | Claude Code prefill | Qwen Code prefill |
|------|-------------------|------------------|
| 压缩调用 | ~200 tokens (新增部分) | ~71K tokens (全量) |
| 压缩后首次对话 | ~35K tokens (summary + 保留部分 + 新消息) | ~35K tokens (同左) |

Qwen Code 在压缩调用阶段多消耗约 70K tokens 的 prefill，按 input token 价格计算，约等于浪费了一次中等长度会话的成本。

## 6. 优化方向

### 6.1 方案 A：复用现有会话发起压缩（推荐）

将压缩从 side query 改为在主会话上下文末尾追加压缩指令，类似 Claude Code 的做法：

```typescript
// 当前实现（side query，无 cache）
const summaryResult = await runSideQuery(config, {
  systemInstruction: getCompressionPrompt(),
  contents: [...slimmedHistory, { role: 'user', parts: [{ text: '...' }] }],
});

// 优化方向：在主会话末尾追加（复用 cache）
const summaryResult = await chat.sendMessage({
  parts: [{ text: getCompressionPrompt() + '\n\nPlease summarize now.' }],
});
```

**优点**：
- 压缩调用的 prefill 成本从 O(N) 降至 O(1)
- 改动较小，核心逻辑不变

**挑战**：
- 需要确保压缩指令不会影响后续会话的上下文（摘要生成后需要从 history 中移除压缩指令和响应）
- Qwen Code 使用的是 Gemini API（非 Anthropic API），需要确认 Gemini 的 cache 行为是否一致
- 当前 side query 使用 fast model 做压缩，追加到主会话会用主 model，可能增加推理成本

### 6.2 方案 B：缓存压缩 side query 的 prefix

如果必须保留 side query 模式，可以为压缩专用 prompt 设置 persistent cache：

- Gemini API 支持 [Context Caching](https://ai.google.dev/gemini-api/docs/caching)，可以将 compression system prompt 缓存
- 但这只能节省约 1K tokens 的 compression prompt，主要成本（70K tokens 的历史）仍然无法缓存

### 6.3 方案 C：增量压缩

不一次性压缩前 70%，而是采用滑动窗口：

- 每次只压缩最早的 N 条消息，追加到已有摘要中
- 较小的 side query payload，cache miss 影响更小
- 但增加了压缩调用次数，且摘要可能会逐渐失真（"摘要的摘要"问题）

## 7. 相关代码索引

| 文件 | 说明 |
|------|------|
| `packages/core/src/services/chatCompressionService.ts` | 压缩核心逻辑：分割、side query、摘要替换 |
| `packages/core/src/services/microcompaction/microcompact.ts` | 空闲时 tool result 清理 |
| `packages/core/src/services/compactionInputSlimming.ts` | 压缩前 media stripping |
| `packages/core/src/core/prompts.ts:447` | `getCompressionPrompt()` 压缩 prompt 模板 |
| `packages/core/src/utils/sideQuery.ts` | side query 通用执行器 |
| `packages/core/src/core/geminiChat.ts:505` | `tryCompress()` auto-compaction 入口 |
| `packages/core/src/core/client.ts:1787` | `tryCompressChat()` manual 压缩入口 |
| `packages/core/src/core/client.ts:600` | `startChat()` 压缩后重建 chat 实例 |

## 8. 相关 PR

| PR | 状态 | 说明 |
|----|------|------|
| [#4345](https://github.com/QwenLM/qwen-code/pull/4345) | OPEN | 三层 auto-compaction 阈值重设计 |
| [#4186](https://github.com/QwenLM/qwen-code/pull/4186) | MERGED | heap-pressure auto-compaction 安全网 |
| [#4127](https://github.com/QwenLM/qwen-code/pull/4127) | OPEN | memory-based chat compression 防 OOM |
| [#4101](https://github.com/QwenLM/qwen-code/pull/4101) | MERGED | 压缩前 strip inline media |
| [#3879](https://github.com/QwenLM/qwen-code/pull/3879) | MERGED | 上下文溢出时 reactive compression |
| [#3735](https://github.com/QwenLM/qwen-code/pull/3735) | MERGED | subagent 上下文 auto-compact |

> 截至 2026-05-20，**没有发现针对"压缩调用复用 prompt cache"的 PR 或 issue**。
