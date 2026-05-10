# 02 — 7 个架构决策

> [← 上一篇：架构总览](./01-overview.md) · [下一篇：HTTP API 设计 →](./03-http-api.md)

> [SDK / ACP / Daemon 架构 Deep-Dive §七.3](../sdk-acp-daemon-architecture-deep-dive.md#73-真正的难点架构决策) 列出"真正的难点是几个架构决策——而不是代码量"。本文为每个决策点给出明确选择 + 理由。

## 1. session 是否跨 client 共享

**问题**：用户在手机微信上发了一条消息让 agent 跑研究，回到电脑想继续——同一个 session 还是新 session？多个 client（CLI + VSCode + WebUI）同时打开同一个项目，互相能看到对方的 prompt 吗？

### 选择

**默认跨 client 共享同一 daemon instance**——多 client（CLI + VSCode + WebUI + IM bot）连接到同一 daemon instance 时，自然共享该 daemon 的唯一 session。**Daemon Instance ↔ Session 是 1:1 关系**——session 由 orchestrator 创建/分配 daemon instance 时确定。

| 维度 | 行为 |
|---|---|
| **1 Daemon Instance = 1 Session** | 进程级隔离，无 daemon 内多 session 路由 |
| **多 client 连同一 daemon = 共享该 session** | live collaboration 模型不变（CLI + WebUI + IM 同看 message_part 流） |
| **不同 daemon instance 之间互相不可见** | 跨 daemon 跨 session（process-level 隔离自然成立） |
| **多 session 由 orchestrator 管理** | orchestrator（即原 `qwen serve` HTTP front 角色）spawn / discover / cleanup daemon instances |

scope 概念**移到 orchestrator 层**（不是 daemon 内部）：

| settings | orchestrator 路由策略 | 适用场景 |
|---|---|---|
| **`coordinator.sessionScope: 'single'`（默认）** | 同 workspace 路由到同一 daemon instance（已存在则 attach，否则 spawn） | 单用户多 client（CLI + IDE + Web 同时跑） |
| `coordinator.sessionScope: 'user'` | 同 user-id 跨 channel 路由到同一 daemon instance | 手机/电脑续行（含 IM channel）|
| `coordinator.sessionScope: 'thread'` | 每 HTTP request 路由到不同 daemon instance（spawn-on-demand） | 多租户企业部署、严格隔离 |

| settings | 行为 | 适用场景 |
|---|---|---|
| **`daemon.sessionScope: 'single'`（默认）** | **同 workspace 多 client 共享同一 session** | **单用户多 client（CLI + IDE + Web 同时跑）** |
| `daemon.sessionScope: 'user'` | 同 user-id 跨 channel 共享 | 手机/电脑续行（含 IM channel）|
| `daemon.sessionScope: 'thread'` | 每 HTTP request 独立 session | 多租户企业 daemon、严格隔离 |

### 共享 daemon instance 的具体语义

多 client 接入同一 daemon instance（= 同一 session）时：

| 操作 | 行为 |
|---|---|
| Client A 发 prompt（POST /session/:id/prompt）| Client B 通过 SSE 看到完整事件流（message_part / tool_call / tool_result）|
| Client B 同时也想发 prompt | **同 session 串行**——B 的请求挂起等 A 完成（决策 §6）|
| Client A 等待 permission（SSE permission_request）| **任何 client（A 或 B）都能 POST /permission/:requestId 应答** |
| Client A 关闭浏览器 / SDK 退出 | daemon instance 不影响（进程仍存活）；其他 client 继续观察 |
| Client B 通过 LoadSession 加载历史 | 从该 daemon 的本地 transcript JSONL 重建 |
| 所有 client 都断开 + 空闲 N 分钟 | daemon instance 进入 idle，可被 orchestrator 回收（[§15](./15-orchestrator-multi-tenancy.md)）|

这是 **"live collaboration" 模型** —— 与 Google Docs 多人编辑一个文档同构。协作发生在 daemon 进程内，没有跨 session 路由开销。

### 理由

1. **匹配单用户多 client 的真实场景**：典型 Qwen 用户同时开着 CLI + VSCode + 手机微信，都在同一项目工作 —— 共享 session 让所有视图实时同步是更直觉的默认
2. **复用 Channels 已有的 3 种 scope**：`SessionRouter.routingKey()` 已实现 `single/user/thread` 三档
3. **PR#3739 transcript-first fork resume 加成**：一个 session 中断后，任意 client 能 LoadSession 重建并从断点继续
4. **跨 client审批解锁桌面 UX**：CLI 跑命令时弹出权限请求，用户可以在更舒适的 WebUI 上点"批准"——不被 CLI 的 TUI 困住

### 安全 / 隔离边界

**`single` 默认下的隔离层级**：
- ✓ 跨 workspace 隔离（workspace A 的 client 看不到 workspace B 的 session）
- ✓ 跨 daemon 实例隔离（不同 daemon 进程互不可见）
- ⚠️ 同 workspace 跨 client **能互相看见** —— 这是有意设计，不是 bug

**多租户场景必须切到 `thread`**：
```json
{
  "daemon": {
    "sessionScope": "thread",  // 严格隔离
    "auth": {
      "tokens": [
        { "id": "tok-alice", "userId": "alice" },
        { "id": "tok-bob",   "userId": "bob" }
      ]
    }
  }
}
```

### 实现要点

```ts
// daemon settings
{
  "daemon": {
    "sessionScope": "single",                     // 默认 single（共享）
    "perChannelScope": {                          // 不同 channel 用不同 scope
      "http": "single",                            //   SDK / Web UI / IDE 都默认共享
      "vscode": "single",                          //   VSCode workspace 共享
      "telegram": "user",                          //   IM 用户视角共享
      "enterprise": "thread"                       //   多租户企业部署严格隔离
    }
  }
}
```

```ts
// SessionRouter routing key（复用现有逻辑）
single: `${channelName}:__single__`               // 同 channel 共享一个
user:   `${channelName}:${userId}:${workspaceId}` // 同 user 同 workspace 共享
thread: `${channelName}:${requestId}`             // 每请求独立
```

### Client 怎么发现已存在的 session

```http
# 选项 A：明确指定 session ID
POST /session/sess-existing-id/prompt
{ "prompt": [...] }
→ 200 OK

# 选项 B：列举 workspace 内所有 session，让用户选
GET /workspace/:id/sessions
→ 200 OK
{ "sessions": [{ "id": "sess-xxx", "lastActivity": ..., "title": "..." }] }

# 选项 C：自动 attach 到 default session（single scope 下）
POST /session
{ "meta": { "workspaceId": "ws-a", "scope": "single" } }
→ 200 OK
{ "sessionId": "sess-xxx", "attached": true }   // attached=true 表示复用已存在
```

SDK 客户端默认走 C —— 用户感受到的就是"同 workspace 自动共享"，无需手动管理 session ID。

---

## 2. 状态进程模型

**问题**：所有 session 都跑在 daemon 主进程？还是 daemon 路由到子进程，每 session 一个？

### 决策

**1 Daemon Instance = 1 Session = 1 Process**。多 session 通过 orchestrator spawn 多个 daemon 实例实现，**daemon 内部只承载一个 session 的状态**。

```
┌──────────────────────────────────────────────────────┐
│ Orchestrator (qwen-coordinator)                      │
│   - 管理 daemon instance 生命周期                       │
│   - sessionScope 'single'/'user'/'thread' 路由策略     │
│   - 多 daemon instance 注册表（sessionId → port）       │
│   - 多 client 路由到正确 daemon                         │
└──────────────────────┬───────────────────────────────┘
                       │ spawn / route
        ┌──────────────┼──────────────┐
        ↓              ↓              ↓
   ┌────────┐     ┌────────┐     ┌────────┐
   │daemon-1│     │daemon-2│     │daemon-3│
   │(sess-A)│     │(sess-B)│     │(sess-C)│
   │        │     │        │     │        │
   │ 1 V8   │     │ 1 V8   │     │ 1 V8   │
   │ isolate│     │ isolate│     │ isolate│
   │        │     │        │     │        │
   │ + LSP  │     │ + LSP  │     │ + LSP  │
   │ + MCP  │     │ + MCP  │     │ + MCP  │
   │ + cache│     │ + cache│     │ + cache│
   └────────┘     └────────┘     └────────┘
```

### 与 PR#3889 的对应

[PR#3889](https://github.com/QwenLM/qwen-code/pull/3889) 已按此模型实现：
- `qwen serve` HTTP front 承担 **orchestrator 角色**
- spawn `qwen --acp` child per workspace per session → **daemon instance**

### 决策依据

1. **进程级隔离免费** —— 一个 session crash 不影响其他 session（V8 / OS 自动）
2. **避开跨 session 隔离的复杂度** —— 不需要 AsyncLocalStorage Instance ctx / per-session resource managers / 5 PR subagent Config 隔离套路 / Effect-TS LocalContext 等价物
3. **多租户简化** —— 不在 daemon 内做 ACL，每 tenant 启动自己的 daemon instances，orchestrator 层做 ACL
4. **资源生命周期清晰** —— kill daemon = 清理所有 fd / child process / memory（不需要 per-session cleanup hooks）
5. **与 PR#3889 child-process-per-session 实现一致**——~0 改造成本

### 代价权衡

| 维度 | 1 daemon = 1 session（本决策）| 单 daemon 多 session（OpenCode 模式）|
|---|---|---|
| 跨 session 资源共享（LSP/MCP）| ✗ 每 daemon 自己一份 | ✓ 共享，省内存 |
| 隔离强度 | **OS 级 process** | 应用层 AsyncLocalStorage |
| Crash 半径 | **仅 affected session** | 整 daemon 影响所有 session |
| Cold start | **每 session ~1-3s**（V8 isolate）| 启动一次（共用）|
| 内存 baseline | **~30-50MB × N session** | ~50MB / daemon |
| 实现复杂度 | **低**（每 daemon 自给自足）| 高（cross-session 状态管理）|
| 适用规模 | **个人 / 小团队 / 中等 SaaS** | 大规模 SaaS（共享更经济）|

适用边界：单机 N < 50 并发 session 经济性可接受；N ≥ 100 时考虑资源池化或迁移到多 session 模式（详见 [§14 设计对比](./14-single-vs-multi-session-design.md)）。

### 必要的工程约束

| 约束 | 验证手段 |
|---|---|
| daemon 主线程**永不**调用 `process.chdir()` | CI grep audit |
| daemon 顶层 `process.on('uncaughtException')` log + graceful exit（让 orchestrator 重启）| top-level handler |
| Orchestrator 健康监测 daemon instances，超阈值自动 restart | `/health` 端点 + watchdog |
| Daemon instance 启动后**永不接受第二个 session** | session ID 在启动时绑定，多 session 拒绝 |

### 实现要点

- Daemon 进程内**不需要 AsyncLocalStorage Instance ctx**——daemon 进程本身就是 session ctx
- LSP / MCP / FileReadCache 都是 daemon-global singleton（不需要 per-workspace / per-session map）
- session 状态写入本 daemon 的 transcript JSONL（per-daemon 一个文件）
- crash recovery：orchestrator 检测 daemon 崩溃 → 重新 spawn → 新 daemon 用 PR#3739 transcript-first fork resume 重建
- 多 client 仍 attach 到同 daemon（multi-client per daemon）

进程模型详解见 [05-进程模型](./04-process-model.md)。

---

## 3. MCP server 生命周期

**问题**：MCP server 是每 session 启动一个？daemon 全局 fingerprint pool 跨实例共享？还是 per-daemon 边界管理？

### 决策（最终）

**per-daemon MCP state**——每个 daemon instance 持有自己的一套 MCP client 集，daemon 退出时全部清理。**不跨 daemon 实例共享**。1 daemon = 1 session 模型下进程边界天然就是 MCP children 的生命周期边界。

### 共享语义

```
qwen daemon instance 进程（1 session 绑定）
└─ McpState（daemon-global singleton）
    ├─ github MCP client (子进程)
    ├─ filesystem MCP client (子进程)
    └─ status: { github: 'connected', filesystem: 'connected' }

跨 daemon 实例：各自独立的 MCP client 子进程
（如同 user 同 workspace 跑 N 个 daemon → N 套 MCP children；可投资源池化优化，详见 External SaaS 资源池化路径）
```

### 决策依据

1. **MCP server 可能持有 workspace-specific state** —— 例如 `filesystem` MCP 限制只能访问某目录、`git` MCP 持有该项目的 repo path、企业内部数据库 MCP 持有 workspace 特定连接字符串。每 daemon 1 workspace 1 session，state 边界天然清晰
2. **配置可能微小差异** —— 同样 `github` MCP，不同 daemon 可能用不同 token；fingerprint hash 区分会产生意外语义；per-daemon 实例化避免此风险
3. **OpenCode multi-session 工程实践仍可借鉴** —— `Effect.acquireUseRelease` + `concurrency: 'unbounded'` + 单 server 失败不传染（`Effect.catch(() => Effect.void)`）三项工程实践直接复用，仅作用对象从"per-workspace"变为"per-daemon"
4. **与决策 §2 1 daemon = 1 session 协调** —— daemon 内只有 1 session 1 workspace，MCP 自然 daemon-global singleton（无需 Map 路由层）
5. **避免 fingerprint pool 复杂性** —— 不需要"per-server fallback"开关、不需要 sessionId metadata 透传、不需要应用层去重 hash

### 重复 spawn 的代价是否可接受？

per-daemon 的代价：用户在同 user 同 workspace 跑 5 个 daemon（多 session）都用同一个 `github` MCP server → 启 5 个 github MCP 子进程。

| 维度 | 评估 |
|---|---|
| 单个 MCP server 内存 | 50-200MB（轻量 stdio server）|
| 启动开销 | 0.5-2s，但 lazy 初始化（daemon 第一次访问 MCP 才启动）|
| 同时 active daemon 数 | 个人用户 ≤ 5；中等团队 ≤ 50；大规模 SaaS 100+ |
| 重复 spawn 数量 | active daemon × 配置的 MCP server 数 |
| **隔离收益** | **state 绝对干净，不用担心 token / cache / connection 跨 daemon 泄漏** |

**结论**：N < 50 可接受；N ≥ 50 时考虑 External SaaS 资源池化（用户级 MCP / LSP daemon）。

### Qwen 保留的两项独有优化（OpenCode 没有）

per-workspace 模型不等于"完全照抄 OpenCode"——Qwen 在此基础上保留两项 OpenCode 没有的优化：

| 优化 | 状态 | 价值 |
|---|---|---|
| **PR#3818 in-flight rediscovery coalesce**（已合并）| ✓ | 同 daemon 内并发触发 reconnect 时合并为单一 in-flight restart（如多 client 同时触发 MCP 重连），避免起多余 MCP 进程 |
| **30s 健康检查 + 自动重连**（PR#3741 footer pill 暗示已存在）| ✓ | OpenCode 没有（无自动重连机制，掉线后用户主动 connect）|

### 状态机（与 OpenCode 一致 + Qwen 现有扩展）

OpenCode 5 种状态：

```ts
type McpStatus =
  | { status: 'connected' }
  | { status: 'disabled' }
  | { status: 'failed', error: string }
  | { status: 'needs_auth' }                                  // OAuth 未完成
  | { status: 'needs_client_registration', error: string }    // dynamic client registration
```

Qwen 现有 `MCPServerStatus`（`packages/core/src/tools/mcp-client.ts:73`）只有 3 种（CONNECTED / CONNECTING / DISCONNECTED）。daemon 化时建议扩展到与 OpenCode 一致的 5 种 + 加 `'connecting'` 中间态 = 6 种。

### 实现要点

```ts
// 复用 Qwen 现有 mcp-client-manager.ts（已实现 per-instance 多 client）
// daemon 化主要工作：mcp-client-manager 作为 daemon-global singleton

class DaemonInstance {
  private mcpManager: McpClientManager  // ← daemon-global singleton

  constructor(private workspaceDirectory: string) {
    this.mcpManager = new McpClientManager({
      cwd: this.workspaceDirectory,
    })
  }

  async start() {
    // 复刻 OpenCode 的 lazy 初始化模式
    // 第一次 tool call 触发 MCP 时才启动 MCP servers
    // concurrency: 'unbounded' 全部 MCP server 并发连接
    await this.mcpManager.initializeFromConfig()
  }

  async dispose() {
    await this.mcpManager.disconnectAll()
  }
}
```



---

## 4. FileReadCache 共享语义

**问题**：FileReadCache（PR#3717）的"模型已看过整文件"标记是 session 级私有、还是跨 session 共享？

### 决策（最终）

**Session 内私有**。**不**跨 session 共享，包括同 workspace 内的多个 session。

### 决策依据

1. **PR#3717 当前实现已经是 session-scoped** —— `FileReadCache` instance 由 `SessionService` 持有，daemon 化天然兼容（每 session 各持一个实例）
2. **PR#3774 (已合并 2026-05-06) prior-read enforcement 假设依赖 session 私有**：cache `miss` 表示 "**当前 session** 没看过该文件" → 拒绝 Edit/WriteFile。共享 cache 后 "miss" 失去这个语义（其他 session 看过不代表当前 session 看过），PR#3774 的整套守卫会失效或需要重新审计
3. **PR#3810 (已合并) audit 已经表明 invalidation 是 fragile point** —— PR#3717 漏了 5 条 history-rewrite 路径才被发现。共享 cache 把这个风险半径放大到全 daemon，而所有 history rewrite 路径都需要广播 invalidation
4. **跨 session 重复 read 的代价小** —— 文件读取本身有 OS page cache 兜底（同文件第二次 read 走内存），FileReadCache 节省的主要是 LLM token，不是 disk I/O
5. **决策 §1 sessionScope: 'single' 默认下，多 client 实际上看同一个 session** —— 不存在"两个 session 看同 workspace 同文件"的高频场景；只有 fork session / `LoadSession` 后才会出现，是 cold path

### 拒绝跨 session 共享的具体理由

| 跨 session 共享的"优点" | 反驳 |
|---|---|
| "两个 session 看同 workspace 时 read 命中" | 实际场景下 `single` scope 多 client 共享同一 session（决策 §1），不存在这个场景；只有 LoadSession fork 才出现 |
| "节省 LLM token" | PR#3717 的占位符短路本来就只对**重复 full text Read** 生效，不优化 ranged read / 不优化首次 read。共享带来的额外节省有限 |
| "节省 disk I/O" | OS page cache 已经覆盖（同文件第二次 read 走内存）|

### 与决策 §1 / §3 的协调

| 决策 | 边界 | FileReadCache 共享语义 |
|---|---|---|
| §1 session 默认 'single' | 多 client 共享 session | **同 cache 实例**（因为是同 session）|
| §1 session 'thread' 模式（多租户）| 每 client 独立 session | **隔离 cache**（绝对不能跨 session 共享）|
| §3 MCP per-workspace | workspace 边界 | FileReadCache **更窄**——session 边界 |

FileReadCache 与 MCP 在 1 daemon = 1 session 模型下都是 **per-daemon**——daemon 进程边界天然就是 cache / MCP children 的生命周期边界。

### 实现要点

```ts
// PR#3717 设计
class FileReadCache {
  private byKey: Map<DevInoKey, ReadEntry>   // (dev, ino) → entry
}

// 每 SessionService 持一个实例（已是 PR#3717 当前行为）
class SessionService {
  private fileReadCache = new FileReadCache()
}
```

**daemon 化无需任何修改** —— Session 已经是 daemon 化下的资源持有者，FileReadCache 跟着 Session 生命周期天然 session-scoped。

### 实现要点

```ts
// FileReadCache 当前是 session-scoped（PR#3717 设计）
class FileReadCache {
  private byKey: Map<string, ...>  // 已经是 per-instance（每 SessionService）
}
// daemon 化下，每 session 各自持一个 FileReadCache instance — 不共享
```

### PR#3810 / PR#3774 与 cache 语义的耦合

| PR | 行为 | 与 session-scoped 的依赖 |
|---|---|---|
| **PR#3810**（已合并）| `microcompactHistory` / `setHistory` / `truncateHistory` / `resetChat` / `stripOrphanedUserEntriesFromHistory` 5 路径触发 cache invalidation | 操作都是 per-session，invalidation 半径不会扩大到 workspace 级别 |
| **PR#3774**（已合并 2026-05-06）| `EDIT_REQUIRES_PRIOR_READ` / `FILE_CHANGED_SINCE_READ` 两个错误码 | "miss" 等同 "**当前 session** 未读过该文件"；共享 cache 后此语义失效，整套 prior-read 守卫崩坏。FileReadCache 必须保持 session 私有 |

---

## 4.5 其他 daemon 内资源共享策略

| 资源 | 共享范围 | 理由 / 现状 | 相关 PR |
|---|---|---|---|
| **LSP server** | per-daemon | LSP 服务端是为"项目"设计的（不是 per-conversation），TypeScript LSP 启动 5-15s，跨 session 共享是必须的；daemon 进程边界自然就是 LSP 生命周期边界 | — |
| **PTY / Background shell** | per-task / 调度面 daemon 级 | PR#3642 `BackgroundShellRegistry` 已是跨 session 调度（按 taskId / sessionId 关联）；4 kinds（shell / agent / monitor / dream）都通过统一 `/workspace/:id/tasks` 暴露 | PR#3642 / PR#3687 / PR#3720 / PR#3801 |
| **Skill registry** | daemon 全局 + path-conditional 激活 | Skill registry 是声明式（不可变），全局共享 + per-tool-call 激活；PR#3852 path-conditional 发现机制天然适配 | PR#3852 |
| **Provider registry** | daemon 全局 | 不可变配置（DashScope / Anthropic / OpenAI 能力描述）| — |
| **Auth credentials** | per-workspace | 不同 workspace 可能用不同账号（个人 / 公司）| — |
| **FastModel config** | per-model（不再泄漏 main model）| PR#3815 修复 `extra_body` / `samplingParams` / `reasoning` 跨模型泄漏 | PR#3815 |

### 资源共享决策汇总表

| 资源 | 共享范围 | 隔离机制 |
|---|---|---|
| Provider registry | daemon 全局 | 不可变 |
| Skill registry | daemon 全局 + path-conditional 激活 | 不可变 + per-tool-call 激活 |
| Auth credentials | per-workspace | workspace 隔离 |
| LSP server | per-daemon | daemon 进程级隔离 |
| MCP server | per-daemon | daemon 进程级隔离 + reconnect coalesce + 30s 健康检查 |
| Background shell / agent / monitor / dream | per-task / 调度面 daemon 级 | task ID + sessionId 关联 |
| **Session state** | **per-session（= per-daemon）** | **SessionService 持久化 + transcript JSONL** |
| **FileReadCache** | **per-session（= per-daemon）** | **PR#3717 天然 session-scoped** |
| Permission flow | per-tool-call | PR#3723 |
| FastModel config | per-model | PR#3815 |

---

## 5. Permission flow

**问题**：daemon 模式下，工具调用是否需要审批？审批 UI 怎么做（HTTP 不像 stdio 能等用户回车）？

### 选择

**复用 PR#3723 共享 L3→L4 permission flow，加 daemon 第 4 种 execution mode + permission_request 走 SSE/WS 推给 client**。

### 理由

PR#3723（已合并 2026-04-30 +461/-95）把 Interactive / Non-Interactive / ACP 三模式的 L3→L4 决策合一为 `evaluatePermissionFlow()`。daemon 加为第 4 种 mode 是最自然的扩展。

### 实现要点

```ts
// 现有 PR#3723
type ExecutionMode = 'interactive' | 'non-interactive' | 'acp'

// 新增
type ExecutionMode = 'interactive' | 'non-interactive' | 'acp' | 'daemon-http'

// daemon-http mode 下的 ask 决策处理：
async function executeTool(tool: Tool, ctx: Context) {
  const result = evaluatePermissionFlow(tool, ctx)
  if (result.decision === 'ask') {
    // HTTP 不能阻塞等输入，改 SSE 推给 client
    sendSseEvent(ctx.sessionId, {
      type: 'permission_request',
      requestId: uuid(),
      tool: tool.name,
      args: tool.args,
    })
    // HTTP request 挂起等 POST /permission/:requestId 响应
    const response = await waitForPermissionResponse(requestId, { timeout: 60_000 })
    if (response.allow) { ... }
  }
}
```

详见 [07-权限/认证](./05-permission-auth.md)。

---

## 6. 多 client 并发请求

**问题**：两个 client 同时连同一个 session（决策 §1 默认共享）—— 谁能发 prompt？事件流怎么分发？

### 选择

**同 session 串行 prompt（FIFO 队列）+ 多 client 同时观察事件流（fan-out SSE/WS）+ 跨 session 并行**。

### 多 client 事件分发模型

```
Client A → POST /session/:id/prompt    "请重构 src/foo.ts"
Client B → GET /session/:id/events     (SSE 已订阅)
Client C → GET /session/:id/events     (SSE 已订阅)

daemon:
  ├─ Session.handlePrompt(req from A) 启动
  └─ SessionNotification stream
      ├─ A 走 POST 的 SSE response stream
      ├─ B 走 GET /events 的 SSE stream    ← fan-out
      └─ C 走 GET /events 的 SSE stream    ← fan-out

  → A/B/C 都看到完整事件流：message_part / tool_call / tool_result / permission_request
```

实现：每个 Session 维护 `Set<ClientSubscription>`，notification 时 broadcast 到所有订阅者。

### 谁能发 prompt？谁能审批权限？

| 操作 | 谁能做 | 冲突处理 |
|---|---|---|
| **发 prompt** | 任何 client | 同 session 串行 FIFO，第二个挂起等 |
| **审批 permission_request** | **任何 client（first responder wins）** | A 触发 permission_request → B 抢先 POST /permission/:id 应答 → daemon 接受 B 的应答，A/C 收到通知 "permission resolved by another client" |
| **取消** | 任何 client | POST /session/:id/cancel —— 取消当前 active prompt |
| **设置 model / mode** | 任何 client | 立即生效，所有 client 收到 SessionNotification |

### 理由

| 选项 | 适用 |
|---|---|
| **A：同 session 串行 prompt + fan-out 事件（本设计）** | 与 ACP 协议天然契合（一次只能有一个 active prompt）；多 client 协作场景（用户跨设备 / IDE+CLI）天然支持 |
| B：同 session 并行 prompt | 复杂——LLM 调用 / 工具调用并行化、FileReadCache / context state 都要重新设计同步；几乎没有实际收益（多用户在同一 conversation 中并发对话本身就是混乱的）|

ACP 协议本身就是"client → agent → 同步 response"语义，不允许同 session 并发 prompt。daemon 跟随这个约束 + 加上事件 fan-out 实现"多 client 协作观察"。

### 实现要点

```ts
class Session {
  private subscribers: Set<ClientSubscription> = new Set()
  private taskQueue: Promise<void> = Promise.resolve()
  
  subscribe(sub: ClientSubscription): () => void {
    this.subscribers.add(sub)
    return () => this.subscribers.delete(sub)
  }
  
  async handlePrompt(req: PromptRequest, originatingClient: ClientId) {
    // 同 session FIFO（第二个 prompt 挂起等）
    return this.taskQueue = this.taskQueue.then(() => this.doPrompt(req, originatingClient))
  }
  
  private notify(event: SessionNotification) {
    // fan-out 给所有订阅者（包括 originating client 和 observer client）
    for (const sub of this.subscribers) {
      sub.send(event)
    }
  }
}

class PermissionRequestHandler {
  async waitForResponse(requestId: string): Promise<PermissionResponse> {
    return new Promise((resolve, reject) => {
      // 任何 client POST /permission/:id 都能 resolve
      this.pending.set(requestId, { resolve, reject })
      // first responder wins
    })
  }
}
```

### 多 client 体验

| 场景 | 行为 |
|---|---|
| 用户在 CLI 发 prompt，同时打开 WebUI 观察 | WebUI 实时看到 message_part 流 + tool_call + tool_result |
| Agent 跑到 Bash 工具弹 permission，CLI 用户去喝咖啡了 | WebUI 用户能直接在浏览器点"批准"——不需要回到 CLI |
| Client A 发 prompt 跑到一半，Client B 想发新 prompt | B 的 HTTP request 挂起；B 也可以选择 POST /cancel 终止 A 的 prompt 后发自己的 |
| 用户从手机微信切到电脑 SDK 续行 | 手机端的 SubAgent 在后台继续跑，电脑端 LoadSession + 实时观察后台进度 |

---

## 7. Daemon 部署模式：CLI+HttpServer vs Headless+HttpServer

**问题**：用户已经在终端跑 `qwen` 交互式 CLI 时，能否同时让 WebUI / IDE / IM bot 接入到这个进程的 session？还是必须先关掉 CLI 改用 headless `qwen serve`？

### 决策

**支持两种部署模式 + 共享同一 Daemon Instance 抽象**：

| 模式 | 启动命令 | 包含 TUI | HTTP 端口 | 谁是 Daemon Instance | 适用场景 |
|---|---|:---:|:---:|---|---|
| **Mode A: CLI + HttpServer** | `qwen`（默认）或 `qwen --serve [--port N]` | ✅ 本地 TUI | ✅ 默认随机 / 显式 `--port` | **CLI 进程本身** | 单用户在终端工作 + 让 WebUI / IDE / 手机 IM bot 同时接入观察或代答 |
| **Mode B: Headless Daemon + HttpServer** | `qwen serve [--port N]` | ❌ 无 TUI | ✅ | **`qwen serve` 进程** | 服务器 / 容器 / 远端机器；所有 client 通过 HTTP 接入 |

**两种模式都遵循"1 Daemon Instance = 1 Session"语义（决策 §2）**——区别仅在于 daemon instance 是否同时承载本地 TUI 客户端。

### 模式 A 拓扑：CLI + HttpServer

```
┌────────────────────────────── qwen 进程（Mode A）─────────────────────────────┐
│                                                                              │
│  ┌─────────────────┐           ┌─────────────────────┐                       │
│  │  TUI（Ink）      │ ◄────►    │  Core              │ ◄──┐                  │
│  │  本地 Client #0  │   in-proc │  - Session         │    │                  │
│  └─────────────────┘   bus      │  - Tools           │    │                  │
│                                 │  - LLM / MCP / LSP │    │                  │
│  ┌─────────────────┐ HTTP/SSE   │                    │    │ subscriber       │
│  │  Express HTTP   │ ◄───────► │                    │ ◄──┘ fan-out          │
│  │  Server         │           └─────────────────────┘                       │
│  └────────┬────────┘                                                         │
│           │                                                                  │
└───────────┼──────────────────────────────────────────────────────────────────┘
            ↓
        ┌───────┐  ┌────────┐  ┌─────────┐
        │ WebUI │  │ IDE Ext│  │ IM bot  │  （远端 client 通过 HTTP 接入）
        └───────┘  └────────┘  └─────────┘
```

**关键性质**：
- TUI 是 **client #0**（in-process bus 直连 Core），与 HTTP 远端 client 走 §6 fan-out 同套通道
- TUI 退出（Ctrl+C / `/quit`）= **整个 daemon instance 退出**——远端 client 同时断连（通过 SSE close + `client_evicted: shutdown`）
- 远端 client 在 TUI 跑期间断开 / 重连不影响 TUI
- 共享 §6 同 session prompt 串行：TUI 输入和 WebUI 输入排同一个队列；任何 client（含 TUI）都能应答 permission

### 模式 B 拓扑：Headless Daemon + HttpServer

```
┌────────────────────────────── qwen serve 进程（Mode B）──────────────────────┐
│                                                                              │
│                                 ┌─────────────────────┐                      │
│                                 │  Core              │ ◄──┐                  │
│                                 │  - Session         │    │                  │
│                                 │  - Tools           │    │ subscriber       │
│                                 │  - LLM / MCP / LSP │    │ fan-out          │
│  ┌─────────────────┐ HTTP/SSE   │                    │    │                  │
│  │  Express HTTP   │ ◄───────► │                    │ ◄──┘                  │
│  │  Server         │           └─────────────────────┘                       │
│  └────────┬────────┘                                                         │
└───────────┼──────────────────────────────────────────────────────────────────┘
            ↓
   ┌──────────┐  ┌───────┐  ┌────────┐  ┌─────────┐
   │ 远端 CLI │  │ WebUI │  │ IDE Ext│  │ IM bot  │  （所有 client 通过 HTTP 接入）
   └──────────┘  └───────┘  └────────┘  └─────────┘
```

**关键性质**：
- 无 in-process TUI client；所有 client 全走 HTTP/SSE
- daemon 进程没有终端；通过 `--detach` / systemd / pm2 / Docker 后台运行
- 重启策略由进程管理器决定（systemd auto-restart）；session 通过 PR#3739 transcript-first fork resume 重建

### 决策依据

1. **Mode A 是 daemon 化最大的 UX 价值**——用户不需要"先关 CLI 再起 serve 再重连"才能让 WebUI 接入正在跑的 session；直接 `qwen --serve --port 7776` 即可
2. **Mode B 是云 / 服务器场景必需**——容器 / 远端机器没人在终端坐着
3. **两种模式实现成本几乎相同**——共享 Core / Express HTTP server / EventBus / subscriber 协议；区别只是 Mode A 多挂一个 in-process bus client（TUI），Mode B 不挂
4. **PR#3889 已经实现 Mode B 雏形**（`qwen serve daemon`）；Mode A 是把同一套 HttpServer 嵌入到 `qwen` 进程内
5. **与决策 §2 完全自洽**——两种模式都是"1 daemon instance = 1 session"，只是 daemon instance 的"形态"（含 TUI 或不含）不同

### 实现要点

| 维度 | Mode A | Mode B |
|---|---|---|
| **入口命令** | `qwen --serve [--port N]`（CLI flag） | `qwen serve [--port N]`（独立 subcommand） |
| **HTTP server 启动时机** | TUI 初始化后 + Core 初始化后 + listen on port | 启动即 listen on port |
| **TUI in-process bus** | 复用 §10 BackgroundTaskViewContext / SessionContext shape，订阅 EventBus 而非 SSE | 无 |
| **Token / 认证** | 默认 `auth: none`（loopback only）+ 显式 `--token` 启用 | 默认 `auth: bearer`（生成 token + 写 `~/.qwen/serve/token`）|
| **CORS / Origin lock** | 默认 loopback only（`127.0.0.1`）| 配置驱动 |
| **进程退出** | TUI Ctrl+C → graceful drain HTTP → close port → exit | SIGTERM → graceful drain → close port → exit |
| **重启 / 持久** | 不适用（用户在终端）| systemd / pm2 / Docker auto-restart |
| **mDNS 广播**（§11） | 可选 `--discoverable` flag | 可选配置 `discovery.mdns: true` |

### Mode A 的 TUI ↔ Core 通讯

复用决策 §6 的 EventBus + subscriber 协议，但 TUI client 走 in-process bus 而不是 HTTP/SSE：

```ts
// Mode A 启动序列（伪码）
const core = await createCore({ workspace, session })       // 共享 Core
const bus = core.eventBus

// TUI client #0 - in-process subscriber
const tuiSubscriber = bus.subscribe({ kind: 'inproc', clientId: 'local-tui' })
renderTui(tuiSubscriber, core)                              // Ink 组件订阅 events

// HTTP server - 远端 subscriber 走 SSE
const server = await createHttpServer({ core, port })
server.listen(port)                                         // 远端 client 通过 GET /session/:id/events 走 SSE
```

**关键**：TUI 和 HTTP client 拿到的 **事件流字节级完全一致**——都是 ACP NDJSON message_part / tool_call / tool_result / permission_request。TUI 只是省了 HTTP 序列化成本。

### Mode A 用户工作流示例

```bash
# 用户场景 1：本地 CLI + 手机微信 IM bot
$ qwen --serve --port 7776 --token-file ~/.qwen/local-token
[CLI TUI 启动]
> 帮我重构这个文件

# 同时手机微信发消息：
"帮我看下进度"
# IM bot 用 token 接入 :7776，看到正在跑的 tool_call + 进度

# 用户场景 2：本地 CLI + IDE 插件并存
$ qwen --serve --port 7776
[CLI TUI 启动]

# VSCode 自动通过 mDNS 发现 :7776 + bearer token，attach
# IDE 显示当前 session 的 tool_call 流；点 permission "批准"按钮
# CLI TUI 同时看到"已被 IDE 批准"状态
```

### 与 PR#3889 的工作量增量

PR#3889 已经实现 Mode B 的 ~95%。Mode A 的工作量增量：

| 任务 | 工作量 | 文件 |
|---|---|---|
| `qwen --serve` flag 解析 | 0.5d | `packages/cli/src/cli/cmd/index.ts` |
| TUI 启动后挂 HttpServer | 0.5d | `packages/cli/src/cli/main.ts` |
| TUI 作为 in-process subscriber | 1d | `packages/cli/src/ui/services/InProcAdapter.ts`（新建）|
| 默认 auth/CORS 区分本地 vs 远端 | 0.5d | server config 分发 |
| 生命周期协同（Ctrl+C drain HTTP）| 0.5d | shutdown hook |
| 文档 + e2e | 1d | |
| **合计** | **~4 天 / 1 人** | ~300-500 行新增 |

---

## 决策矩阵汇总

| # | 决策 | 选择 | 关键依据 PR / 工具 |
|---|---|---|---|
| 1 | session 跨 client 共享 | **默认共享同一 daemon instance**；scope 由 orchestrator 路由 | Channels SessionRouter scope 系统 |
| 2 | 状态进程模型 | **1 Daemon Instance = 1 Session**（与 PR#3889 child-process-per-session 一致）| OS process 隔离 |
| 3 | MCP server 生命周期 | **per-daemon MCP state** + in-flight coalesce + 30s 健康检查 | PR#3818 + PR#3741 健康检查 |
| 4 | FileReadCache 共享 | **per-daemon** + PR#3717 实现 + PR#3774 prior-read 守卫 + PR#3810 5 路径 invalidation | PR#3717 / PR#3774 / PR#3810 |
| 5 | Permission flow | 复用 PR#3723 + daemon 第 4 mode + SSE permission_request | PR#3723 evaluatePermissionFlow() |
| 6 | 多 client 并发 | **同 session prompt 串行 + 事件 fan-out 多 client + 任何 client 可应答 permission** | ACP 协议语义 + Session task queue + subscriber set |
| 7 | **部署模式** | **支持 Mode A（CLI+HttpServer）+ Mode B（Headless+HttpServer）双模式** | PR#3889 已实现 Mode B；Mode A ~4d 增量 |

---

下一篇：[04-HTTP API 设计 →](./03-http-api.md)
