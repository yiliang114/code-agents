# Code Agent 记忆系统（Memory）架构设计

> 分析日期：2026-05-22
> 涉及项目：Claude Code (Anthropic)、Qwen Code (fork from Google Jules / Gemini CLI)

## 1. 为什么 Code Agent 需要记忆系统

Code Agent 的会话天然是无状态的——每次对话结束后，Agent 不会保留任何对用户、项目、偏好或历史决策的认知。这带来了几个具体问题：

1. **重复交代上下文**：用户每次开新会话都要重新解释自己的角色、项目背景、技术栈偏好
2. **行为不一致**：上一次纠正过的行为，下一次又会犯同样的错误
3. **项目上下文丢失**：正在进行中的工作、截止日期、人员分工等动态信息无法跨会话传递
4. **参考资源定位低效**：每次都要重新告知"bug 在 Linear 哪个 project"、"oncall dashboard 的地址是什么"

记忆系统的核心目标是：**让 Agent 在跨会话时保持对用户和项目的认知连续性，同时不引入过多的 context window 开销**。

## 2. 设计哲学

### 2.1 File-Based Persistence

记忆以 **独立的 Markdown 文件** 形式存储在磁盘上，每个文件有 YAML frontmatter 描述元数据。这个选择的考量：

| 优势 | 说明 |
|------|------|
| 人类可读 | 用户可以直接编辑、审查、删除记忆文件 |
| Git 友好 | 可以纳入版本控制、团队共享 |
| Agent 可操作 | Agent 可以用标准的文件读写工具操作记忆 |
| 无运行时依赖 | 不需要数据库、向量引擎等外部服务 |

### 2.2 Index 和 Content 分离

```
~/.qwen/projects/<sanitized-path>/memory/
├── MEMORY.md              ← 轻量索引，始终加载到 system prompt
├── user_role.md           ← 完整记忆内容，按需检索
├── feedback_testing.md
├── project_deadlines.md
└── reference_dashboards.md
```

**MEMORY.md**（索引）的作用：
- 始终在 system prompt 中，告诉 Agent "你知道哪些事"
- 每行一条，限制 200 行 / 25KB，不会显著占用 context window
- Agent 根据索引判断是否需要读取完整记忆

**Topic Files**（完整内容）的作用：
- 按需通过 recall 机制检索
- 支持多条 entry，每条有 summary + why + howToApply 结构
- frontmatter 包含类型、名称、描述

### 2.3 四种记忆类型

| 类型 | 目的 | 保存时机 | 使用时机 |
|------|------|---------|---------|
| `user` | 用户画像（角色、技能、偏好） | 了解到用户信息时 | 需要针对性回答时 |
| `feedback` | 行为指导（纠正 + 确认） | 用户纠正或确认行为时 | 避免重复犯错 |
| `project` | 项目动态（进度、决策、约束） | 了解项目上下文时 | 理解任务背景 |
| `reference` | 资源定位（外部系统指针） | 了解外部资源时 | 定位信息来源 |

### 2.4 结构化 Entry 格式

每条记忆不只是一个文本片段，而是有结构的：

```markdown
---
name: integration-tests-no-mocks
description: Integration tests must use real database, never mocks
metadata:
  type: feedback
---

Integration tests must hit a real database, not mocks.

**Why:** Prior incident where mock/prod divergence masked a broken migration.

**How to apply:** When writing or reviewing integration tests in this repo, always configure a real database connection. If a test file uses jest.mock() on database modules, flag it for replacement.
```

`Why` + `How to apply` 的设计让 Agent 能**判断边界情况**，而不是盲目遵守规则。

## 3. 核心数据流

```
┌──────────────────────────────────────────────────────────────────┐
│                         User Query                                │
│                              │                                    │
│                              ▼                                    │
│  ┌─────────────────────────────────────────────┐                 │
│  │           MemoryManager (Facade)             │                 │
│  │                                              │                 │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │                 │
│  │  │ Extract  │  │  Recall  │  │  Dream   │  │                 │
│  │  │(写入记忆)│  │(检索记忆)│  │(整理记忆)│  │                 │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  │                 │
│  │       │              │              │        │                 │
│  └───────┼──────────────┼──────────────┼────────┘                │
│          │              │              │                          │
│          ▼              ▼              ▼                          │
│  ┌──────────────────────────────────────────────┐                │
│  │             Disk Storage (Markdown)           │                │
│  │  MEMORY.md | topic files | meta.json | cursor │                │
│  └──────────────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────────────┘
```

### 3.1 Extract（提取记忆）

**触发时机**：每次用户消息处理完成后

**流程**：
1. 通过 cursor 确定本次会话中尚未处理的消息
2. 如果有新的 user messages，启动 extraction agent（独立的 sub-agent）
3. Agent 分析对话，决定是否有值得保存的信息
4. 写入对应的 topic file，更新索引

