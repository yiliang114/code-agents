# Qwen Code 记忆系统（Memory）

> 分析版本：v0.16.0 | 分析日期：2026-05-22

## 1. 概述与设计目标

Qwen Code 的记忆系统是一个**文件驱动的持久化知识库**，在会话之间保留用户偏好、反馈规则、项目上下文和外部引用指针。设计目标：

- **跨会话持久化**：将对话中提炼出的持久性事实存储到本地文件系统，使未来 session 能快速获取上下文。
- **自动化生命周期**：每轮对话自动 Extract（提取）→ Recall（检索）→ 定期 Dream（整理去重）→ Forget（删除），无需用户手动管理。
- **最小侵入性**：通过 forked agent（子代理）在后台运行，不阻塞主对话流。
- **并发安全**：PID 文件锁 + 进程级队列确保多 session 不冲突。
- **Worktree 感知**：Git worktree 下自动归一化到主仓库的记忆目录，避免重复存储。

核心入口类为 `MemoryManager`（Facade 模式），通过 `config.getMemoryManager()` 获取单例。

---

## 2. 存储模型

### 2.1 文件结构

```
~/.qwen/projects/<sanitized-project-path>/
├── meta.json                      # AutoMemoryMetadata
├── extract-cursor.json            # AutoMemoryExtractCursor
├── consolidation.lock             # Dream 进程锁（PID）
└── memory/
    ├── MEMORY.md                  # 索引文件（一行一条）
    ├── user/
    │   └── user_role.md           # 每条记忆一个文件
    ├── feedback/
    │   └── feedback_testing.md
    ├── project/
    │   └── project_deadline.md
    └── reference/
        └── reference_dashboard.md
```

当设置 `QWEN_CODE_MEMORY_LOCAL=1` 时，存储路径变为项目本地 `.qwen/memory/`。

### 2.2 YAML Frontmatter Schema

每个记忆文件必须包含如下 frontmatter：

```markdown
---
name: {{memory name}}
description: {{one-line description}}
type: {{user | feedback | project | reference}}
---

{{memory content}}

Why: {{reason}}
How to apply: {{guidance}}
```

解析由 `parseAutoMemoryTopicDocument()` 完成，提取 `name`/`title`、`description`、`type`、`body`。

### 2.3 四种记忆类型

| 类型 | 说明 | 典型内容 |
|------|------|----------|
| `user` | 用户角色、背景、偏好 | "用户是数据科学家，关注可观测性" |
| `feedback` | 用户对助手行为的纠正/确认 | "不要 mock 数据库，用真实连接" |
| `project` | 项目动态、截止日期、决策 | "3月5日起冻结非关键 merge" |
| `reference` | 外部系统指针 | "Pipeline bugs 在 Linear INGEST 项目中" |

类型定义来自 `types.ts`：

```typescript
export const AUTO_MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type AutoMemoryType = (typeof AUTO_MEMORY_TYPES)[number];
```

### 2.4 MEMORY.md 索引

索引文件是**纯文本列表**（无 frontmatter），每行格式为：

```
- [Title](relative/path.md) — one-line hook
```

受以下限制约束（`indexer.ts`）：

| 常量 | 值 | 说明 |
|------|----|------|
| `MAX_INDEX_LINE_CHARS` | 150 | 单行最大字符数 |
| `MAX_INDEX_LINES` | 200 | 最大行数 |
| `MAX_INDEX_BYTES` | 25,000 | 最大字节数 |

超出时会截断并追加 WARNING 注释。索引在 Extract/Dream/Forget 操作后由 `rebuildManagedAutoMemoryIndex()` 自动重建。

---

## 3. 核心数据流

### 3.1 Extract（增量提取）

**触发时机**：每轮 UserQuery 完成后自动调度。

**流程**：

