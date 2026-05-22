# Qwen Code 压缩与上下文管理

> 分析版本：v0.16.0 | 分析日期：2026-05-22

## 1. 概述（为什么需要压缩）

Qwen Code 作为一个长会话 AI 编程助手，在处理复杂编程任务时会产生大量的对话历史。这些历史包括用户消息、模型回复、工具调用请求和工具结果（文件内容、shell 输出、搜索结果等）。随着会话进行：

- **Token 累积**：对话历史不断增长，最终超过模型的 context window 限制（如 128K、200K、1M tokens）
- **内存膨胀**：Node.js 进程的 V8 heap 中保存着整个 `Content[]` 历史数组，包含大量 base64 编码的图片和大段文本
- **API 成本**：每次请求将完整历史发送给模型，输入 token 计费线性增长

为解决这些问题，Qwen Code 实现了三层递进式压缩架构。

## 2. 三层压缩架构

### 2.1 Microcompaction（空闲清理）

**触发条件**：用户空闲超过配置的阈值时间（默认 60 分钟），在下一次用户消息发送前执行。

**工作机制**：

Microcompaction 在 `packages/core/src/services/microcompaction/microcompact.ts` 中实现。它不调用 LLM，而是直接在本地清除历史中过时的工具结果：

1. **时间触发评估** (`evaluateTimeBasedTrigger`)：检查 `lastApiCompletionTimestamp` 与当前时间的间隔是否超过 `toolResultsThresholdMinutes`
2. **收集可压缩引用** (`collectCompactablePartRefs`)：扫描历史，按三种类型分组：
   - `tool`：可压缩工具（read_file, shell, grep, glob, web_fetch, edit, write_file）的 functionResponse
   - `media`：顶层 user 消息中的 inlineData/fileData（如 @reference 粘贴的图片）
   - `nested-media`：非可压缩工具结果中嵌套的媒体数据
3. **保留最近结果**：每种类型独立保留最近 `keepRecent` 个（默认 5 个），超出部分被清除
4. **替换内容**：工具结果被替换为 `[Old tool result content cleared]`，媒体被替换为 `[Old inline media cleared: <mime>]`
5. **文件缓存联动**：清除的 read_file 结果对应的 FileReadCache 条目会被精确 disarm，避免后续返回过期的 `file_unchanged` 占位符（issue #4239）

**调用位置**：`packages/core/src/core/client.ts` 中每次用户消息发送前调用：

```typescript
const mcResult = microcompactHistory(
  this.getHistoryShallow(),
  this.lastApiCompletionTimestamp,
  this.config.getClearContextOnIdle(),
);
```

### 2.2 Auto-Compaction（LLM 侧查询压缩）

**触发条件**：当本次请求的 prompt token count 超过 `threshold * contextWindowSize` 时（默认 0.7 * contextWindowSize）。

**工作机制**：

Auto-Compaction 在 `packages/core/src/services/chatCompressionService.ts` 中实现，通过调用 LLM side-query 生成摘要：

1. **阈值检查**：`originalTokenCount < threshold * contextLimit` 时跳过
2. **历史切分** (`findCompressSplitPoint`)：
   - 目标：保留最后 30%（`COMPRESSION_PRESERVE_THRESHOLD = 0.3`）的历史
   - 算法：从头遍历，找到字符累积超过 `(1 - 0.3) = 70%` 的第一个非 functionResponse 的 user 消息作为切分点
   - Fallback：若找不到干净切分点，对 in-flight 的 functionCall 保留尾部 2 个完整 tool round
3. **最小压缩比检查**：`compressCharCount / totalCharCount < MIN_COMPRESSION_FRACTION(0.05)` 时跳过，防止无效 API 调用
4. **Compaction Input Slimming**：压缩前预处理（详见第 3 节）
5. **Side Query**：调用模型生成 `<state_snapshot>` 格式的摘要，开启 thinking 以保证质量
6. **历史替换**：成功后用 `[summary, model_ack, ...historyToKeep]` 替换原历史

**调用时机**：在 `sendMessageStream()` 中，添加用户消息到历史之前：

```typescript
compressionInfo = await this.tryCompress(prompt_id, model, false, signal);
```

**Reactive Compression（反应式压缩）**：当 API 返回 context-length-exceeded 错误时，以 `force=true` + `trigger='auto'` 再次尝试压缩，作为溢出恢复机制。

### 2.3 Heap-Pressure Safety Net（堆压力安全网）

**触发条件**：V8 heap 使用率超过 `HIGH_HEAP_PRESSURE_THRESHOLD = 0.85`（即 heapUsed / heapSizeLimit >= 85%）。

