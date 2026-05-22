# Qwen Code 推测执行与 Followup 建议

> 分析版本：v0.16.0 | 分析日期：2026-05-22

## 1. 概述

推测执行（Speculation）是 Qwen Code 的一项性能优化特性，核心思想是：**在用户确认 followup 建议之前，后台预先执行该建议对应的操作**。当用户按下 Tab/Enter 接受建议时，预执行的结果立即生效，跳过等待 LLM 响应的时间。

整体系统由以下组件协作：

| 组件 | 职责 |
|------|------|
| `suggestionGenerator` | 预测用户下一步输入（Next-step Suggestion） |
| `followupState` | 框架无关的建议状态管理（展示、接受、取消） |
| `speculation` | 推测执行引擎，在后台运行 forked agent loop |
| `speculationToolGate` | 工具门控，决定哪些操作可以安全地推测执行 |
| `overlayFs` | Copy-on-Write 虚拟文件系统，隔离推测写入 |

工作流程概述：
1. 助手回复结束后，`suggestionGenerator` 生成下一步建议
2. 建议展示给用户的同时，`startSpeculation()` 在后台启动推测执行
3. 推测循环通过 forked GeminiChat 运行，使用 overlay 隔离文件写入
4. 用户按 Tab/Enter 接受 → `acceptSpeculation()` 将 overlay 应用到真实文件系统
5. 用户开始输入其他内容 → `abortSpeculation()` 清理资源

## 2. Speculation Engine

### 2.1 推测触发条件

推测执行在以下条件满足时触发：

- `CacheSafeParams` 可用（主会话至少完成过一轮交互）
- 存在有效的建议文本（通过 `suggestionGenerator` 生成）
- 父级 AbortSignal 尚未 abort

关键常量：
- `MAX_SPECULATION_TURNS = 20`：最多执行 20 个 agent 循环
- `MAX_SPECULATION_MESSAGES = 100`：消息总数上限

### 2.2 推测执行流程

```
startSpeculation(config, suggestion, parentSignal, options)
  │
  ├─ 创建 AbortController（链接到 parentSignal）
  ├─ 创建 OverlayFs(config.getCwd())
  ├─ 启动 runSpeculativeLoop() [后台 Promise]
  │     │
  │     ├─ 使用 runWithForkedChatModel() 获取 model
  │     ├─ 创建 forked GeminiChat（共享主会话的 prompt cache）
  │     └─ 循环执行：
  │           ├─ 发送 suggestion 作为 user message
  │           ├─ 接收 model stream → 提取 text + functionCall
  │           ├─ 对每个 functionCall 通过 evaluateToolCall() 门控
  │           │     ├─ allow → 直接执行
  │           │     ├─ redirect → rewritePathArgs → 在 overlay 上执行
  │           │     └─ boundary → 停止循环，记录 boundary
  │           └─ 将 tool results 加入 history，进入下一轮
  │
  └─ 返回 SpeculationState（status: 'running'）
```

### 2.3 推测结果验证

推测完成后进入两种终态：

- **completed**：所有工具调用成功执行，推测链完整。此时还会尝试生成 `pipelinedSuggestion`（下一条建议的预测）。
- **boundary**：遇到不可推测执行的工具调用（如需要用户确认的操作），停止推测但保留已完成的部分结果。

`ensureToolResultPairing()` 确保消息历史的 API 合法性——如果最后一条 model 消息包含未匹配 response 的 functionCall，会将其移除。

### 2.4 接受与中止

**接受（acceptSpeculation）：**
1. 调用 `overlayFs.applyToReal()` 将推测写入复制到真实文件系统
2. 通过 `ensureToolResultPairing()` 清理消息
3. 将推测过程中的消息注入主对话历史（`geminiClient.addHistory()`）
4. 返回 `SpeculationResult`，包括 `filesApplied`、`timeSavedMs`、`nextSuggestion`

**中止（abortSpeculation）：**
1. 触发 AbortController.abort()
2. 调用 `overlayFs.cleanup()` 删除临时文件
3. 设置 `state.status = 'aborted'`

## 3. SpeculationToolGate

### 3.1 工具门控机制

`evaluateToolCall()` 对每个工具调用返回三种决策之一：

| 决策 | 含义 | 后续操作 |
|------|------|----------|
| `allow` | 安全的只读操作 | 直接执行，读取路径通过 overlay 解析 |
| `redirect` | 写入操作，当前 approval mode 允许 | 重写路径到 overlay 后执行 |
| `boundary` | 不可推测的操作 | 停止推测循环 |