1. `MemoryManager.scheduleExtract()` 检查前置条件：
   - 若本轮主 agent 已写入记忆文件（`historyWritesToMemory`） → skip（避免冲突）
   - 若同项目已有 extraction 在运行 → 排入尾部队列（trailing request，最多保留 1 个）
2. `runAutoMemoryExtract()` 执行：
   - 调用 `ensureAutoMemoryScaffold()` 确保目录/文件存在
   - 构建 transcript messages：将 `Content[]` 转为 `{offset, role, text}[]`
   - **Cursor 机制**：读取 `extract-cursor.json`，通过 `sessionId + processedOffset` 确定增量起点
   - 仅当存在新的 user messages 时继续
3. `runAutoMemoryExtractionByAgent()` 启动 forked agent：
   - 使用 `getCacheSafeParams()` 获取主 agent 的完整对话历史作为 `extraHistory`
   - 构建 scoped permission manager：SHELL 只允许 read-only，EDIT/WRITE_FILE 只允许写 memory 目录
   - Agent 工具集：`read_file`, `grep_search`, `glob`, `list_directory`, `run_shell_command`(RO), `write_file`, `edit`
   - 限制：**maxTurns = 5, maxTimeMinutes = 2**
4. 完成后更新 cursor、bump metadata、rebuild index

**Cursor 结构**（`types.ts`）：

```typescript
export interface AutoMemoryExtractCursor {
  sessionId?: string;
  processedOffset?: number;
  updatedAt: string;
}
```

### 3.2 Recall（检索）— 双策略

**触发时机**：每轮 UserQuery 开始时，为 system prompt 注入相关记忆。

**双策略架构**（`recall.ts`）：

**策略 1 — Model-based（优先）**：

- 由 `selectRelevantAutoMemoryDocumentsByModel()` 实现（`relevanceSelector.ts`）
- 使用 `runSideQuery()` 调用 fast model，temperature=0
- 输入：query + memory manifest（每条记忆的 type、relativePath、timestamp、description）
- 输出：JSON `{selected_memories: string[]}` — 选中的文件 relativePath 列表
- 超时：30s safety-net + caller 可传入 AbortSignal
- 感知 `recentTools`：如果 assistant 刚使用过某工具，跳过该工具的参考文档类记忆

**策略 2 — Heuristic fallback（降级）**：

- 当 model recall 失败/超时且 caller signal 未 abort 时使用
- Token 化 query → 对每个 doc 的 type+title+description+body 进行关键词匹配
- 按 `TYPE_KEYWORDS` 字典加权（如 query 含 "preference" 则 user 类型 +1）
- 非空 body 额外 +1

**输出格式**（注入 system prompt）：

```
## Relevant memory

### Title (relative/path.md)
Saved 3 days ago.
description

body content (max 1200 chars)

> NOTE: This memory is 3 days old. ...verify against current code...
```

**关键常量**：

| 常量 | 值 | 说明 |
|------|----|------|
| `MAX_RELEVANT_DOCS` | 5 | 最多召回文档数 |
| `MAX_DOC_BODY_CHARS` | 1,200 | 单文档 body 截断长度 |

### 3.3 Dream（整理/去重）

**触发时机**：自动调度，需满足全部门控条件。

**门控条件**（`MemoryManager.scheduleDream()`）：

| 条件 | 默认值 | 说明 |
|------|--------|------|
| `getManagedAutoDreamEnabled()` | — | Config 开关 |
| 非同一 session | — | `lastDreamSessionId !== currentSessionId` |
| 距上次 dream 时间 | 24h | `DEFAULT_AUTO_DREAM_MIN_HOURS` |
| 自上次 dream 以来 session 数 | 5 | `DEFAULT_AUTO_DREAM_MIN_SESSIONS` |
| Session scan 节流 | 10min | `SESSION_SCAN_INTERVAL_MS` — 避免频繁扫描文件系统 |
| 无 consolidation lock | — | PID 锁不存在或已过期 |
| 同 project 无 dream 在运行 | — | dedup key 去重 |

