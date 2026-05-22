# Qwen Code Session 管理

> 分析版本：v0.16.0 | 分析日期：2026-05-22

## 1. 概述

Qwen Code 的 Session 管理系统负责对话的持久化、恢复、分支(fork)和生命周期控制。核心设计理念：

- **JSONL append-only 存储**：每条消息作为独立 JSON 行追加写入，crash-safe
- **Tree 结构历史**：通过 `uuid` / `parentUuid` 形成消息树，支持未来 checkpoint 分支
- **Project 隔离**：基于 `projectHash`（工作目录的 hash）隔离不同项目的 session
- **Cursor 分页**：使用文件 mtime 作为分页游标，支持大量 session 高效列表

存储路径：`~/.qwen/tmp/<project_hash>/chats/<sessionId>.jsonl`

## 2. Session 生命周期

### 2.1 创建

Session 创建发生在 `ChatRecordingService` 构造时，由上层入口（CLI/VSCode/ACP）触发：

1. 生成 `sessionId = randomUUID()`（标准 UUID v4）
2. 创建 JSONL 文件：`<chatsDir>/<sessionId>.jsonl`
3. 首条记录写入 session 元数据（cwd、version、gitBranch 等）

### 2.2 恢复（Resume）

恢复流程通过 `SessionService.loadSession()` 实现：

1. 读取全部 JSONL records
2. 验证 projectHash 归属
3. 调用 `reconstructHistory()` 从 tree 重建线性对话链
4. 返回 `ResumedSessionData`（包含完整对话和 lastCompletedUuid）
5. 恢复 worktree context（如有 sidecar 存在）
6. 恢复 background agents（从 meta 文件扫描 status=running 的 agent）

### 2.3 销毁

`removeSession()` 直接删除 JSONL 文件，支持批量删除（`removeSessions()`），每个 session 独立处理，单个失败不影响其余。

### 2.4 Session ID 生成策略

- 使用 Node.js `crypto.randomUUID()` 生成标准 UUID v4
- 文件名规则：`/^[0-9a-fA-F-]{32,36}\.jsonl$/`
- 每条消息内部同样使用 UUID 作为 `uuid` 字段

## 3. Session Service 核心接口

```typescript
// 核心数据结构
interface SessionListItem {
  sessionId: string;
  cwd: string;
  startTime: string;        // ISO 8601
  mtime: number;            // 文件修改时间（用于分页）
  prompt: string;           // 首条 user prompt（截断至 200 字符）
  gitBranch?: string;
  filePath: string;
  messageCount?: number;    // 延迟计算，不在 list 时获取
  customTitle?: string;
  titleSource?: TitleSource; // 'manual' | 'auto'
}

interface ResumedSessionData {
  conversation: ConversationRecord;
  filePath: string;
  lastCompletedUuid: string | null;
}

interface ConversationRecord {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: ChatRecord[];
}
```

**关键方法**：

| 方法 | 说明 |
|------|------|
| `listSessions(options)` | 分页列表，按 mtime 降序，cursor-based |
| `loadSession(sessionId)` | 重建完整对话用于恢复 |
| `loadLastSession()` | 加载最近一次 session |
| `removeSession(sessionId)` | 删除单个 session |
| `renameSession(id, title, source)` | 追加 custom_title 系统记录 |
| `forkSession(source, newId)` | 完整复制 session 并重写 parentUuid 链 |
| `findSessionsByTitle(title)` | 按标题精确匹配（case-insensitive） |
| `countSessionMessages(id)` | 延迟计数 user/assistant 消息数 |

## 4. Git Worktree Session

### 4.1 Worktree 创建与切换

`GitWorktreeService` 提供两类 worktree：

1. **Arena worktree**（Agent 隔离用）：存储在 `~/.qwen/worktrees/<sessionId>/worktrees/<name>`
2. **User worktree**（EnterWorktree 工具用）：存储在 `<projectRoot>/.qwen/worktrees/<slug>`

