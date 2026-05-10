# 11 — 实体模型与层级关系

> [← 上一篇：TUI 兼容性](./10-tui-compatibility.md) · [下一篇：远端 CLI 模式 →](./12-remote-cli-mode.md)

> 把前面 13 章散落在各处的实体（Tenant / Workspace / Session / Task / Tool / Client）汇总到一张层级图，定义它们的关系、资源所有权、生命周期、跨边界约束。

> **核心实体层级**（[§02 §2](./02-architectural-decisions.md#2-状态进程模型) "1 daemon = 1 session"模型下）：
>
> ```
> Tenant → Workspace → Daemon Instance（≡ Session）→ Background Task → Tool Execution
> ```
>
> - **Session ≡ Daemon Instance**（同义合并）—— 不是 daemon 内的子单元
> - 资源所有权：LSP / MCP / FileReadCache 全部 per-daemon
> - 跨 session 共享 = 跨 daemon 共享 = **不允许**（process-level 隔离自然成立）
> - **多 client 共 daemon = 共 session**（live collaboration）

## 一、TL;DR — 5 层 hierarchy + 认证侧 + 横切层

### 认证侧（不属于 hierarchy）

```
External User (自然人)            ← daemon 不可见，由外部 IDP / 本地账户管理
       │ 持有
       ▼
Token (bearer)                    ← daemon 凭此识别"哪个 tenant"
       │ 1:1 属于
       ▼
Tenant (进入下方 hierarchy)
```

- 1 user 可持有多 token（laptop / CI / SDK / 不同设备各一）
- 1 token 仅属一 tenant（清晰归属）
- "1 user 属多 tenant" 是外部 IDP 的事实，**不在 daemon 实体模型内**
- External Phase 4 加 OIDC 时把 `oidc_subject` 写到 `tokens` 表，但仍不引入 user 实体

### Daemon 实体 hierarchy（5 层）

```
┌─ Layer 1: Tenant (租户 = 计费/隔离单位)            ───┐
│   - 实体：个人 / 团队 / 部门 / 公司                   │
│   - 持有 Token 集合 / Workspace allowlist             │
│   - quota / audit / sandbox tier 在此层               │
│                                                       │
├─ Layer 2: Workspace (工作区 = 项目目录)               │
│   - 1:1 对应物理 directory (git repo)                 │
│   - LSP / MCP / auth credentials per-workspace        │
│                                                       │
├─ Layer 3: Session (会话 = LLM 对话上下文)             │
│   - Transcript / FileReadCache / 当前 model           │
│   - 串行 prompt FIFO + 多 client fan-out              │
│                                                       │
├─ Layer 4: Background Task (kind framework)           │
│   - kind=agent/shell/monitor/dream 4 消费者           │
│                                                       │
└─ Layer 5: Tool Execution (Bash/Edit/Read/...)      ───┘
```

### 横切层（Cross-cutting）

```
Client subscription (TUI/SDK/WebUI/IM) — 订阅 1+ session 的 SSE 长连接
Permission decisions — tenant + workspace 双键
Provider/Skill/Model registry — daemon 全局只读单例
```

## 二、5 层详解

> 关于 User / Token：不在 hierarchy 中，详见 [§一 认证侧](#一tldr--5-层-hierarchy--认证侧--横切层)。daemon 内的代码只引用 Token 和 TenantId，不存在 User 类型。

### Layer 1: Tenant（租户）

**定义**：计费 / 隔离 / 配额单位。可以是个人、团队、部门、公司。

**持有的资源**：

| 资源 | 描述 |
|---|---|
| Token 集合 | 多个 token，每个 token 一对一属于本 tenant |
| Workspace allowlist | glob 模式（如 `ws-alice-*`）|
| Quota | LLM tokens / tool calls / concurrent sessions |
| Audit log | 本 tenant 所有操作记录（SQLite per-tenant `tenant_id` WHERE）|
| Sandbox tier | none / os-user / namespace / container（[§09](./09-multi-tenancy-and-sandbox.md)）|
| Default settings | tenants/&lt;id&gt;.json（§16 配置 cascade）|
| Provider config | API keys / OAuth tokens（per-tenant）|

**关系**：
- 1 tenant 拥有 N token（每 token 一对一属于本 tenant）
- 1 tenant 拥有 N workspace（[§16 §三 WorkspaceAccess](./16-orchestrator-multi-tenancy.md) 不跨 tenant 共享 workspace）

**External Phase 1 加入此层** —— Stage 1-3 单租户模式下相当于"虚拟单 tenant"。

### Layer 2: Workspace（工作区）

**定义**：1:1 对应一个物理 directory（通常是 git repo 或项目根目录）。

**持有的资源**（在 1 daemon = 1 workspace 模型下，下列资源等价于 daemon-instance scope）：

| 资源 | 决策依据 |
|---|---|
| LSP server (1 个) | per-daemon（绑定此 workspace · §02 §3）|
| MCP servers (N 个) | per-daemon（决策 §3）|
| Auth credentials | per-daemon 隔离（§02 §6.1）—— 不同 daemon 可用不同 GitHub token |
| `.qwen/settings.json` | workspace 层 config（§16 §配置 cascade 第 2 层）|
| `permission_decisions` workspace scope | `alwaysAllow: 'Bash(npm test)'` 类决策 |
| WorkspaceID | unguessable random（§05.1.A4）|
| Directory 物理路径 | absolute path，安全校验通过 realpath（§05.2）|

**关系**：
- 1 tenant 拥有 N workspace（Tenant 在 [§16](./16-orchestrator-multi-tenancy.md) External orchestrator 层）
- **跨 tenant 不共享 workspace**——同一物理 directory 在不同 tenant 下是不同 workspace 实例（独立 LSP / MCP / settings）
- **1 daemon = 1 workspace = 1 session**（决策 §2）；多 session 通过 orchestrator spawn 多 daemon 实现，每 daemon 自己的 workspace 绑定

**生命周期**：Lazy 创建（第一次访问 directory 时）+ 显式 `dispose()` 销毁。详见  `Instance.provide` 模式。

### Layer 3: Session（会话）

**定义**：一个 LLM 对话上下文 + 关联的所有运行时状态。

**持有的资源**：

| 资源 | 引用 |
|---|---|
| Session ID | ≥256 bit unguessable random（§05.1.A4）|
| Transcript | JSONL 持久化（PR#3739 transcript-first fork resume）|
| FileReadCache | per-daemon（决策 §4 · 在 1 daemon = 1 session 下天然 session 私有）|
| 当前 model / mode / config | 通过 ACP `setSessionModel` / `setSessionMode` 设置 |
| `taskQueue: Promise` | FIFO 串行 prompt（决策 §6）|
| `subscribers: Set<ClientSubscription>` | 多 client fan-out 订阅集 |
| Background tasks | 4 kinds 状态（决策 §3 / §六.5）|
| Permission decisions session scope | session 内一次性的 `alwaysAllow` |

**关系**：
- 1 workspace 通常 1 session（'single' scope 默认）；可通过 `LoadSession` / fork 增加
- 1 session 被 N client 订阅（§02 fan-out）
- 1 session 同时只能有 1 active prompt（FIFO 队列其余请求挂起）

**生命周期**：
- 创建：`POST /session`（决策 §1 `single` 下若已存在则 attach）
- 销毁：显式 `DELETE /session/:id`、TTL（如 7 天空闲）、daemon 重启时根据持久化 transcript 决定 resume

### Layer 4: Background Task（后台任务）

**定义**：在 session 上下文中运行的后台任务，4 种 kind（PR#3471/3488/3642/3791/3836）：

| Kind | 来源 PR | 描述 |
|---|---|---|
| `agent` | PR#3471 / PR#3488 | Subagent fork（含 Coordinator/Swarm）|
| `shell` | PR#3642 | Background shell 跑长跑命令 |
| `monitor` | PR#3684 / PR#3791 | Event monitor（spawn 命令 + token-bucket 节流）|
| `dream` | PR#3836 | Auto-memory consolidation |

**统一调度面**：`BackgroundTasksDialog`（PR#3488/3720/3791/3836）——agent/shell/monitor/dream 共用同一 pill + dialog UI。

**关系**：
- 1 session 拥有 N task（同 session 内可并发多种 kind 任务）
- task 之间通过 `task_stop` / `send_message` 协议交互（PR#3471 暴露给 LLM）
- task 与 client 通过 SSE 流通信（每 task 状态变化广播给 session 所有 subscribers）

**生命周期**：
- 创建：LLM 调用 Tool（如 `agent.fork()` / `shell.spawn(background=true)` / `monitor.start()` / 自动 dream）
- 销毁：task 自身完成 / 显式 `task_stop` 工具 / session 关闭

### Layer 5: Tool Execution（工具调用）

**定义**：每次 LLM 决定调一个 tool 时的瞬时执行上下文。

**持有的资源**：
- Tool 名称 + 参数（验证通过 ACP zod schema）
- 执行上下文：daemon 进程本身就是 session ctx（决策 §2，无需 ALS Instance ctx；如未来扩展到 multi-session 才需，详见 §04 §三）
- Permission flow 决策（PR#3723 复用，daemon 是第 4-5 mode）
- Sandbox handle（如果是 shell 类工具，[§09 §二 ShellSandbox interface](./09-multi-tenancy-and-sandbox.md#二shellsandbox-抽象接口)）

**关系**：
- 1 session 顺序执行 N 个 tool call（不并发）
- tool call 可触发 background task 创建（如 `agent.fork()`）
- tool call 可触发 child process（Bash 通过 sandbox）

**不持有持久状态**——tool call 结束后状态写回 session transcript 即销毁。

## 三、关系类型矩阵

> User ↔ Token / User ↔ Tenant 是外部 IDP 事实，不在表内（详见 [§一 认证侧](#一tldr--5-层-hierarchy--认证侧--横切层)）。

| 关系 | 类型 | 说明 |
|---|---|---|
| Token ↔ Tenant | N:1 | 一 token 仅属一 tenant（认证凭证，不是 hierarchy）|
| Tenant ↔ Workspace | 1:N | tenant 拥有多 workspace |
| **Tenant ↔ Workspace 跨 tenant 共享** | ❌ **不允许** | [§16 §三 WorkspaceAccess](./16-orchestrator-multi-tenancy.md) + 同 directory 在不同 tenant 下是不同 workspace 实例 |
| **Daemon Instance ↔ Workspace** | 1:1 | 决策 §2：每 daemon 启动时绑定唯一 workspace |
| **Daemon Instance ↔ Session** | 1:1 | 决策 §2：每 daemon 承载唯一 session（≡ Daemon Instance）|
| Workspace ↔ Session | 1:N（through orchestrator）| 同 workspace 多 session = orchestrator spawn 多 daemon，每 daemon 自己 1 session |
| Session ↔ Task | 1:N | 一 session 起多 background task |
| Session ↔ Client | 1:N | 一 session 被多 client 订阅（live collaboration）|
| Client ↔ Session | 1:N | 一 client 可同时观察多 session（连多个 daemon URL）|
| Session ↔ active prompt | 1:1 | 同 session 一次仅 1 active prompt（FIFO 决策 §6）|
| Tool call ↔ Session | N:1 | 一 session 顺序执行多个 tool |
| Tool call ↔ Sandbox | 1:1 | 每 shell 类 tool call 一个 sandbox handle |

## 四、资源所有权层级表

| 资源 | 所有者层级 | 引用 / PR |
|---|---|---|
| Token | Tenant（External orchestrator）| §05 |
| Quota tracker | **Tenant**（在 orchestrator）| [§16](./16-orchestrator-multi-tenancy.md#二orchestrator-4-件事) |
| Audit log | **Tenant**（在 orchestrator）| [§16](./16-orchestrator-multi-tenancy.md#二orchestrator-4-件事) |
| Sandbox factory | **Daemon Instance** | [§09 §四](./09-multi-tenancy-and-sandbox.md#四sandbox-选择逻辑) |
| LSP server | **Daemon Instance**（per-daemon · 在 1 daemon = 1 workspace 模型下等价 per-workspace）| §02 §3 |
| MCP server | **Daemon Instance**（per-daemon · 决策 §3）| §02 §1 |
| Auth credentials（API key 等）| **Daemon Instance**（绑定 workspace）| §02 §6.1 |
| `.qwen/settings.json` | **Daemon Instance**（绑定 workspace）| [§11 §八 配置 Cascade](#八配置-cascade4-层--5-层-with-tenant) |
| `permission_decisions` | **Daemon Instance**（per-daemon · 决策 §4）| §05 §4 / §05.3 |
| Skill registry | **Daemon Instance** + path-conditional 激活 | §02 §5 |
| Provider registry | **Daemon Instance** | §02 §6 |
| Session transcript | **Daemon Instance**（JSONL · per-daemon 一份）| §04 |
| FileReadCache | **Daemon Instance**（per-daemon · 决策 §4）| §02 §2 |
| Subagent / Shell / Monitor / Dream task | **Daemon Instance** 内 task | §六.1-§六.6 (subagent-display) |
| Tool call execution context | **Daemon Instance**（daemon 进程本身就是 session ctx，无需 ALS）| §04 |
| Theme / TUI 设置 | **Client**（不上 daemon）| §10 §4.4 |

## 五、生命周期与创建/销毁

> User 不在表内（外部 IDP 管理）。

| 实体 | 创建时机 | 销毁时机 | 持久化？ |
|---|---|---|---|
| Token | 显式 admin API / settings.json | revoke / TTL 过期 | External Phase 1+ SQLite（之前 settings.json）|
| Tenant | settings 加 entry / `qwen tenant create` | settings 移除 | SQLite + tenants/&lt;id&gt;.json |
| Workspace | **Lazy**：第一次访问 directory 时 | 显式 `Workspace.dispose()` / daemon 重启 | SQLite + 内存 Map |
| Session | 显式 `POST /session` | TTL（默认 7 天空闲）/ 显式 DELETE | JSONL（transcript）+ SQLite（meta）|
| Background task | LLM tool 调用触发 | task 完成 / `task_stop` / session 关闭 | task entry SQLite，progress 不持久化 |
| Client subscription | TUI/SDK 连接 SSE/WS | client 断开 / session 销毁 | 内存 Set |
| Tool call | LLM 决定 tool_use | tool result 返回后立即销毁 | 写入 session transcript |

## 六、跨 Tenant 边界的硬约束

**绝对不能跨 tenant 共享**（来自 §05 防御）：

- ✗ Auth credentials
- ✗ API keys
- ✗ Sessions / transcripts
- ✗ Permission decisions
- ✗ Audit log entries
- ✗ Quota counters

**仅在同 workspace 共享**：

- ✓ LSP server
- ✓ MCP server（决策 §3）

**仅在同 session 内共享**：

- ✓ FileReadCache（决策 §4）
- ✓ Active prompt taskQueue
- ✓ Background tasks 状态

**daemon-global 只读单例**（不可变 + 跨 tenant 共享 OK）：

- ✓ Provider registry（DashScope / Anthropic / OpenAI 等的能力描述）
- ✓ Skill registry（path-conditional 激活，§02 §5）
- ✓ Model registry（具体模型名/参数）

## 七、与决策 §1 sessionScope 的协调

> 在 1 daemon = 1 workspace = 1 session 模型下，sessionScope 决策**移到 External orchestrator 层**（[§16](./16-orchestrator-multi-tenancy.md)），由 orchestrator 决定如何把 session 请求路由到 daemon 实例：

```
sessionScope: 'single' (默认)
  └─ 同 workspace 路由到同一 daemon instance（已存在则 attach，否则 spawn）
     Alice 的 CLI + IDE + WebUI → 都连同一 daemon 看 sess-foo
     体现 "live collaboration"
     daemon-instance scope: 1 daemon = 1 workspace = 1 session

sessionScope: 'thread'
  └─ 每 HTTP request spawn 新 daemon instance（多租户严格隔离用此）
     N requests = N daemons = N sessions
     用于多租户 SaaS

sessionScope: 'user'
  └─ 同 user-id 跨 channel 路由到同一 daemon
     用户手机微信 + 电脑 SDK → 同 user-id 共享 daemon
     daemon-instance scope: 1 daemon = 1 workspace = 1 session per user
```

## 八、配置 Cascade（4 层 → 5 层 with Tenant）

引入 Tenant 层后的完整 cascade（§16 配置文档详细展开）：

```
Daemon-global (/etc/qwen/daemon.json)
       ↓ override
Tenant (/etc/qwen/tenants/<id>.json)
       ↓ override
Workspace (<dir>/.qwen/settings.json)
       ↓ override
Session (runtime SetSessionConfigOptionRequest)
```

**override 规则**：
- session > workspace > tenant > daemon-global
- 不可写权限 cascade 控制（如 quota 必须 daemon-global 写，session 不能扩大）

## 九、ER 图（数据库视角）

简化 ER 图（详细 schema 见 [§16 持久化栈](./16-orchestrator-multi-tenancy.md)（持久层））：

```
┌──────────────┐
│ tenants      │
├──────────────┤
│ id (PK)      │
│ name         │
│ created_at   │
│ deleted_at   │
└──────┬───────┘
       │ 1:N
       ▼
┌──────────────┐       ┌──────────────────┐
│ tokens       │       │ tenant_quotas    │
├──────────────┤       ├──────────────────┤
│ id (PK)      │       │ tenant_id (PK→)  │
│ tenant_id (FK)│       │ llm_tokens_used  │
│ secret_hash  │       │ tool_calls_used  │
│ scope        │       │ window_start     │
│ expires_at   │       └──────────────────┘
└──────────────┘
       │
       │ tenant 1:N
       ▼
┌──────────────────┐
│ workspaces       │       ┌──────────────────────┐
├──────────────────┤       │ permission_decisions  │
│ id (PK)          │       ├──────────────────────┤
│ tenant_id (FK)   │←──────│ tenant_id (PK→)       │
│ directory        │       │ workspace_id (PK→)    │
│ created_at       │       │ pattern (PK)          │
│ disposed_at      │       │ scope                 │
└────────┬─────────┘       │ decision              │
         │ 1:N             │ expires_at            │
         ▼                  └──────────────────────┘
┌──────────────────┐
│ sessions         │       ┌──────────────────────┐
├──────────────────┤       │ background_tasks      │
│ id (PK)          │       ├──────────────────────┤
│ workspace_id (FK)│←──────│ id (PK)               │
│ created_at       │       │ session_id (FK)       │
│ archived_at      │       │ kind                  │
│ transcript_path  │ ───→ /var/lib/qwen/&lt;tenant&gt;/transcripts/&lt;sess-id&gt;.jsonl
└──────┬───────────┘       │ status                │
       │                    │ created_at            │
       │ 1:N                │ terminated_at         │
       ▼                    └──────────────────────┘
┌──────────────────┐
│ audit_log        │
├──────────────────┤
│ id (PK auto)     │
│ tenant_id (FK)   │
│ timestamp        │
│ method / path    │
│ workspace_id     │
│ session_id       │
│ tool_name        │
│ decision         │
└──────────────────┘
```

**注意**：
- Transcript 不入 RDBMS（存 JSONL 文件，§16 详细说明）—— RDBMS 只存 path 引用
- FileReadCache 完全在内存（per-daemon · daemon 退出释放）
- daemon 进程本身就是 session ctx（决策 §2 · 无需 AsyncLocalStorage Instance）
- LSP server / MCP server 子进程完全在内存（不持久化）

## 十、与各章决策的对照

| 章节 | 决策 | 对应实体层 |
|---|---|---|
| §02 §1 | 默认共享同一 daemon instance；scope 由 orchestrator 路由 | Daemon Instance ≡ Session |
| §02 §2 | **1 Daemon Instance = 1 Session** | 每 daemon 一个 V8 isolate；多 daemon 由 orchestrator 管 |
| §02 §3 | MCP per-daemon | MCP 资源所有权 = Daemon Instance |
| §02 §4 | FileReadCache per-daemon | FileReadCache 资源所有权 = Daemon Instance |
| §02 §5 | Permission flow 第 4-5 mode | tool call 层 + tenant + workspace 双键决策 |
| §02 §6 | 同 daemon 串行 + fan-out 多 client | Daemon.taskQueue + subscribers Set |
| §02 §7 | Mode A / Mode B 双部署模式 | Daemon Instance 形态：含 TUI / 不含 |
| §04 | 不需要 ALS Instance ctx（daemon 进程本身就是 session ctx）| tool call 执行上下文 = daemon-global |
| §09 §二 | ShellSandbox interface | Tool call 层调用 |
| §09 §五 | 远程 sandbox（daemon 与 shell 不同机）| External Phase 3+ |
| §16 | Tenant 抽象 + AuthN/AuthZ + Quota + Audit | Orchestrator 层 |
| §05 | 17 个攻击向量 + 5 层防御 | 跨 tenant 硬约束 + 同 session 隔离 |
| §10 | TUI 多 client 共 session | Layer 3 多订阅者 |

## 十一、典型场景的实体路径

### 11.1 单用户开发场景（Stage 1-3）

```
Tenant 'default' (Stage 1-3 虚拟单 tenant)
└─ Workspace /work/repo-a
   └─ Session sess-foo
      └─ active prompt: "重构 src/foo.ts"
         └─ Tool: Edit (path: src/foo.ts)
            └─ AsyncLocalStorage: { workspaceId, sessionId, cwd }
            └─ Sandbox: NoSandbox (单租户)
```

### 11.2 多 client 协作（Stage 2 起）

```
Tenant alice
└─ Workspace /work/repo-a
   └─ Session sess-foo (3 个 subscribers)
      ├─ TUI Client A (CLI 终端 1) ─┐
      ├─ TUI Client B (CLI 终端 2)   ├─ 都看到同一 message_part 流
      └─ Web UI Client                 ┘
```

### 11.3 多租户 SaaS（External Reference / [§16](./16-orchestrator-multi-tenancy.md)）

```
Tenant alice                       Tenant bob
├─ Workspace ws-alice-A              ├─ Workspace ws-bob-only
│   └─ Session sess-A1                │   └─ Session sess-B1
│       └─ MCP github (alice token)   │       └─ MCP github (bob token)
└─ Workspace ws-alice-B              └─ Workspace ws-bob-other
    └─ Session sess-A2                    └─ Session sess-B2

跨 tenant：
✗ alice 不能访问 ws-bob-only
✗ alice 的 MCP github (alice token) 不能被 bob 复用
✓ daemon-global Skill registry 共享（不可变）
```

### 11.4 跨 channel 续行（'user' scope）

外部 user Alice 通过两个 token 接入同一 tenant，daemon 用 token→tenant 映射 + 'user' scope 路由到同一 session：

```
Token "alice-mobile" via Telegram ─┐
                                    ├─→ Tenant alice → Session sess-shared
Token "alice-laptop" via SDK     ──┘     (transcript-first fork resume PR#3739)
```

**注意**：daemon 不知道这两个 token 是"同一个人"——'user' scope 的实现是 token 上挂的 `userScopeKey` 属性（External Phase 4 OIDC 场景下可由 `oidc_subject` 提供），而非外部 User 实体。

## 十二、一句话总结

**Qwen daemon 实体模型 = 5 层 hierarchy（Tenant → Workspace → Session → Background Task → Tool Execution）+ 1 横切层（Client subscription）+ 认证侧 sidebar（External User → Token → Tenant，user 不在 daemon 内）。在决策 §2 "1 daemon = 1 workspace = 1 session" 模型下，中间三层（Workspace / Session / Daemon Instance）合并为同一 process boundary。每层有清晰的资源所有权（Tenant 持 token+quota+audit 在 External orchestrator / Daemon Instance 持 LSP+MCP+auth+transcript+FileReadCache+session state / Task 持 4 kinds 状态 / Tool call 瞬时上下文 = daemon 进程本身）。跨 tenant 边界硬隔离 = 跨 daemon 进程边界天然隔离（OS 级），同 daemon 内多 client 订阅 fan-out + 串行 prompt + 任意 client 应答 permission（决策 §1+§6 启用）。配置 cascade 4 层（daemon-global → tenant → workspace → session）在单 daemon 内多数收缩为 daemon-bound 配置，存储 ER 图清晰区分入库实体（meta + audit + decisions）vs 文件存储（transcript JSONL，per-daemon 一份）vs 内存（subscriptions/cache）。设计哲学：实体模型只描述 daemon 内部能引用 / 持久化 / 拥有 lifecycle 的对象——User 是外部 IDP 概念，Token 是认证凭证而非容器，二者都不算 hierarchy 层。**

---

[← 返回 README](./README.md) · [下一篇：远端 CLI 模式 →](./12-remote-cli-mode.md)