**执行流程**：

1. `acquireDreamLock()` — 写入 `consolidation.lock`（内容为当前 PID，flag=wx 原子创建）
2. `runManagedAutoMemoryDream()` → `planManagedAutoMemoryDreamByAgent()` 启动 forked agent：
   - System prompt 指导 agent 进行四阶段工作：Orient → Gather recent signal → Consolidate → Prune and index
   - 工具集：`read_file`, `grep_search`, `glob`, `list_directory`, `run_shell_command`(RO), `write_file`, `edit`
   - 限制：**maxTurns = 8, maxTimeMinutes = 5**
   - 支持 AbortSignal 取消（用户可通过 `cancelTask()` 中止）
3. 成功后 rebuild index、写入 metadata（`lastDreamAt`, `lastDreamSessionId` 等）
4. `releaseDreamLock()` — 删除 lock 文件

**锁过期机制**：

```typescript
const DREAM_LOCK_STALE_MS = 60 * 60 * 1000; // 1 hour
```

若 lock 文件 mtime 超过 1 小时，或记录的 PID 进程已不存在，自动清除。

### 3.4 Forget（删除）

**触发方式**：用户显式请求（如 `/forget` 命令）或通过 `MemoryManager.forget()` 调用。

**双策略选择**（同 Recall）：

1. **Model-based**：`runSideQuery()` 使用主 model（非 fast model），temperature=0，超时 8s
2. **Heuristic fallback**：对 candidate 的 summary+why+howToApply 做 lowercase substring 匹配

**删除逻辑**（`forgetManagedAutoMemoryMatches()`）：

- 按文件分组 matches
- 对每个文件：解析 frontmatter + entries → 过滤掉匹配的 entries
  - 若所有 entries 均被删除 → `unlink` 整个文件
  - 否则 → 重写文件（保留 frontmatter + 剩余 entries）
- 完成后 bump metadata + rebuild index

---

## 4. SkillReview Agent Planner

独立于记忆四阶段的辅助功能，在 `skillReviewAgentPlanner.ts` 中实现。

**触发条件**：

- `enabled !== false`
- 本 session 中 tool 调用次数 >= threshold（默认 `AUTO_SKILL_THRESHOLD = 20`）
- 本 session 未修改过 skills 文件
- 同 project 无 skill-review 在运行

**功能**：启动 forked agent 审查对话，提取可复用的 skill 文件到 `.qwen/skills/<name>/SKILL.md`。

**安全约束**：

- 只能修改含 `source: auto-skill` frontmatter 标记的 skill 文件
- 新建 skill 必须带有此标记
- 不允许删除任何 skill
- READ/LS 仅允许在 project root 内
- 通过 `assertRealProjectSkillPath()` 防止 symlink 逃逸

**限制**：`maxTurns = 8, timeoutMs = 120,000ms (2min)`

---

## 5. 常量与阈值