**工作机制**：

在 `packages/cli/src/utils/memoryDiagnostics.ts` 中实现检测：

```typescript
export function isHighHeapPressure(diagnostics: MemoryDiagnostics): boolean {
  const heapPressure = getHeapPressure(diagnostics);
  return heapPressure !== undefined && heapPressure >= HIGH_HEAP_PRESSURE_THRESHOLD;
}
```

堆压力检测主要用于 `/doctor memory` 诊断命令，提供以下信号：
- V8 heap statistics 分析
- RSS vs heap-total gap 检测（非堆内存泄漏信号）
- Active handles/requests 积累检测
- 内存采样趋势分析 (`collectMemoryPressureSamples`)

该层是诊断与预警层，在关键路径上影响压缩行为的方式是：`chatCompressionService` 刻意使用 `getHistoryShallow()` 而非 `getHistory()` 来避免在压缩关键时刻执行 structuredClone。

## 3. Compaction Input Slimming（压缩前预处理）

在 `packages/core/src/services/compactionInputSlimming.ts` 中实现。Side-query 发送给模型之前，对 `historyToCompress` 进行瘦身处理：

### Media Stripping

将 `inlineData` 和 `fileData` parts 替换为文本占位符：
- 图片：`[image: image/png]`
- 文档：`[document: application/pdf]`

原因：summary 模型无法解释原始 base64 数据，且传输这些字节会极大膨胀 side-query 请求体。

### Tool Result 嵌套媒体处理

Qwen Code 的工具结果可能在 `functionResponse.parts` 中携带嵌套媒体（如 read_file 返回的图片）。Slimming 递归处理这些嵌套结构，确保所有 base64 内容被剥离。

### MIME 安全清理

`sanitizeMimeForPlaceholder()` 防止 MCP 工具返回的恶意 MIME 类型注入 prompt：
```typescript
export function sanitizeMimeForPlaceholder(mime: string): string {
  return mime
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[[\]]/g, '')
    .trim()
    .slice(0, 128);
}
```

### Image Token Estimation

`estimatePartChars()` 为分割点计算提供字符数估算：
- 文本：直接使用 `text.length`
- 图片/文档：使用 `imageTokenEstimate * TOKEN_TO_CHAR_RATIO`（默认 `1600 * 4 = 6400` chars）
- functionResponse：递归估算 output 文本 + 嵌套媒体 + 64 字符固定开销

这避免了 base64 编码（一张 1MB 图片约 1.3M chars）在切分计算中主导分割点。

## 4. 关键常量与阈值

| 常量 | 值 | 位置 | 含义 |
|------|------|------|------|
| `COMPRESSION_TOKEN_THRESHOLD` | 0.7 | chatCompressionService.ts | 历史 token 占 context window 70% 时触发压缩 |
| `COMPRESSION_PRESERVE_THRESHOLD` | 0.3 | chatCompressionService.ts | 压缩后保留最后 30% 的历史 |
| `MIN_COMPRESSION_FRACTION` | 0.05 | chatCompressionService.ts | 可压缩部分 < 5% 时跳过（防止无效调用） |
| `TOOL_ROUND_RETAIN_COUNT` | 2 | chatCompressionService.ts | in-flight fallback 保留最近 2 个完整 tool round |
| `HIGH_HEAP_PRESSURE_THRESHOLD` | 0.85 | memoryDiagnostics.ts | heapUsed/heapSizeLimit >= 85% 触发告警 |
| `DEFAULT_TOKEN_LIMIT` | 131,072 (128K) | tokenLimits.ts | 未知模型的默认 context window |
| `DEFAULT_IMAGE_TOKEN_ESTIMATE` | 1,600 | compactionInputSlimming.ts | 单张图片的默认 token 估算 |
| `TOKEN_TO_CHAR_RATIO` | 4 | compactionInputSlimming.ts | token 到 char 的转换比 |
| `MEDIA_PART_TOKEN_ESTIMATE` | 1,600 | microcompact.ts | 微压缩中单个媒体部分的 token 估算 |
| `toolResultsThresholdMinutes` (默认) | 60 | config.ts | 空闲多久后触发 microcompaction |
| `toolResultsNumToKeep` (默认) | 5 | config.ts | microcompaction 保留最近几个工具结果 |

## 5. structuredClone 与 OOM 问题

### 2x 峰值内存放大

在 v0.16.0 之前的实现中，`getHistory(true)` 使用 `structuredClone(history)` 进行深拷贝：