创建流程：
- 验证 slug 合法性（`validateUserWorktreeSlug`：仅允许 `[a-zA-Z0-9._-]`，不超 64 字符）
- 检查分支是否已存在（拒绝覆盖）
- 执行 `git worktree add -b worktree-<slug> <path> <base>`
- 配置 `core.hooksPath` 指向主仓库 hooks 目录
- 写入 session marker（`.qwen-session` 文件记录 owning sessionId）

### 4.2 Worktree Cleanup 策略

`cleanupStaleAgentWorktrees()` 实现自动清理：

- **仅清理 ephemeral worktree**：匹配 `agent-<7hex>` 模式
- **年龄阈值**：30 天（`STALE_WORKTREE_CUTOFF_MS`）
- **安全检查**（fail-closed）：
  - 有未提交的 tracked 变更 -> 跳过
  - 有未合并到上游的 commits -> 跳过
  - 任何 git 读取错误 -> 跳过（保守策略）

User-named worktree 永远不会被自动清理。

### 4.3 Worktree 与主会话的关系

`WorktreeSession` 作为 sidecar JSON 文件持久化（`<sessionId>.worktree.json`）：

```typescript
interface WorktreeSession {
  slug: string;
  worktreePath: string;
  worktreeBranch: string;
  originalCwd: string;       // repo top-level 路径
  originalBranch: string;
  originalHeadCommit: string; // 创建时的 HEAD SHA
}
```

恢复流程（`restoreWorktreeContext()`）：
1. 读取 sidecar JSON
2. 验证 worktreePath 在 `<originalCwd>/.qwen/worktrees/` 下（防篡改）
3. 确认 worktree 目录仍存在
4. 返回 context message 供模型继续使用 worktree 路径

## 5. Background Agent Resume

### 5.1 持久化机制

Background agent 的状态通过两个文件持久化：

- **Meta 文件**（`<agentId>.meta.json`）：status、agentType、createdAt、resolvedApprovalMode、resumeCount
- **Transcript 文件**（`<agentId>.jsonl`）：完整对话历史（同 ChatRecord 格式）

存储路径：`~/.qwen/tmp/<project_hash>/subagents/<sessionId>/`

### 5.2 恢复策略

`BackgroundAgentResumeService.loadPausedBackgroundAgents()`:

1. 扫描 session 目录下所有 `.meta.json` 文件
2. 筛选 `status === 'running'` 且未在当前 registry 中注册的 agent
3. 读取 transcript，执行 `recoverTranscript()` 重建历史
4. 注册为 `paused` 状态，用户可手动 resume

`resumeBackgroundAgent()` 实际恢复逻辑：
- 从 transcript 恢复对话历史（区分 fork agent 和普通 agent）
- 重建 approval mode（reconcile 持久化模式与当前父级模式）
- 创建新的 `AgentHeadless` 实例并注入历史
- 发送 continuation message 驱动继续执行
- 支持 SubagentStart/Stop hook

## 6. Session Recap（会话摘要）

`generateSessionRecap()` 在用户 resume 时生成简短摘要：

- **输入**：最近 30 条对话（过滤掉 tool call/response 和 thought）
- **模型**：使用 fast model，temperature 0.3，maxTokens 300
- **输出格式**：`<recap>...</recap>` 标签包裹，不超 40 词
- **语言**：自动匹配对话主导语言（中文约 80 字符）
- **容错**：best-effort，任何失败返回 null，仅重试 1 次

## 7. Session Title（标题生成）

`tryGenerateSessionTitle()` 自动或手动生成 session 标题：

- **触发**：assistant turn 完成后自动触发（可通过 `QWEN_DISABLE_AUTO_TITLE=1` 禁用）
- **重试上限**：每 session 最多 `AUTO_TITLE_ATTEMPT_CAP = 3` 次
- **输入**：最近 20 条对话文本，tail-slice 至 1000 字符
- **模型**：fast model，temperature 0.2，schema 强制 JSON 输出
- **后处理**（`sanitizeTitle()`）：
  - 剥离 ANSI/OSC 控制序列（安全防护）
  - 去除 Markdown 标记、CJK 括号、尾部标点
  - 截断至 `SESSION_TITLE_MAX_LENGTH = 200`
- **持久化**：追加 `custom_title` 系统记录到 JSONL，定期 re-anchor（每 32KB 重新追加一次确保 tail-read 命中）