**设计要点**：
- **增量处理**：通过 `extract-cursor.json` 追踪 `processedOffset`，每次只分析新消息
- **Per-project 队列**：同一项目同时只允许一个 extraction 运行
- **Latest-wins 语义**：如果新请求入队时已有排队中的请求，后者覆盖前者

### 3.2 Recall（检索记忆）

**触发时机**：构建 system prompt 时，需要为当前查询注入相关记忆

**两层策略**：

```
Query → Model-Based Selection (primary)
             │
             │ 失败/超时
             ▼
        Heuristic Fallback (keyword matching)
```

**Model-Based Selection**：
- 只向模型发送 metadata（类型、路径、描述），不发送完整内容
- 模型返回 `{ selected_memories: string[] }` 的 JSON
- 30 秒超时保护
- 最多返回 5 个相关记忆

**Heuristic Fallback**：
- 对 query 做分词
- 在每个记忆的 type + title + description + body 中匹配
- 按 overlap 打分，加上 type-keyword 加权

**Recall 输出**：
- 选中的记忆内容格式化为 Markdown
- 每个记忆的 body 截断至 1200 字符
- 附带 freshness 标记（告诉 Agent 记忆的时效性）

### 3.3 Dream（记忆整理/去重）

**触发时机**：满足以下所有条件时自动运行

| 条件 | 默认值 |
|------|--------|
| 距上次 dream 至少 N 小时 | 24 小时 |
| 至少累积 N 个 session | 5 个 |
| 无其他进程正在 dream | filesystem lock |
| session scan 间隔 | 10 分钟 |

**流程**：
1. 启动 dream agent（独立 sub-agent）
2. Agent 读取所有 topic files
3. 合并重复、更新过期、删除矛盾的记忆
4. 重建索引

**设计类比**：类似人类睡眠时的记忆巩固——在后台整理白天（多个 session）积累的碎片化记忆。

### 3.4 Forget（遗忘机制）

**触发时机**：用户显式要求删除某些记忆

**流程**：
1. 用户描述想删除的内容
2. Model-based selection 找到匹配的 entries（使用主模型，非 fast model，避免误删）
3. 展示候选列表给用户确认
4. 执行删除：per-entry 粒度，只删匹配项，不删整个文件

## 4. 存储路径与 Git Worktree 处理

### 4.1 两种存储模式

| 模式 | 路径 | 适用场景 |
|------|------|---------|
| Global（默认） | `~/.qwen/projects/<sanitized_path>/memory/` | 个人开发 |
| Local | `<project>/.qwen/memory/` | 团队共享（通过 `QWEN_CODE_MEMORY_LOCAL=1`） |

### 4.2 Worktree 感知

记忆系统需要解决一个关键问题：**多个 git worktree 应该共享同一份记忆**。

```
main-checkout/        → 记忆存储在 ~/.qwen/projects/...main-checkout.../memory/
├── .git              → real git dir

feature-worktree/     → 解析 .git 文件找到 commondir → 指向 main-checkout
├── .git (file)       → gitdir: /path/to/main-checkout/.git/worktrees/feature
```

`getAutoMemoryRoot()` 通过解析 `.git` 文件和 `commondir` 文件，将所有 worktree 映射回同一个 canonical root，确保记忆不会因为分支切换而碎片化。

### 4.3 辅助文件

```
~/.qwen/projects/<path>/
├── meta.json            ← 元数据（schema version, 时间戳, session 跟踪）
├── extract-cursor.json  ← 增量提取游标
├── consolidation.lock   ← Dream 进程锁（PID-based, 1h stale）
└── memory/
    ├── MEMORY.md
    └── *.md
```

## 5. Prompt 注入策略

记忆系统通过 `appendManagedAutoMemoryToUserMemory()` 将以下内容注入 system prompt：

1. **完整的使用说明**：告诉 Agent 如何读写记忆（类型定义、格式要求、何时保存、何时检索）
2. **当前索引内容**：MEMORY.md 的内容（最多 200 行）
3. **反模式列表**：不应该保存的内容（代码模式、git 历史、调试方案等）
4. **验证规则**：使用记忆前必须验证文件/函数是否仍然存在

这个 prompt 约 3-4K tokens，是 system prompt 的一部分，在每次对话中都包含。

## 6. 并发与状态管理

### 6.1 任务调度

MemoryManager 内部管理一个 in-flight task map：

```typescript
// 每个 project 最多一个 extract 在执行
private extractQueues = new Map<string, { running: boolean, pending?: Request }>()

// dream 有全局锁 + 文件锁双重保护
private dreamInFlight: Promise<void> | null = null
```

### 6.2 取消机制

- Extract：短时间运行，不支持取消
- Dream：通过 AbortController 支持取消，取消后跳过 index rebuild
- Recall 中的 model selection：30 秒超时 + caller abort signal，通过 `AbortSignal.any()` 组合

### 6.3 Subscriber Pattern