### 3.2 安全边界

**安全只读工具（allow）：**
- `ReadFile`、`Grep`、`Glob`、`Ls`、`Lsp`

**写入工具（redirect/boundary）：**
- `Edit`、`WriteFile`
- 仅在 `AUTO_EDIT` / `AUTO` / `YOLO` 模式下 redirect
- 在 `DEFAULT` / `PLAN` 模式下触发 boundary（不会静默修改文件）

**Shell 命令：**
- 使用 AST parser（`isShellCommandReadOnlyAST`）判断是否只读
- 只读命令（如 `ls -la`、`cat`、`grep`）→ allow
- 写入命令（如 `rm`、`echo >>`）→ boundary

**强制 boundary 工具：**
- `Agent`、`Skill`、`TodoWrite`、`Memory`、`AskUserQuestion`、`ExitPlanMode`、`WebFetch`

**未知工具（含 MCP 工具）：** 统一 boundary，确保安全。

### 3.3 路径解析机制

读取时通过 `resolveReadPaths()` 优先从 overlay 读取（如果该文件曾被推测写入）。写入时通过 `rewritePathArgs()` 将路径重定向到 overlay 目录。

支持的路径参数 key：`file_path`、`path`、`filePath`、`notebook_path`。

## 4. OverlayFs（覆盖文件系统）

### 4.1 虚拟文件系统设计

`OverlayFs` 实现了 Copy-on-Write 语义的文件隔离层：

- 底层存储：`/tmp/qwen-speculation/<pid>/<uuid>/` 临时目录
- 使用 `Map<relPath, overlayPath>` 跟踪已写入的文件
- 所有路径操作基于相对路径（相对于 `realCwd`），拒绝 cwd 外的路径

### 4.2 核心操作

**redirectWrite(realPath)：**
1. 将绝对路径转为相对路径（安全检查：不允许 `..` 路径穿越）
2. 如果文件已在 overlay 中，返回缓存的 overlay 路径
3. 首次写入：在 overlay 中创建目录结构，如果原始文件存在则 copy 到 overlay
4. 返回 overlay 路径供工具写入

**resolveReadPath(realPath)：**
- 如果该文件在 overlay 中有记录，返回 overlay 路径（读取推测后的版本）
- 否则返回原始路径（读取真实文件系统）

**applyToReal()：**
- 遍历 `writtenFiles` map，将每个 overlay 文件 copy 回真实路径
- Best-effort：单个文件失败不影响其他文件
- 返回成功应用的文件路径列表

**cleanup()：**
- 递归删除整个 overlay 临时目录

### 4.3 安全保障

- 拒绝 cwd 外的路径写入（`toRelative()` 返回 null → 抛出异常）
- 防止路径穿越攻击（检查 `..` 和绝对路径）
- cleanup 始终在 finally 块中执行，防止临时文件泄漏

## 5. Suggestion Generator（建议生成）

### 5.1 生成策略

`generatePromptSuggestion()` 有两条执行路径：

1. **Cache-aware forked query**（`enableCacheSharing: true`）：复用主对话的 prompt cache，通过 `runForkedAgent` 发送单轮请求。成本低、延迟小。
2. **BaseLLM side query**：将完整对话历史 + SUGGESTION_PROMPT 发送给模型。不依赖 cache 但 token 消耗更大。

生成条件：
- 至少有 2 轮 assistant 回复（`MIN_ASSISTANT_TURNS = 2`）
- 延迟 300ms 后展示（避免闪烁）

### 5.2 Prompt 设计

SUGGESTION_PROMPT 的核心指令：
- 预测用户自然输入（"I was just about to type that" 测试）
- 优先提取助手末尾的 tip/hint（如 "Tip: type X to ..."）
- 格式：2-12 个词，匹配用户风格
- 禁止：评价性语句、提问、AI 口吻、多句话

### 5.3 过滤规则

`getFilterReason()` 实现了多层过滤：

| 过滤器 | 示例 |
|--------|------|
| `done` | "done" |
| `meta_text` | "nothing found"、"no suggestion" |
| `meta_wrapped` | "(silence)"、"[nothing]" |
| `error_message` | "API error: ..." |
| `prefixed_label` | "Suggestion: ..." |
| `too_few_words` | 单词（除白名单外如 "yes"、"commit"） |
| `too_many_words` | 超过 12 词 |
| `multiple_sentences` | 包含多个句子 |
| `evaluative` | "looks good"、"thanks" |
| `ai_voice` | "Let me..."、"I'll..."、"Here's..." |
| CJK 特殊处理 | 2-30 字符区间 |