| 常量 | 值 | 来源文件 | 说明 |
|------|----|----------|------|
| `DEFAULT_CONTEXT_FILENAME` | `QWEN.md` | const.ts | 默认上下文文件名 |
| `AGENT_CONTEXT_FILENAME` | `AGENTS.md` | const.ts | Agent 上下文文件名 |
| `MEMORY_SECTION_HEADER` | `## Qwen Added Memories` | const.ts | 手动记忆段落标题 |
| `AUTO_MEMORY_SCHEMA_VERSION` | 1 | types.ts | Schema 版本 |
| `MAX_RELEVANT_DOCS` | 5 | recall.ts | 单次 Recall 最多文档数 |
| `MAX_DOC_BODY_CHARS` | 1,200 | recall.ts | Recall 文档体截断 |
| `MAX_SCANNED_MEMORY_FILES` | 200 | scan.ts | 最大扫描文件数 |
| `MAX_INDEX_LINE_CHARS` | 150 | indexer.ts | 索引单行最大字符 |
| `MAX_INDEX_LINES` | 200 | indexer.ts / prompt.ts | 索引最大行数 |
| `MAX_INDEX_BYTES` | 25,000 | indexer.ts / prompt.ts | 索引最大字节 |
| `MAX_TOPIC_SUMMARY_CHARS` | 280 | extractionAgentPlanner.ts | Topic 摘要截断 |
| `DEFAULT_AUTO_DREAM_MIN_HOURS` | 24 | manager.ts | Dream 最小间隔 |
| `DEFAULT_AUTO_DREAM_MIN_SESSIONS` | 5 | manager.ts | Dream 最少 session 数 |
| `DREAM_LOCK_STALE_MS` | 3,600,000 (1h) | manager.ts | Lock 过期时间 |
| `SESSION_SCAN_INTERVAL_MS` | 600,000 (10min) | manager.ts | Session 扫描节流 |
| `AUTO_SKILL_THRESHOLD` | 20 | manager.ts | Skill review 触发阈值 |
| `DEFAULT_AUTO_SKILL_MAX_TURNS` | 8 | skillReviewAgentPlanner.ts | Skill review agent turns |
| `DEFAULT_AUTO_SKILL_TIMEOUT_MS` | 120,000 | skillReviewAgentPlanner.ts | Skill review 超时 |
| `FILE_LOCK_TIMEOUT_MS` | 30,000 | writeContextFile.ts | 文件锁获取超时 |
| `MAX_EXISTING_FILE_BYTES` | 16MB | writeContextFile.ts | QWEN.md 最大读取大小 |

---

## 6. Worktree 感知（路径规范化）

`paths.ts` 中的 `getAutoMemoryRoot()` 实现了 Git worktree 归一化：

```typescript
function findCanonicalGitRoot(startPath: string): string | null {
  // 1. 向上查找 .git
  // 2. 若 .git 是文件（worktree），解析 gitdir: 指向
  // 3. 读取 commondir 找到主仓库的 .git 目录
  // 4. 验证 backlink 指向确实是 worktree
  // 5. 返回主仓库根路径
}
```

效果：同一仓库的所有 worktree 共享同一份记忆存储，路径为：
```
~/.qwen/projects/<sanitized-canonical-root>/memory/
```

路径缓存通过 `_autoMemoryRootCache` (Map) 实现，避免重复文件系统遍历。

`isAutoMemPath()` 使用 `path.relative()` 判断路径是否在 memory 目录内，兼容跨平台路径分隔符。

---

## 7. 并发控制与状态管理

### 7.1 Extract 队列

```
extractRunning: Set<projectRoot>        # 标记正在执行的 project
extractCurrentTaskId: Map<project, id>  # 当前任务 ID
extractQueued: Map<project, {taskId, params}>  # 尾部队列（最多 1 个）
```

- 同一 project 最多 1 个 running + 1 个 queued
- Queued 会被后续请求 supersede（替换为最新 params）
- Running 完成后自动启动 queued

### 7.2 Dream 并发

- `dreamInFlightByKey: Map<dedupeKey, recordId>` — 同 project 去重
- `dreamAbortControllers: Map<recordId, AbortController>` — 支持用户取消
- `dreamLastSessionScanAt: Map<project, timestamp>` — 扫描节流
- `consolidation.lock` — 跨进程互斥（PID 文件锁）

### 7.3 Drain 机制

`MemoryManager.drain()` 等待所有 in-flight promises settle，支持可选 timeout。用于 session 结束时确保后台任务完成。

### 7.4 writeContextFile 并发

`writeContextFile.ts` 使用 `async-mutex` 的 `Mutex` 实现 per-file 锁，超时 30s，防止并发 append 竞争。

---

## 8. System Prompt 注入策略

记忆系统通过两条路径注入 system prompt：

### 8.1 MEMORY.md 索引（始终注入）

`buildManagedAutoMemoryPrompt()` 构建完整的 auto memory prompt，包含：