```typescript
getHistory(curated: boolean = false): Content[] {
  const history = curated ? extractCuratedHistory(this.history) : this.history;
  return structuredClone(history);  // 整个历史的完整深拷贝
}
```

对于一个包含大量工具结果（文件内容、截图 base64）的长会话，假设历史占用 800MB 堆内存，`structuredClone` 会在瞬间分配另外 800MB 来创建副本，导致峰值内存使用达到 ~1.6GB。

### 正反馈循环分析

```
长会话积累大历史 → token count 超过 70% 阈值
    → 触发 auto-compaction
        → 之前版本调用 getHistory(true) = structuredClone(全量历史)
            → V8 heap 瞬间翻倍
                → 超过 heap_size_limit → OOM crash
```

这是一个正反馈循环：**越需要压缩的会话（历史越大），执行压缩时越容易 OOM**。压缩本身成为了 OOM 的触发器。

### 修复方案

v0.16.0 的关键修复：压缩服务改用 `getHistoryShallow(true)` 替代 `getHistory(true)`：

```typescript
// chatCompressionService.ts 中的注释：
// Avoid `getHistory(true)` here: long tool-heavy sessions can make a
// defensive deep clone larger than the remaining V8 heap headroom at
// exactly the moment compaction is trying to reduce memory pressure.
const curatedHistory = chat.getHistoryShallow(true);
```

`getHistoryShallow` 只做容器级浅拷贝（`{ ...content, parts: [...content.parts] }`），不克隆 parts 内的大型 payload（text、inlineData 等），内存开销从 O(payload_size) 降至 O(entry_count)。

同样，`getRequestHistory()` 也使用浅拷贝路径：

```typescript
private getRequestHistory(): Content[] {
  return extractCuratedHistory(this.history).map(copyContentContainer);
}
```

## 6. 配置项

### chatCompression Settings

```typescript
interface ChatCompressionSettings {
  /** 触发压缩的 context 占用百分比阈值。默认 0.7。设为 0 或负数可禁用。 */
  contextPercentageThreshold?: number;
  /** 单张图片的 token 估算值。默认 1600。影响切分点计算。 */
  imageTokenEstimate?: number;
}
```

在 settings.json 中配置：
```json
{
  "chatCompression": {
    "contextPercentageThreshold": 0.7,
    "imageTokenEstimate": 1600
  }
}
```

### clearContextOnIdle Settings

```typescript
interface ClearContextOnIdleSettings {
  /** 空闲多少分钟后清除旧工具结果。默认 60。-1 表示禁用。 */
  toolResultsThresholdMinutes?: number;
  /** 保留最近多少个工具结果。默认 5。最小值强制为 1。 */
  toolResultsNumToKeep?: number;
}
```

在 settings.json 中配置：
```json
{
  "clearContextOnIdle": {
    "toolResultsThresholdMinutes": 60,
    "toolResultsNumToKeep": 5
  }
}
```

### 环境变量覆盖

| 环境变量 | 对应配置 | 说明 |
|----------|----------|------|
| `QWEN_IMAGE_TOKEN_ESTIMATE` | chatCompression.imageTokenEstimate | 覆盖图片 token 估算，优先级最高 |
| `QWEN_MC_KEEP_RECENT` | clearContextOnIdle.toolResultsNumToKeep | 覆盖 microcompaction 保留数量 |

优先级顺序：环境变量 > settings 配置 > 代码默认值。

## 7. Loop Detection（循环检测）

Qwen Code 通过 `hasFailedCompressionAttempt` 标志位防止无限压缩循环：

**问题场景**：压缩结果为空或 token 反而膨胀 → 下次 turn token 仍超阈值 → 再次触发压缩 → 再次失败 → 无限循环，每轮白白消耗一次 side-query API 调用。

**解决方案**：

```typescript
private hasFailedCompressionAttempt = false;

// 压缩失败时（非 force）设置标志
} else if (isCompressionFailureStatus(info.compressionStatus)) {
  if (!force) {
    this.hasFailedCompressionAttempt = true;
  }
}

// 入口处检查标志
if (threshold <= 0 || (hasFailedCompressionAttempt && !force)) {
  return { newHistory: null, info: { ... CompressionStatus.NOOP } };
}
```

关键设计：
- **auto-compaction**（`force=false`）：一旦失败，后续自动压缩全部跳过
- **manual /compress**（`force=true`）：用户手动触发不受此限制
- **reactive compression**（`force=true, trigger='auto'`）：context-overflow 恢复不受此限制，但失败后仍会设置标志阻止后续自动触发
- **成功重置**：一次成功的压缩会清除标志（`this.hasFailedCompressionAttempt = false`）