失败原因枚举：`no_fast_model` | `no_client` | `empty_history` | `empty_result` | `aborted` | `model_error`

## 8. Chat Recording（对话录制）

`ChatRecordingService` 是 Session 持久化的核心写入层：

### ChatRecord 数据结构

```typescript
interface ChatRecord {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  type: 'user' | 'assistant' | 'tool_result' | 'system';
  subtype?: 'chat_compression' | 'custom_title' | 'rewind'
          | 'agent_bootstrap' | 'notification' | ...;
  cwd: string;
  version: string;
  gitBranch?: string;
  message?: Content;          // LLM API 格式的消息体
  usageMetadata?: UsageMetadata;
  model?: string;
  toolCallResult?: ToolCallResponseInfo;
  systemPayload?: various;    // 系统事件负载
  agentId?: string;           // subagent 产生的记录
  forkedFrom?: { sessionId, messageUuid };  // fork 溯源
}
```

### 关键特性

- **异步写入队列**：`lastRecordUuid` 同步更新保证链式正确，fs write 异步链式执行
- **FileDiff 截断**：diff 超 50K 字符、内容超 16K 字符自动截断存储
- **Title re-anchor**：每 32KB 新内容后重新追加 title 记录保证 tail-read 命中
- **Chat compression checkpoint**：存储压缩后的 `compressedHistory` 用于 resume 时跳过早期消息

## 9. 与 Claude Code Session 的对比

| 特性 | Qwen Code | Claude Code |
|------|-----------|-------------|
| 存储格式 | JSONL（append-only tree） | JSONL（append-only tree） |
| Session ID | UUID v4 | UUID v4 |
| 历史重建 | `reconstructHistory` (parentUuid chain) | 相同 tree 重建策略 |
| Fork/Branch | `forkSession` + `forkedFrom` 字段 | `/branch` 命令，同样全量复制 |
| Worktree | `.qwen/worktrees/<slug>` | `.claude/worktrees/<slug>` |
| Worktree cleanup | 30天 agent-prefix 自动清理 | 同样 30天阈值 |
| Session title | Fast model 自动生成 + 手动 | 类似自动生成机制 |
| Session recap | Fast model 40词摘要 | Away-summary prompt |
| Background agent resume | Meta + transcript 双文件持久化 | 类似机制 |
| Chat compression | checkpoint record 内嵌 compressedHistory | 类似 summarization |
| Title persistence | JSONL 内 system record + tail-read 优化 | 类似 JSONL 追加 |
| Project 隔离 | projectHash (cwd hash) | 相同策略 |

主要差异：
- Qwen Code 使用 `@google/genai` Content 格式存储消息体（Gemini API 兼容）
- Qwen Code 的 title re-anchor 机制（每 32KB 重新追加）是独有优化
- Qwen Code 的 worktree session marker（`.qwen-session`）明确记录 owning session

## 10. 相关代码索引

| 文件路径 | 职责 |
|----------|------|
| `packages/core/src/services/sessionService.ts` | Session CRUD、历史重建、分页列表 |
| `packages/core/src/services/chatRecordingService.ts` | 对话录制、JSONL 写入、auto-title 触发 |
| `packages/core/src/services/gitWorktreeService.ts` | Git worktree 创建/删除/diff/apply |
| `packages/core/src/services/worktreeSessionService.ts` | Worktree session sidecar 读写/恢复 |
| `packages/core/src/services/worktreeCleanup.ts` | Ephemeral worktree 定期清理 |
| `packages/core/src/services/sessionRecap.ts` | Resume 时生成对话摘要 |
| `packages/core/src/services/sessionTitle.ts` | 自动/手动标题生成与 sanitize |
| `packages/core/src/agents/background-agent-resume.ts` | Background agent 恢复逻辑 |
| `packages/core/src/agents/background-tasks.ts` | Background task registry 与通知 |
| `packages/core/src/utils/jsonl-utils.ts` | JSONL 读写工具（含 tolerant 解析） |
| `packages/core/src/utils/sessionStorageUtils.ts` | Tail-read 优化的标题/字段扫描 |