- 记忆系统说明（how to save, what not to save, types）
- 当前 MEMORY.md 索引内容（截断保护）
- 注入位置：拼接到 user memory 末尾（`appendManagedAutoMemoryToUserMemory()`）

### 8.2 Relevant Memory（按查询注入）

`buildRelevantAutoMemoryPrompt()` 格式化选中文档为 `## Relevant memory` 段落：

- 包含标题、保存时间（`memoryAge()`）、description、body
- 超过 1 天的记忆附加 staleness caveat（提醒验证当前代码）
- 注入时机：Recall 阶段完成后加入当轮 system prompt

### 8.3 安全提示

- `TRUSTING_RECALL_SECTION`：强调记忆中的路径/函数名可能已过时，必须验证
- `MEMORY_DRIFT_CAVEAT`：记忆是 point-in-time 快照，冲突时信任当前代码
- `memoryFreshnessText()`：超过 1 天的记忆自动加注 staleness 警告

---

## 9. 与 Claude Code Memory 的对比

| 维度 | Qwen Code Memory | Claude Code Memory |
|------|-----------------|-------------------|
| 存储位置 | `~/.qwen/projects/<hash>/memory/` 或 `.qwen/memory/` | `~/.claude/` + project `CLAUDE.md` |
| 存储格式 | YAML frontmatter + Markdown body | Markdown（CLAUDE.md 段落） |
| 索引机制 | MEMORY.md 自动重建索引 | 无独立索引，直接读取 CLAUDE.md |
| 记忆类型 | 四种 typed（user/feedback/project/reference） | 无类型区分 |
| 提取方式 | Forked agent 子代理自动提取 | 用户手动 `/memory` 或工具保存 |
| 检索策略 | Model + Heuristic 双策略 | 全量注入（文件级） |
| 整理机制 | Dream agent 自动整理去重 | 无自动整理 |
| 删除方式 | Model-based 语义匹配 + Heuristic | 用户手动编辑 |
| Worktree 感知 | 自动归一化到主仓库 | 按目录独立 |
| 并发控制 | PID 锁 + extract 队列 + Mutex | 无显式并发控制 |
| Skill 提取 | SkillReview agent 自动生成 | 无 |

---

## 10. 相关代码索引

| 文件 | 职责 |
|------|------|
| `memory/manager.ts` | MemoryManager 门面类，任务调度/队列/drain |
| `memory/types.ts` | 核心类型定义（AutoMemoryType, Metadata, Cursor） |
| `memory/const.ts` | 文件名常量、MEMORY_SECTION_HEADER |
| `memory/paths.ts` | 路径计算、Worktree 归一化、isAutoMemPath |
| `memory/store.ts` | Scaffold 创建、索引读取 |
| `memory/extract.ts` | Extract 主流程、cursor 管理 |
| `memory/extractionAgentPlanner.ts` | Extract forked agent 配置与执行 |
| `memory/recall.ts` | Recall 双策略入口 |
| `memory/relevanceSelector.ts` | Model-based recall（side query） |
| `memory/dream.ts` | Dream 主流程 |
| `memory/dreamAgentPlanner.ts` | Dream forked agent 配置与 prompt |
| `memory/forget.ts` | Forget 双策略选择 + 文件操作 |
| `memory/entries.ts` | 记忆条目解析/渲染（legacy + new format） |
| `memory/indexer.ts` | MEMORY.md 索引重建 |
| `memory/scan.ts` | 文件系统扫描、frontmatter 解析 |
| `memory/prompt.ts` | System prompt 构建 |
| `memory/memoryAge.ts` | 时间格式化、staleness 文本 |
| `memory/status.ts` | 状态查询（供 UI/CLI 展示） |
| `memory/skillReviewAgentPlanner.ts` | Skill review forked agent |
| `memory/writeContextFile.ts` | QWEN.md 写入（Mutex 保护） |
