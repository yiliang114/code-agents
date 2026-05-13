# 02 — 7 个架构决策

> [← 上一篇：架构总览](./01-overview.md) · [下一篇：HTTP API 设计 →](./03-http-api.md)

> daemon 化的"难点不是代码量，而是几个架构决策"。本章为每个决策点给出明确选择 + 关键理由 + 已实现 PR 对应。

## 1. session 是否跨 client 共享 — 两种拓扑（P1 vs P2）

**问题**：多 client（CLI + VSCode + WebUI + IM bot）打开同一项目时，互相能看到对方的 prompt 吗？跨设备续行（手机 → 电脑）走哪条路？

### 两种正交拓扑（LaZzyMan PR#3889 review 提出的关键区分）

| 拓扑 | 形态 | 典型场景 | 主要压力 |
|---|---|---|---|
| **P1 — 1:N（multi-end sync）** | 1 session × N clients 订阅同一 conversation 事件流 | 桌面 TUI + 手机 mirror；Web UI attach 到 running session；IDE 插件 live-mirror TUI 状态 | EventBus fan-out |
| **P2 — N:1（resource sharing）** | N session × 1 user 在同 workspace 切换 / 并行 | **IDE multi-window**（不同分支 / 子目录）；mobile app N conversations；后台 agent + 交互 session 并行 | 同 workspace N session 共享 OAuth/cache/MCP children |

**关键观察**：IDE multi-window **是 P2 不是 P1**——多窗口的目的是并行处理不同的事，不是同 session 的多视图（LaZzyMan 引用 Cursor / Continue / Claude Code / OpenCode / Gemini CLI 均原生支持 P2 single-process 多 session）。

### 选择

**PR#3889 Stage 1**（commit `6a170ef8` 后两种拓扑都支持）：

- **P1（multi-end sync）**：默认 `sessionScope: 'single'` —— 多 client 接入同一 daemon URL 同一 workspace 时自动 attach 到该 workspace channel 上的现有 session（语义 "first POST creates, subsequent POST attaches to first"）→ live collaboration
- **P2（N:1 resource sharing）**：Stage 1.5 must-have #1 落地后支持 per-request `sessionScope: 'thread'` override —— client 在 same workspace 内显式创建 isolated session，多 session 多路复用同 `qwen --acp` child（共享 OAuth / FileReadCache / CLAUDE.md parse / MCP children）