失败状态包括三种：
- `COMPRESSION_FAILED_EMPTY_SUMMARY`：模型返回空摘要
- `COMPRESSION_FAILED_TOKEN_COUNT_ERROR`：无法计算压缩后 token 数
- `COMPRESSION_FAILED_INFLATED_TOKEN_COUNT`：压缩后 token 反而增加

## 8. Token Limits 与模型 Context Window

`packages/core/src/core/tokenLimits.ts` 维护各模型的 context window 大小映射：

| 模型族 | Input Context Window |
|--------|---------------------|
| Gemini 3.x / 1.5 / 2.x | 1,000,000 (1M) |
| GPT-5.x | 272,000 |
| GPT-4o / 4.1 | 131,072 (128K) |
| o-series (o3, o4-mini) | 200,000 |
| Claude (all) | 200,000 |
| Qwen3-coder-plus/flash, qwen3.x | 1,000,000 (1M) |
| Qwen (fallback) | 262,144 (256K) |
| DeepSeek V4 | 1,000,000 (1M) |
| DeepSeek (fallback) | 131,072 (128K) |
| MiniMax M2.5 | 196,608 (192K) |
| Kimi | 262,144 (256K) |
| Seed-OSS | 524,288 (512K) |

默认值（无法匹配模型时）：`DEFAULT_TOKEN_LIMIT = 131,072`

压缩触发计算：`originalTokenCount >= 0.7 * contextWindowSize`

例如 Qwen3-coder-plus (1M context)：token 达到 700,000 时触发自动压缩。

## 9. 与 Claude Code Compression 的对比

| 维度 | Qwen Code | Claude Code (参考) |
|------|-----------|-------------------|
| 空闲清理 | Microcompaction (time-based, per-part) | 类似的 idle cleanup |
| LLM 压缩 | side-query + state_snapshot prompt | side-query summarization |
| 切分策略 | 字符比例 + user 消息边界对齐 | 类似的 token-based split |
| 保留比例 | 30% | 类似 |
| 触发阈值 | 70% context window | 类似 |
| OOM 防护 | shallow copy (v0.16.0 fix) | structuredClone with similar risks |
| 循环检测 | per-chat sticky flag | 类似机制 |
| Media 处理 | 专门的 slimming pipeline | 类似的 media stripping |
| Hook 支持 | PreCompact / PostCompact hooks | 类似 |

## 10. 优化方向

基于代码分析，以下是可见的优化空间：

1. **增量压缩**：当前压缩是 all-or-nothing 的——要么完全成功替换历史，要么 NOOP。可以考虑分段压缩，逐步缩小历史。

2. **流式 side-query**：当前 `runSideQuery` 是阻塞的（`maxAttempts: 1`），对于大历史可能超时。可以考虑流式读取摘要。

3. **主动 GC 协调**：在压缩前主动触发 `global.gc()` 释放可回收内存，为 slimming 过程腾出空间。

4. **Microcompaction 与 Auto-Compaction 协同**：当前两者独立触发。如果 microcompaction 已经大幅减少了历史 token 数，可以跳过随后的 auto-compaction 检查。

5. **Token 精确计算**：当前使用字符数 / 4 作为 token 估算（`TOKEN_TO_CHAR_RATIO = 4`），对中文内容误差较大。可以集成 tiktoken 或模型专用 tokenizer。

6. **压缩质量监控**：记录压缩前后的对话质量指标，检测摘要是否丢失了关键上下文。

## 11. 相关代码索引

| 文件路径 | 职责 |
|----------|------|
| `packages/core/src/services/chatCompressionService.ts` | Auto-compaction 主逻辑、split point 算法 |
| `packages/core/src/services/compactionInputSlimming.ts` | 媒体剥离、char 估算、slimming config 解析 |
| `packages/core/src/services/microcompaction/microcompact.ts` | 空闲时间触发的工具结果清理 |
| `packages/core/src/core/geminiChat.ts` | tryCompress() 入口、reactive compression、loop detection |
| `packages/core/src/core/client.ts` | microcompaction 调用点、FileReadCache 联动 |
| `packages/core/src/core/tokenLimits.ts` | 模型 context window 映射、DEFAULT_TOKEN_LIMIT |
| `packages/cli/src/utils/memoryDiagnostics.ts` | 堆压力检测、/doctor memory 诊断 |
| `packages/core/src/core/turn.ts` | CompressionStatus enum、ChatCompressionInfo 类型 |
| `packages/core/src/config/config.ts` | ChatCompressionSettings、ClearContextOnIdleSettings 接口定义 |