### 5.4 Pipelined Suggestion

推测完成后，系统会基于推测结果上下文生成下一条建议（`generatePipelinedSuggestion`），实现连续推测链。

## 6. Followup State

### 6.1 状态管理

`FollowupState` 接口：

```typescript
interface FollowupState {
  suggestion: string | null;  // 当前建议文本
  isVisible: boolean;         // 是否展示
  shownAt: number;            // 展示时间戳（遥测用）
}
```

`createFollowupController()` 返回框架无关的控制器，CLI（Ink）和 WebUI（React）共用：

| Action | 功能 |
|--------|------|
| `setSuggestion(text)` | 设置建议，300ms 延迟后展示 |
| `accept(method)` | 接受建议，触发 onAccept 回调 |
| `dismiss()` | 关闭建议，记录 'ignored' outcome |
| `clear()` | 硬重置所有状态和定时器 |
| `cleanup()` | 组件卸载时清理 |

### 6.2 用户接受/拒绝流程

**接受流程：**
1. 用户按 Tab/Enter/Right → `accept(method)` 被调用
2. 防抖检查（`ACCEPT_DEBOUNCE_MS = 100ms`）
3. 触发 `onOutcome({ outcome: 'accepted', accept_method, time_ms })` 遥测
4. 清除状态 → 通过 `queueMicrotask` 调用 `onAccept(text)` 回调
5. 上层代码调用 `acceptSpeculation()` 应用推测结果

**拒绝/忽略流程：**
1. 用户开始输入 → `dismiss()` 被调用
2. 触发 `onOutcome({ outcome: 'ignored', time_ms })` 遥测
3. 清除状态 → 上层代码调用 `abortSpeculation()` 清理

## 7. 与 Claude Code Speculation 的对比

| 维度 | Qwen Code | Claude Code |
|------|-----------|-------------|
| 后端模型 | Gemini / Qwen (via GeminiChat) | Claude (Anthropic API) |
| Cache 策略 | 共享主对话 prompt cache（CacheSafeParams） | 利用 prompt caching 减少重复 |
| 文件隔离 | OverlayFs（临时目录 + Copy-on-Write） | 类似机制，overlay/sandbox |
| 工具门控 | 三级门控（allow/redirect/boundary） | 类似分类（safe/unsafe） |
| Shell 判断 | AST parser 精确分析命令只读性 | 类似的 shell 命令分类 |
| 安全模型 | 与 ApprovalMode 联动，default/plan 模式不推测写入 | 基于 permission 配置 |
| 建议生成 | 独立 LLM 调用 + JSON schema 约束 | 类似的 followup suggestion |
| Pipelined | 支持（推测完成后预生成下条建议） | 支持 |
| Boundary 处理 | 保留已执行的部分结果 | 类似的渐进式中止 |
| 遥测 | timeSavedMs + outcome tracking | 类似的指标 |

核心差异：Qwen Code 的推测系统完全基于 Gemini/Qwen 的 Content/Part 消息格式构建，使用 `functionCall`/`functionResponse` 作为工具调用协议。OverlayFs 采用简洁的 Node.js fs 操作实现，不依赖外部沙箱。

## 8. 相关代码索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `packages/core/src/followup/speculation.ts` | ~576 | 推测执行引擎主逻辑 |
| `packages/core/src/followup/speculationToolGate.ts` | ~149 | 工具安全门控 |
| `packages/core/src/followup/overlayFs.ts` | ~141 | Copy-on-Write 文件隔离 |
| `packages/core/src/followup/suggestionGenerator.ts` | ~384 | 建议生成与过滤 |
| `packages/core/src/followup/followupState.ts` | ~238 | 状态管理 controller |
| `packages/core/src/followup/index.ts` | ~16 | 模块导出 |
| `packages/core/src/utils/forkedAgent.ts` | - | 共享 prompt cache 的 forked 查询 |
| `packages/core/src/utils/shellAstParser.ts` | - | Shell 命令只读性 AST 分析 |
| `packages/core/src/utils/paths.ts` | - | PATH_ARG_KEYS 路径参数定义 |
| `packages/core/src/config/config.ts:175` | - | ApprovalMode 枚举定义 |