> **Stage 1 真正约束**（commit `6a170ef8` 之后）：默认 sessionScope:single + 同 workspace 多 client 共享 session = live collaboration 模型；同 daemon 内同 workspace 也能开 N session（HTTP 路径），跨 workspace 必走不同 child（`acpAgent.ts:601` settings 重载边界）。
>
> **wenshao 修正记录**（2026-05-12 [PR#3889 comment 4431295082](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4431295082)）：早先认为 "N:1 (P2) 是 won't-fix on main-line, 推到 §21 Path A/B/C 重构" 的框架是错的——qwen-code agent 层本身已支持单进程多 session (`acpAgent.ts:194` `QwenAgent.sessions: Map`)；P2 修复只需 bridge 层 refactor（已在 commit `6a170ef8` 落地），不是 agent-layer 新工作流。

| 维度 | 行为（Stage 1，commit `6a170ef8` 之后）|
|---|---|
| 默认 `sessionScope: 'single'` 同 workspace 多 client 共享 session | live collaboration 模型（CLI + WebUI + IM 同看 message_part 流）|
| 同 workspace 内 N session（HTTP 路径）| `QwenAgent.sessions: Map` 多路复用，需 Stage 1.5 must-have #1 per-request scope override 才能从 client 端触发 |
| 不同 workspace 跨 daemon child 互相不可见 | 同 daemon 内跨 `qwen --acp` child 进程级隔离（`byWorkspaceChannel: Map` 不跨 workspace 复用 channel）|
| `sessionScope` 由 daemon 自治 | Stage 1 实现 `'single'` default（commit `8d7c03a5f` + `6a170ef8`）；Stage 1.5 must-have #1 加 `'thread'` / `'user'` per-request override。External orchestrator 仅负责跨 daemon process 路由（[§14](./14-orchestrator-multi-tenancy.md) 跨 daemon scope）|

### 同 daemon 同 workspace 多 client 共享 session 的具体语义

| 操作 | 行为 |
|---|---|
| Client A 发 prompt | Client B 通过 SSE 看到完整事件流 |
| Client B 同时发 prompt | 同 session 串行——B 挂起等 A 完成（决策 §6）|
| A 等待 permission | 任何 client（A 或 B）都能 POST 应答（first-responder）|
| A 关闭 | daemon 进程不影响；其他 client 继续观察 |
| 所有 client 断开 + 空闲一段时间 | daemon 进入 idle，可被 orchestrator 回收（具体 idle 阈值由 orchestrator 决定，主线 daemon 不强制）|

### 理由

1. **匹配单用户多 client 真实场景**：典型用户同时开 CLI + IDE + 手机 IM——共享 session 让所有视图实时同步是更直觉的默认
2. **PR#3739 transcript-first fork resume 加成**：session 中断后任意 client 能 LoadSession 重建并续行
3. **跨 client 审批解锁桌面 UX**：CLI 跑命令时弹出权限请求，用户可在 WebUI 上点"批准"——不被 TUI 困住

### 安全 / 隔离边界

`single` 默认下：
- ✓ **同 daemon 内跨 workspace 隔离**（`byWorkspaceChannel: Map` 不复用 channel；每 workspace 独立 `qwen --acp` child = OS 进程级隔离）
- ✓ 跨 daemon process 进程级隔离（外部 orchestrator 部署多 daemon 时）
- ⚠️ **同 daemon 同 workspace 多 client 能互相看见** —— 有意设计（live collaboration）
- ⚠️ **同 daemon 同 workspace N session 共 OS 权限**（同 `qwen --acp` child，共 user UID + fs 视图 + MCP children）—— 多 tenant 必须避开此边界

**多租户场景**（[§14 §一 警示](./14-orchestrator-multi-tenancy.md)）：必须由 orchestrator 在 **workspace 层（推荐 1 tenant ↔ 1 workspace）或 daemon process 层（高安全 1 tenant ↔ 独立 daemon process）** 做 1:1 tenant 绑定——**不可让多 tenant 共一个 workspace channel**（同 channel N session 共 OS 权限）。详见 [§14 Orchestrator 多租户与配额](./14-orchestrator-multi-tenancy.md)。

---

## 2. 状态进程模型

**问题**：所有 session 都跑在 daemon 主进程？还是每 session 一个独立进程？还是每 workspace 一组进程？

> **演进背景**：早期 PR#3889 设计采用 "1 Daemon = 1 Session" 简化路径，但 review 过程中（LaZzyMan / tanzhenxin / 维护者反馈）发现 `packages/cli/src/acp-integration/acpAgent.ts:194` 的 `QwenAgent.sessions: Map<string, Session>` 已原生支持单 child 多 session（`yiliang114` 的 VSCode 插件 `qwenAgentManager.ts:1324` 早已生产使用 `switchToSession()` 模式）。PR#3889 commit `6a170ef8`（2026-05-12）据此重构 Stage 1 bridge，移除了"1 daemon = 1 session"约束。
>
> **tanzhenxin 评审引用**（2026-05-12 [PR#3889 comment 4428974701](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4428974701)）："PR 不字面实现 '1 daemon = 1 session'，daemon 内部是 'one HTTP host, N `qwen --acp` children'"——这是 commit `6a170ef8` 之前的中间状态描述；commit `6a170ef8` 后实际架构是 "one HTTP host, M `qwen --acp` children per workspace, N session multiplexed per child"，#3803 原始 "1 daemon = 1 session" 框架已被超越。同时 tanzhenxin 指出 `httpAcpBridge.ts` (~1820 LOC) 与 `channels/base/AcpBridge` (~360 LOC) 架构相似（都有 `spawnOrAttach` / per-session FIFO / `sessionScope: 'single'\|'thread'`），Stage 1.5 prereq 之一是把 `AcpChannel` interface 抽到 `@qwen-code/acp-bridge` 共享包（chiga0 finding 1）。

### 决策（PR#3889 Stage 1 当前架构，post `6a170ef8`）

**1 Daemon Process + M `qwen --acp` Children（1 per workspace）+ N Sessions Multiplexed per Workspace**。daemon HTTP front 通过 `byWorkspaceChannel: Map<workspace, ChannelInfo>` 维护每 workspace 的 ACP channel；每个 channel 持一个 `qwen --acp` child + 通过 `connection.newSession({cwd, mcpServers})` 在同 child 上 multiplex N session。**跨 workspace 必须独立 child**——`acpAgent.ts:601` 在每次 `newSession({cwd, ...})` 调用时执行 `this.settings = loadSettings(cwd)`，**全 channel 共享的 settings 字段会被新 workspace 覆盖**——这是 commit `6a170ef8` 选择"per-workspace channel"（不允许跨 workspace 复用 channel）的根本原因（Stage 2e native in-process 才能解决）。

```
┌─────────────────────────────────────────────────────────────────┐
│ qwen serve（daemon HTTP front）                                  │
│   ├─ Express 5 HTTP server + bearer auth + Host allowlist        │
│   ├─ EventBus（per-session subscriber set / fan-out / replay）   │
│   └─ byWorkspaceChannel: Map<workspace, ChannelInfo>             │
└────────────────────────┬────────────────────────────────────────┘
                         │ spawn 1 child per workspace
        ┌────────────────┼────────────────┐
        ↓                ↓                ↓
  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
  │qwen --acp #1│  │qwen --acp #2│  │qwen --acp #3│
  │workspace=A  │  │workspace=B  │  │workspace=C  │
  │             │  │             │  │             │
  │QwenAgent    │  │QwenAgent    │  │QwenAgent    │
  │ .sessions:  │  │ .sessions:  │  │ .sessions:  │
  │  Map<>:     │  │  Map<>:     │  │  Map<>:     │
  │  ├─ sess-1  │  │  ├─ sess-4  │  │  └─ sess-7  │
  │  ├─ sess-2  │  │  └─ sess-5  │  │             │
  │  └─ sess-3  │  │             │  │             │
  │             │  │             │  │             │
  │+LSP+MCP+    │  │+LSP+MCP+    │  │+LSP+MCP+    │
  │ FileReadCache│ │ FileReadCache│ │ FileReadCache│
  │ (per-ws)    │  │ (per-ws)    │  │ (per-ws)    │
  └─────────────┘  └─────────────┘  └─────────────┘
```

**关键 invariants**：
- **Same workspace N session 共享**：OAuth refresh × 1 / FileReadCache × 1 / CLAUDE.md parse × 1 / MCP child × N（每 server 一组）
- **Cross-workspace 仍隔离**：跨 workspace 不同 child = OS 进程级隔离
- **同 channel session crash 半径**：`channel.exited` cleanup 触发该 workspace 所有 session 收到 `session_died` 事件；其他 workspace 不受影响

> **Stage 2e native in-process 演进路径**（可选，非主线）：去掉 `qwen --acp` child 桥接，daemon 进程直接 import `QwenAgent`。需先解决 `acpAgent.ts:601 loadSettings(cwd)` 的跨 workspace 污染——届时可达 OpenCode 模式（1 daemon 进程 + Map<workspace, Instance> + 全应用层 ALS）。但 Stage 1 + Stage 1.5 已满足绝大多数场景，Stage 2e 优先级不高。

### Stage 1 选择 channel-per-workspace 的依据

1. **复用 `QwenAgent.sessions: Map` 已有能力**——commit `6a170ef8` 之前 Stage 1 设计为 spawn-per-session，重构后保留 in-process N-session per workspace 的资源经济性
2. **跨 workspace 进程级隔离免费**——一 workspace channel crash 不影响其他 workspace（V8 / OS 自动）
3. **避开 Stage 1 引入跨 workspace 资源共享的复杂度**——`acpAgent.ts:601 loadSettings(cwd)` 重载 settings 是已知 cross-workspace 污染源，Stage 1 暂不解决
4. **多租户简化**——daemon 不感知 tenant，orchestrator 层做 ACL（多 tenant 跑同 daemon 时仍需 daemon-per-tenant 进程隔离 fallback）
5. **资源生命周期清晰**——`killSession` 引用计数清理（其他 session 仍在的 workspace 保留 channel）；kill daemon = 清理所有 fd / child / memory

### 与 PR#3889 的对应

[PR#3889](https://github.com/QwenLM/qwen-code/pull/3889) 已按此模型实现：`qwen serve` 主进程内置 daemon HTTP server + spawn `qwen --acp` child per workspace + N session multiplexed per channel via `connection.newSession()` (commit `6a170ef8`, 2026-05-12)。完整 orchestrator（多租户 / 配额 / discovery API）是 [External Reference Architecture](./06-roadmap.md#external-reference-architecture参考实现非项目路线图) 范畴，不在 PR#3889 / Stage 1/1.5/2 scope。

### 代价权衡

| 维度 | PR#3889 Stage 1（channel per workspace + N session multiplexed） | Stage 2e native in-process（可选演进，去 child）| OpenCode 模式（参考） |
|---|---|---|---|
| 跨 workspace 资源共享 | ✗（不同 workspace 不同 child）| ⚠️ 需先解决 `loadSettings(cwd)` 污染 | ✓ Map<workspace, Instance> |
| 同 workspace N session 资源共享 | ✓ OAuth/Cache/CLAUDE.md/MCP × 1 | ✓ 同 | ✓ 同 |
| 隔离强度 | 跨 workspace OS 进程级；同 workspace 应用层（ACP `sessions: Map`）| 全应用层 | 全应用层 ALS |
| Crash 半径 | 同 channel（workspace）全部 N session | 整 daemon | 整 daemon |
| Cold start（首 session/workspace）| ~1-3s | ~10ms（无 child spawn）| ~10ms |
| Cold start（同 workspace 第 N session）| **<200ms**（attach existing channel）| ~10ms | ~10ms |
| 内存 baseline（N=5 sessions 同 workspace）| **~60-100 MB**（commit `6a170ef8` 实测）| ~50 MB（省 bridge child）| ~50 MB |
| 适用规模 | 个人 / 小团队 / 中等 SaaS（N session × M workspace < 200）| 同 + 跨 ws 资源共享 | 大规模 SaaS |
| 实现现状 | **PR#3889 Stage 1 ✅ MERGED 2026-05-13**（merge commit `870bdf2a`，含 `6a170ef8` channel-per-workspace 重构）| 未启动，Stage 2e 可选 | 上游 OpenCode 已上线 |

适用边界：Stage 1 单机 ~50-200 sessions（取决于 workspace 分布）经济性可接受；更高规模时 Stage 2e native in-process 或外部 orchestrator pool 分担。

### 必要的工程约束（适用于 PR#3889 Stage 1 architecture）

| 约束 | 验证 |
|---|---|
| daemon 主线程**永不**调用 `process.chdir()` | CI grep audit |
| 顶层 `process.on('uncaughtException')` log + graceful exit | top-level handler |
| Orchestrator 健康监测 daemon，超阈值 restart | `/health` + watchdog |
| **`acpAgent.ts:601 loadSettings(cwd)` 跨 workspace 污染** | `byWorkspaceChannel: Map` 拒绝跨 workspace 复用 channel；每 workspace 独立 child |
| `killSession` 引用计数清理 channel | sessionIds set 空时才 kill `qwen --acp` child；其他 session 仍在的 workspace 保留 |
| `channel.exited` cleanup 所有 session | 该 channel 上全部 session 收到 `session_died` 事件，从 daemon maps 移除 |

详见 [§04 进程模型](./04-process-model.md)。

---

## 3. MCP server 生命周期

**问题**：MCP server 是每 session 启动一个？daemon 全局 fingerprint pool 跨实例共享？还是 per-daemon 边界管理？

### 决策

**per-`qwen --acp` child (= per-workspace) MCP state**——每个 workspace channel 内的 `qwen --acp` child 持有自己的一套 MCP client 集，child 退出全部清理；同 workspace 的 N session 共享同套 MCP children。**跨 workspace 不同 child 仍有独立 MCP children**（OS 进程级隔离），跨 workspace 不共享。Stage 2e native in-process 重构后跨 workspace 共享 MCP 需引入 `requiresPerSession` flag fallback + per-server `Effect.acquireUseRelease` 模式（OpenCode 已验证），目前不在主线 scope。

### 决策依据

1. **MCP server 可能持有 workspace-specific state** —— `filesystem` MCP 限制目录、`git` MCP 持 repo path、企业 DB MCP 持 workspace 连接串。每 `qwen --acp` child = 1 workspace，state 边界天然清晰（同 channel N session 共享 MCP children 但仍同 workspace）
2. **配置可能微小差异**——同 `github` MCP 不同 workspace channel 可能用不同 token（per-workspace `~/.qwen/workspaces/<wsId>/...` 配置覆盖）；per-channel 实例化避免 fingerprint pool 复杂性
3. **OpenCode 工程实践仍可借鉴**——`Effect.acquireUseRelease` + `concurrency: 'unbounded'` + 单 server 失败不传染，作用对象 per-workspace（与 commit `6a170ef8` 后 channel-per-workspace 模型自然对齐）

### Qwen 保留的两项独有优化

| 优化 | 状态 | 价值 |
|---|---|---|
| **PR#3818 in-flight rediscovery coalesce** | ✓ 已合并 | 同 `qwen --acp` child 内并发 reconnect 合并为单一 in-flight restart |
| **30s 健康检查 + 自动重连** | ✓ | OpenCode 没有；掉线后用户主动 connect |

### 重复 spawn 代价（commit `6a170ef8` 后修订）

**同 user 同 workspace 同 daemon 跑 N session 共享 1 套 `github` MCP children**（同 `qwen --acp` child + 同 MCP processes）——commit `6a170ef8` 后这是关键 win，不再 N × MCP。

跨 workspace 同 daemon = N workspaces × 1 套 MCP/workspace = N 套 MCP children。单 MCP ~50-200MB，单 daemon N < 50 workspaces 可接受；N ≥ 50 workspaces 时考虑 External SaaS 资源池化（用户级 MCP daemon 共享）或 Stage 2e native in-process（跨 workspace 共 MCP，需先解决 `requiresPerSession` audit）。

---

## 4. FileReadCache 共享语义

**问题**：FileReadCache（PR#3717）的"模型已看过整文件"标记是 session 级私有还是跨 session 共享？

### 决策

**Session 内私有**。不跨 session 共享。Stage 1 channel-per-workspace 模型下同 workspace N session 各自持有独立 FileReadCache 实例（`SessionService` 内 per-session 字段，N session 共 `qwen --acp` child 但 cache 仍 per-session 严格私有）；跨 workspace 不同 child 自然独立。Stage 2e native in-process 重构后仍保持 per-session 严格私有（不向 daemon 内其他 session 泄漏），符合 PR#3717 既有语义。

### 决策依据

1. **PR#3717 已是 session-scoped**——`FileReadCache` instance 由 `SessionService` 持有，daemon 化天然兼容
2. **PR#3774 prior-read enforcement 假设依赖 session 私有**：cache `miss` = "**当前 session** 没看过该文件" → 拒绝 Edit/WriteFile。共享 cache 后此语义失效，整套 prior-read 守卫崩坏
3. **PR#3810 invalidation 5 路径 audit** 表明跨 session 共享会把 fragility 半径放大到全 daemon
4. **跨 session 重复 read 代价小**——OS page cache 兜底，FileReadCache 节省的是 LLM token 不是 disk I/O

### PR#3810 / PR#3774 与 cache 语义的耦合

| PR | 行为 | 与 session-scoped 的依赖 |
|---|---|---|
| **PR#3810** | `microcompactHistory` / `setHistory` / `truncateHistory` / `resetChat` / `stripOrphanedUserEntriesFromHistory` 5 路径触发 cache invalidation | 操作都是 per-session，invalidation 半径不会扩大到 workspace 级 |
| **PR#3774** | `EDIT_REQUIRES_PRIOR_READ` / `FILE_CHANGED_SINCE_READ` 错误码 | "miss" 等同 "当前 session 未读过"；共享 cache 后此语义失效。FileReadCache 必须保持 session 私有 |

---

## 4.5 其他 daemon 内资源共享策略

| 资源 | 共享范围 | 理由 / 现状 | 相关 PR |
|---|---|---|---|
| **LSP server** | per-`qwen --acp` child (= per-workspace) | LSP 是项目级（不是 per-conversation），TypeScript LSP 启动 5-15s；channel-per-workspace 模型下同 workspace N session 共享同 LSP children | — |
| **PTY / Background shell** | per-task / 调度面 per-`qwen --acp` child | PR#3642 `BackgroundShellRegistry` 同 child 内跨 session 调度；4 kinds（shell / agent / monitor / dream）通过 `/workspace/:id/tasks` 暴露 | PR#3642 / PR#3687 / PR#3720 / PR#3801 |
| **Skill registry** | daemon 全局 + path-conditional 激活 | 声明式（不可变），全局共享 + per-tool-call 激活；PR#3852 path-conditional 发现机制天然适配 | PR#3852 |
| **Provider registry** | daemon 全局 | 不可变配置（DashScope / Anthropic / OpenAI 能力描述）| — |
| **Auth credentials** | per-workspace | 不同 workspace 可用不同账号（个人 / 公司）| — |
| **FastModel config** | per-model | PR#3815 修复 `extra_body` / `samplingParams` / `reasoning` 跨模型泄漏 | PR#3815 |

### 资源共享决策汇总表

| 资源 | 共享范围 | 隔离机制 |
|---|---|---|
| Provider registry | daemon 全局 | 不可变 |
| Skill registry | daemon 全局 + path-conditional | 不可变 + per-tool-call 激活 |
| Auth credentials | per-workspace | workspace 隔离 |
| LSP server | per-`qwen --acp` child (= per-workspace) | 同 workspace N session 共享；跨 workspace 进程级隔离 |
| MCP server | per-`qwen --acp` child (= per-workspace) | 同 workspace N session 共享；跨 workspace 进程级隔离 + reconnect coalesce + 30s 健康检查 |
| Background shell / agent / monitor / dream | per-task / 调度面 per-`qwen --acp` child | task ID + sessionId 关联，同 child 内跨 session 调度 |
| **Session state** | **per-session**（同 workspace N session 各自 SessionService；跨 workspace 自然隔离）| SessionService 持久化 + transcript JSONL |
| **FileReadCache** | **per-session**（同 workspace N session 各自实例；不向其他 session 泄漏）| PR#3717 天然 session-scoped |
| Permission flow | per-tool-call | PR#3723；每 Session 各自 PermissionManager 实例（per-session 隔离），但 `workspace` / `global` scope decisions 文件 per-workspace 共享——同 `qwen --acp` child 内 N session 并发写时需 in-memory mutex（详见 [§05 §四](./05-permission-auth.md)）|
| FastModel config | per-model | PR#3815 |

---

## 5. Permission flow

**问题**：daemon 模式下工具调用如何审批？HTTP 不像 stdio 能阻塞等用户输入。

### 决策

**复用 PR#3723 共享 L3→L4 permission flow + daemon 第 4 种 execution mode + permission_request 走 SSE 推给 client + first-responder 应答**。

### 理由

PR#3723（已合并 +461/-95）把 Interactive / Non-Interactive / ACP 三模式的 L3→L4 决策合一为 `evaluatePermissionFlow()`。daemon 加为第 4 种 mode 是最自然的扩展：

```
ExecutionMode = 'interactive' | 'non-interactive' | 'acp' | 'daemon-http'
```

`daemon-http` mode 下 `ask` 决策不阻塞 HTTP，改 SSE 推 `permission_request` event；HTTP request 挂起等任意 client `POST /session/:id/permission/:requestId` 响应（first-responder 应答）。详见 [§05 权限/认证](./05-permission-auth.md)。

---

## 6. 多 client 并发请求

**问题**：两个 client 同时连同一 session（决策 §1 默认共享）—— 谁能发 prompt？事件流怎么分发？

### 决策

**同 session 串行 prompt（FIFO 队列）+ 多 client 同时观察事件流（fan-out SSE/WS）+ 跨 session 并行**。

PR#3889 commit `ca996ecb5` 实现 per-session FIFO + no-poison（一个 prompt 失败不阻塞队列）。

### 多 client 事件分发

```
Client A → POST /session/:id/prompt
Client B / C → GET /session/:id/events （SSE 已订阅）

daemon Session.handlePrompt 启动
  └─ SessionNotification stream
      ├─ A 走 POST 的 SSE response
      ├─ B 走 GET /events SSE         ← fan-out
      └─ C 走 GET /events SSE         ← fan-out
```

每个 Session 维护 `Set<ClientSubscription>`，notification broadcast 到所有订阅者。

### 操作矩阵

| 操作 | 谁能做 | 冲突处理 |
|---|---|---|
| 发 prompt | 任何 client | 同 session 串行 FIFO，第二个挂起等 |
| 审批 permission_request | **任何 client（first responder wins）** | A 触发 → B 抢先应答 → A/C 收"已被 B 应答" |
| 取消 | 任何 client | `POST /session/:id/cancel` |
| 设置 model / mode | 任何 client | 立即生效，所有 client 收到通知 |

### 理由

ACP 协议本身就是"client → agent → 同步 response"语义，不允许同 session 并发 prompt。daemon 跟随这个约束 + 加上事件 fan-out 实现"多 client 协作观察"。同 session 并发 prompt 几乎无实际收益（多用户在同 conversation 中并发对话本身就是混乱的），且 LLM 调用 / 工具调用并行化 / FileReadCache 同步等实现复杂度极高。

---

## 7. Daemon 部署模式：CLI+HttpServer vs Headless+HttpServer

**问题**：用户已经在终端跑 `qwen` 交互式 CLI 时，能否同时让 WebUI / IDE / IM bot 接入到这个进程的 session？还是必须先关掉 CLI 改用 headless `qwen serve`？

### 决策

**支持两种部署模式 + 共享同一 Daemon Instance 抽象**：

| 模式 | 启动命令 | TUI | 适用场景 |
|---|---|:---:|---|
| **Mode A: CLI + HttpServer** | `qwen --serve [--port N]` | ✅ 本地 | 单用户终端工作 + WebUI / IDE / IM bot 同时接入观察或代答 |
| **Mode B: Headless Daemon + HttpServer** | `qwen serve [--port N]` | ❌ | 服务器 / 容器 / 远端机器；所有 client 通过 HTTP 接入 |

两种模式都遵循 Stage 1 "1 daemon process + channel per workspace + N session multiplexed" 架构（决策 §2）——区别仅在于 daemon process 是否同时承载本地 TUI 客户端。**Wire 协议字节级一致**——TUI（Mode A）走 in-process EventBus 替代 SSE。Stage 2e native in-process 重构后两种部署模式同步演进（去 `qwen --acp` child）。

### Mode A 拓扑（核心特征）

> **关键澄清**（LaZzyMan PR#3889 [review #4270256721](https://github.com/QwenLM/qwen-code/pull/3889#pullrequestreview-4270256721) + wenshao 选 option A [comment 4428675775](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4428675775)）：**TUI 是 "super-client" 而非 "subscriber #0"**——TUI 保留完整 local interaction layer（~15 Ink dialogs + local-jsx slash commands），EventBus / wire 只承载 **agent ↔ user conversation** axis；远程 client 看到的是 strict subset，不是 TUI 的 mirror。

- TUI 是 **super-client**（保留 ~15 Ink dialogs `ModelDialog` / `MemoryDialog` / `SessionPicker` 等 + local-jsx slash commands `/ide` / `/auth` / `/init` / `/resume` 等），通过 in-process bus 直连 Core
- **EventBus / wire 只承载 agent ↔ user conversation 流**：`message_part` / `tool_call` / `permission_request` 等流到所有订阅者；TUI-internal 状态变更**不出 wire**
- TUI 退出（Ctrl+C / `/quit`）= **整个 daemon process 退出** —— 含所有 in-daemon sessions（即使 daemon 内还有 Stage 1.5 must-have #1 创建的额外 sessions，TUI 退出仍 SIGTERM 全部；远程 client 收 `session_died` + SSE 关闭）。Mode A 设计假设是"单用户终端为主，远程 attach 观察"，本地用户结束 = work session 整体结束
- 远端 client 在 TUI 跑期间断开 / 重连不影响 TUI
- TUI 输入和 WebUI 输入排同一 prompt 队列；任何 client（含 TUI）都能应答 permission

### TUI 与 wire 的边界 — 哪些是 local-only

> **依据**：LaZzyMan 第 1 轮 review 指出"TUI 大量 Ink dialogs / local-jsx slash commands 是 TUI-local"，wenshao 选 option A（保持 wire 窄表面，不强制 TUI mutations 走 event）。

**Local-only TUI 行为**（远程 client **不会**收到 event 通知）：

| TUI 行为 | 实现 | wire 是否推送 |
|---|---|---|
| `/approval-mode` 切换 | TUI Ink dialog | ❌ 不出 wire |
| `/memory` 编辑 | TUI Ink dialog | ❌ 不出 wire |
| `/mcp` 启停 | TUI Ink dialog | ❌ 不出 wire |
| `/agents` 管理 | TUI Ink dialog | ❌ 不出 wire |
| `/tools` 启停 | TUI Ink dialog | ❌ 不出 wire |
| `/auth` 登录流 | TUI local-jsx | ❌ 不出 wire |
| `/init` 初始化 | TUI local-jsx | ❌ 不出 wire |
| `/resume` session 切换 | TUI 退出 + spawn 新进程 | ❌ 不出 wire（参 [§02 §7 TUI 多 session 语义](#mode-a-在多-session-daemon-下的-tui-语义关键设计澄清)）|

**Wire 推送的 agent ↔ user 事件**（所有订阅 client 都能收）：`message_part` / `tool_call` / `tool_result` / `permission_request` / `permission_resolved` / `model_switched` / `model_switch_failed` / `session_died` / `client_evicted` 等。

**远程 client 实现要点**（commit `9352627f` 写入 `docs/users/qwen-serve.md`）：
1. **Attach / reconnect 时必须 re-fetch state**：用 `Last-Event-ID: 0` 重放 `model_switched` 等终态 event 拿当前 model
2. **不要假设 TUI-side mutations 通过 event 推送**：`/approval-mode` / `/memory` / `/mcp` / `/agents` / `/tools` / `/auth` / `/init` 应视为 **opaque server state**，可能在两次 connect 之间漂移
3. **每次 reconnect 后视为 cold state**：除了 conversation 主流，其他 TUI 状态应当作 unknown

### Mode B 拓扑（核心特征）

- 无 in-process TUI client；所有 client 全走 HTTP/SSE
- 进程没有终端；通过 systemd / pm2 / Docker 后台运行
- 重启策略由进程管理器决定；session 通过 PR#3739 transcript-first fork resume 重建

### 决策依据

1. **Mode A 是 daemon 化最大 UX 价值**——用户不需要"先关 CLI 再起 serve 再重连"才能让 WebUI 接入正在跑的 session
2. **Mode B 是云 / 服务器场景必需**——容器 / 远端机器没人在终端坐着
3. **两种模式实现成本几乎相同**——共享 Core / Express HTTP server / EventBus / subscriber 协议；区别只是 Mode A 多挂一个 in-process bus client
4. **PR#3889 已实现 Mode B（Stage 1 ✅ MERGED 2026-05-13）**；Mode A 是把同一套 HttpServer 嵌入 `qwen` 进程内（Stage 1.5b）
5. **与决策 §2 完全自洽**——两种模式都是 Stage 1 channel-per-workspace + N session multiplexed 架构

### 实现要点

| 维度 | Mode A | Mode B |
|---|---|---|
| 入口 | `qwen --serve [--port N]` flag | `qwen serve [--port N]` subcommand |
| HTTP 启动 | TUI + Core 初始化后 listen | 启动即 listen |
| 默认 auth | `none`（loopback only）| `bearer`（生成 token + 写 `~/.qwen/serve/token`）|
| CORS / Origin | 默认 loopback only | 配置驱动 |
| 进程退出 | TUI Ctrl+C → drain → close | SIGTERM → drain → close |
| 重启 | N/A（用户在终端）| systemd / pm2 / Docker auto-restart |

### Mode A 工作量增量（基于 PR#3889 Mode B 已实现）

`qwen --serve` flag 解析 + TUI 启动后挂 HttpServer + TUI 作为 in-process subscriber + 默认 auth/CORS 区分本地 vs 远端 + 生命周期协同（Ctrl+C drain HTTP）+ e2e 测试 = **~4 天 / 1 人**。

### Mode A 在多 session daemon 下的 TUI 语义（关键设计澄清）

> **触发问题**（2026-05-12 维护者讨论 + PR#3889 commit `6a170ef8` 重构）：daemon 多 session 时 TUI 是怎么处理的？

源码现状（main 分支）：

| 路径 | Session 模型 | 多 session 能力 |
|---|---|---|
| **TUI 进程**（`qwen` 交互式）| `Config.initialize()` 构造**唯一一个 Session**；`config.getSessionId()` 是单值不是 Map；TUI 没有 session 列表 UI / 切换快捷键 | ❌ Single-session by design |
| **ACP server**（`qwen --acp` stdio NDJSON，VSCode 在用）| `QwenAgent.sessions: Map<sessionId, Session>` | ✅ 单进程 N session |
| `/resume <id>` 命令 | 返回 `{ type: 'dialog', dialog: 'resume' }` → **优雅退出 + spawn 新 qwen 进程**（新进程预热历史 transcript 再启动）| ❌ "切 session" = "重启 TUI" |
| VSCode 插件 | `qwenAgentManager.switchToSession(sessionId)` → ACP wire 切换 ctx | ✅ VSCode UI 自己实现 session 列表 dialog + 切换 |

**结论**：**Multi-session UX 是 ACP client 端的实现**（VSCode 有，TUI 没有），不是 ACP server 端能力问题。

### Mode A `qwen --serve` 的多 session 行为

Mode A daemon 本身能持 N session（commit `6a170ef8` Stage 1 已实现），但**TUI 部分只绑定其中一个 session**。语义如下：

| 行为 | 实现 |
|---|---|
| TUI 启动 | 自动 `POST /session`（同 daemon HTTP front 内部调用）→ 拿到 sessionId X，TUI 绑定 X |
| 远程 client `POST /session` 同 workspace | 默认 `sessionScope: 'single'` → 也得到 X（attach 模式）；多 client 共享 X = live collaboration |
| 远程 client 强制 new session（Stage 1.5 must-have #1 per-request scope override 落地后）| 同 daemon 内拿到新 sessionId Y；**TUI 看不到 Y**（TUI 仍只显示 X），但 daemon `QwenAgent.sessions: Map` 现在持有 {X, Y} 两个 session |
| 远程 client `GET /session/Y/events` | 走 daemon EventBus fan-out，正常订阅 Y 的事件流（绕过 TUI）|

→ **Mode A daemon 多 session 在 HTTP 层成立**，**Mode A TUI 仍是 single-session**——TUI 看到的是它启动时绑的那个 session（Stage 1.5 default sessionScope:single 下也就是任何 attach 进来的 collab）。

**这是 PR#3889 Stage 1 + Stage 1.5 must-have #1 落地后的天然结果**——不需要刻意"禁用 Mode A 多 session"，因为 TUI UX 本身就只绑 1 session，且 daemon HTTP 路径不受 TUI single-session 约束。

> **影响**：[§13 §4.3 决策树](./13-single-vs-multi-session-design.md#43-决策树) 末枝"推进 Stage 2e in-process N-session" 在 Mode A / Mode B 都适用——Mode A daemon 可持多 session（HTTP 远程 client 全访问），TUI 锁绑某 session 是用户视角问题不是架构问题。

---

## 决策矩阵汇总

| # | 决策 | 选择 | 关键依据 PR / 工具 |
|---|---|---|---|
| 1 | session 跨 client 共享 | **默认 `sessionScope: 'single'` 同 workspace 多 client 共享 session**（commit `6a170ef8` 后）；per-request scope override 是 Stage 1.5 must-have #1 | PR#3739 transcript-first fork resume + Stage 1.5 must-have #1 |
| 2 | 状态进程模型 | **Stage 1 = 1 daemon + M qwen --acp children（1 per workspace）+ N sessions multiplexed per workspace via QwenAgent.sessions: Map**（commit `6a170ef8`）| 跨 workspace OS process 隔离 + 同 workspace 应用层 ACP `sessions: Map` |
| 3 | MCP server 生命周期 | **per-`qwen --acp` child (= per-workspace)** + in-flight coalesce + 30s 健康检查（同 workspace N session 共享 MCP children；跨 workspace 不同 child 进程级隔离；Stage 2e native in-process 下跨 workspace 共享需 `requiresPerSession` audit）| PR#3818 + 30s 健康检查（OpenCode 无）|
| 4 | FileReadCache 共享 | **per-session 严格私有**（同 workspace N session 各自实例不共享；跨 workspace 自然独立）+ PR#3774 prior-read 守卫 + PR#3810 5 路径 invalidation | PR#3717 / PR#3774 / PR#3810 |
| 5 | Permission flow | 复用 PR#3723 + daemon 第 4 mode + SSE permission_request | PR#3723 evaluatePermissionFlow() |
| 6 | 多 client 并发 | **同 session prompt 串行（FIFO）+ 事件 fan-out + 任何 client 可应答 permission** | PR#3889 commit `ca996ecb5`（FIFO + no-poison）+ ACP 协议语义 + EventBus subscriber set |
| 7 | 部署模式 | **支持 Mode A（CLI+HttpServer）+ Mode B（Headless+HttpServer）双模式** | PR#3889 Mode B ✅ MERGED 2026-05-13；Mode A 归 Stage 1.5b ~4d 增量 |

---

下一篇：[03-HTTP API 设计 →](./03-http-api.md)