```typescript
type Listener = (event: MemoryTaskEvent) => void;
subscribe(listener: Listener, filter?: { type: 'dream' | 'extract' }): () => void
```

兼容 React `useSyncExternalStore`，用于 UI 层监听记忆操作状态。

## 7. 设计经验与教训

### 7.1 为什么选择 Agent-Based Mutation

最初的设计考虑过"规则引擎"方式提取记忆（关键词匹配、模板填充），但实际效果差——记忆的价值在于**判断什么值得记住**，这本身需要理解语义。

最终选择 forked sub-agent：
- Extract 和 Dream 都启动独立的 LLM session
- 主 agent loop 不阻塞，保持响应性
- 可以用 fast model 降低成本

### 7.2 Index 的 200 行限制

早期没有限制，导致大量记忆场景下 system prompt 膨胀 10K+ tokens。200 行 / 25KB 是经验值——超过这个量，大多数 entry 对当前查询无关，不如靠 recall 按需加载。

### 7.3 Dual-Strategy Recall 的必要性

纯 model-based recall 在以下场景失败：
- API 超时（网络抖动）
- Rate limit（高并发时）
- 模型输出格式不合规（JSON parse fail）

Heuristic fallback 保证了记忆系统的可用性不依赖于外部 API 调用的成功。

### 7.4 Dream 的门控条件

早期 dream 触发过于频繁，导致：
- 多个 session 同时 dream 造成文件冲突
- 小量记忆做 consolidation 没有实际收益
- 浪费 LLM 调用

最终的多条件门控（时间 + session count + lock + throttle）有效解决了这些问题。

### 7.5 Forget 使用主模型的原因

Fast model 在语义匹配上准确度不够，误删风险高。记忆删除是不可逆操作，宁可慢一点、贵一点，也要保证准确。

## 8. 与 Compression 的关系

记忆系统和压缩系统是互补的：

| 维度 | Memory | Compression |
|------|--------|-------------|
| 时间跨度 | 跨会话持久化 | 单会话内 |
| 信息类型 | 用户/项目/偏好等元信息 | 对话历史的摘要 |
| 触发方式 | 后台自动 + 用户请求 | token 阈值触发 |
| 存储 | 磁盘文件 | 内存中的 history 数组 |
| 可逆性 | 可删除 | 不可逆（压缩后原始 history 丢失） |

关键区别：**Compression 处理的是"对话太长怎么缩短"，Memory 处理的是"下次对话如何记住上次的事"**。

## 9. 相关代码索引

| 文件 | 说明 |
|------|------|
| `packages/core/src/memory/manager.ts` | MemoryManager 类，facade 入口 |
| `packages/core/src/memory/store.ts` | 磁盘目录 scaffold |
| `packages/core/src/memory/types.ts` | 类型定义和 schema version |
| `packages/core/src/memory/recall.ts` | 记忆检索（dual-strategy） |
| `packages/core/src/memory/relevanceSelector.ts` | Model-based 相关性选择 |
| `packages/core/src/memory/extract.ts` | 增量记忆提取 |
| `packages/core/src/memory/extractionAgentPlanner.ts` | Extraction sub-agent |
| `packages/core/src/memory/dream.ts` | 记忆整理/去重 |
| `packages/core/src/memory/dreamAgentPlanner.ts` | Dream sub-agent |
| `packages/core/src/memory/forget.ts` | 记忆删除 |
| `packages/core/src/memory/entries.ts` | Entry 解析/渲染 |
| `packages/core/src/memory/indexer.ts` | MEMORY.md 索引构建 |
| `packages/core/src/memory/scan.ts` | Topic 文件扫描 |
| `packages/core/src/memory/paths.ts` | 路径管理 + worktree 感知 |
| `packages/core/src/memory/prompt.ts` | System prompt 注入 |
| `packages/core/src/memory/const.ts` | 常量定义 |
| `packages/core/src/memory/memoryAge.ts` | 记忆时效性计算 |

## 10. 对 Claude Code 的对比参考

Claude Code 的记忆系统（`/remember`）与此设计高度相似：

| 维度 | Claude Code | Qwen Code |
|------|------------|-----------|
| 存储位置 | `~/.claude/projects/<path>/memory/` | `~/.qwen/projects/<path>/memory/` |
| 索引文件 | `MEMORY.md` | `MEMORY.md` |
| 记忆类型 | user, feedback, project, reference | user, feedback, project, reference |
| Entry 结构 | frontmatter + body | frontmatter + body (Why + How to apply) |
| Recall 策略 | model-based + heuristic | model-based + heuristic |
| Dream/Consolidation | 类似（定期整理） | 24h + 5 sessions 门控 |
| Forget | model-based selection | model-based (主模型) |
| Worktree 处理 | commondir 解析 | commondir 解析 |

主要差异在于 Qwen Code 增加了 `Why` + `How to apply` 结构，以及更严格的 dream 门控条件。
