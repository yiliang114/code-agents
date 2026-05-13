# 02 — Architecture Decisions

> [← 上一篇：Overview](./01-overview.md) · [下一篇：HTTP API & Protocol →](./03-http-api.md)

## TL;DR

7 个核心架构决策（决策 §1-§7）。最关键的是 §2 状态进程模型——**Default = 1 daemon = 1 workspace × N session**（与 `qwen --acp` stdio 1:1 心智 / OS 进程级隔离 / cgroup quota / K8s 云原生契合）；**Advanced opt-in `--multi-workspace`** = 1 daemon + M Workspace Bridges（PR#3889 已实现的 multi-workspace 路由保留作 advanced）。**终态决策矩阵见 [§九](#九决策矩阵汇总)**。

---

## 〇、术语表（commit `6a170ef8` 之后）

> 详 [§01 §一 术语表](./01-overview.md#一术语表commit-6a170ef8-之后)。简表：

| 术语 | 定义 |
|---|---|
| **Daemon process** | `qwen serve` HTTP front 进程。**Default**：绑定 1 workspace（cwd）；**Advanced**：`--multi-workspace` 启用 `byWorkspaceChannel: Map` 路由 M workspace |
| **Workspace Bridge**（≡ 代码 `ChannelInfo`，advanced 模式才有）| `qwen --acp` child = 严格 1 workspace × N session。Default 模式下 daemon 内嵌单 bridge；advanced 模式下 daemon 持 M bridge。**注**：与 IM `packages/channels/base/ChannelBase` 同名不同义，详 [§01](./01-overview.md#一术语表commit-6a170ef8-之后) |
| **Session** | per-bridge `sessions: Map` 内一条 |

---

## 1. session 是否跨 client 共享 — 两种拓扑

### 两种正交拓扑（LaZzyMan PR#3889 review 提出）

| 拓扑 | 形态 | 典型场景 | 主要压力 |
|---|---|---|---|
| **P1 — 1:N**（multi-end sync）| 1 session × N clients 订阅同一 conversation 事件流 | 桌面 TUI + 手机 mirror / Web UI attach / pair programming | EventBus fan-out |
| **P2 — N:1**（resource sharing）| N session × 1 user 同 workspace 切换 / 并行 | **IDE multi-window**（不同分支 / 子目录）/ mobile app N conversations | 同 workspace N session 共享 OAuth/cache/MCP children |

**关键观察**：IDE multi-window **是 P2 不是 P1**——多窗口为并行不同的事，不是同 session 多视图（Cursor / Continue / Claude Code / OpenCode / Gemini CLI 均原生支持 P2 single-process N-session）。

### 决策

**默认 `sessionScope: 'single'`**——同 workspace 多 client 自动 attach 到现有 session（语义 "first POST creates, subsequent POST attaches"）→ live collaboration（P1）。

**Stage 1.5 must-have #1** 落地后支持 per-request `sessionScope: 'thread'` override —— P2 同 workspace 内显式新建 isolated session，多 session 多路复用同 Workspace Bridge（共享 OAuth / FileReadCache / CLAUDE.md parse / MCP children）。

### 共享语义

| 操作 | 行为 |
|---|---|
| Client A 发 prompt | Client B 通过 SSE 看到完整事件流 |
| Client B 同时发 prompt | 同 session 串行——B 挂起等 A 完成（决策 §6）|
| A 等待 permission | 任何 client 都能 POST 应答（first-responder）|
| A 关闭 | daemon 进程不影响；其他 client 继续观察 |
| 所有 client 断开 + 空闲 | daemon 进入 idle，可被 orchestrator 回收 |

### 安全 / 隔离边界

`single` 默认下：
- ✓ **同 daemon 内跨 workspace 隔离**（`byWorkspaceChannel: Map` 不复用 bridge；每 workspace 独立 `qwen --acp` child = OS 进程级隔离）
- ✓ 跨 daemon process 进程级隔离（外部 orchestrator 多 daemon 部署时）
- ⚠️ **同 daemon 同 workspace 多 client 能互相看见** —— 有意设计
- ⚠️ **同 daemon 同 workspace N session 共 OS 权限**（同 `qwen --acp` child）—— 多 tenant 必须避开此边界

**多租户约束**：orchestrator 必须做 1:1 tenant 绑定—— workspace 层（推荐）或 daemon process 层（高安全）。详 [§06 §5.2](./06-roadmap.md#52-multi-tenancy--oidc--quota--audit)。

---

## 2. 状态进程模型（核心决策）

### 决策（设计 default）

**Default：1 Daemon Process = 1 Workspace × N Sessions multiplexed**。`qwen serve` 默认绑定**当前 cwd 一个 workspace** + N session 共 1 个 `qwen --acp` child。

**Advanced（opt-in）**：通过 `--multi-workspace` flag 启用 multi-workspace daemon — 此模式下 daemon 同时服 M workspace，每 workspace 一个 Workspace Bridge（per-workspace `qwen --acp` child），N session multiplexed per bridge。

> **PR#3889 当前实现状态**（2026-05-13 MERGED）：commit `6a170ef8` 已实现 multi-workspace 路由（`byWorkspaceChannel: Map`），但**未设置 single-workspace default**——当前所有 `qwen serve` 启动都是 advanced multi 模式。Stage 1.5a must-have：**改 default 为 single-workspace + opt-in `--multi-workspace`**（详 [§06 §三 Stage 1.5a](./06-roadmap.md)）。

```
Default mode: qwen serve (绑定 cwd = workspace A)
└─ 1 Daemon Process = 1 Workspace × N Sessions
   ├─ Express HTTP front + bearer auth + EventBus
   └─ qwen --acp child (workspace = A)
      └─ QwenAgent.sessions: Map → {sess-1, sess-2, sess-3}

Advanced mode: qwen serve --multi-workspace
└─ 1 Daemon Process + M Workspace Bridges
   ├─ Express + byWorkspaceChannel: Map<workspace, ChannelInfo>
   └─ M Workspace Bridges (1 per workspace):
      ├─ Bridge-A (workspace = A) ─ qwen --acp #1 → {sess-1, sess-2}
      ├─ Bridge-B (workspace = B) ─ qwen --acp #2 → {sess-3}
      └─ Bridge-C (workspace = C) ─ qwen --acp #3 → {sess-4}
```

**关键 invariants（两种模式共享）**：
- **Same workspace N session 共享**：OAuth refresh × 1 / FileReadCache × 1 / CLAUDE.md parse × 1 / MCP children per server
- **Cross-workspace 进程级隔离**（only advanced mode 有多 workspace）：跨 workspace 不同 `qwen --acp` child
- **Session crash 半径**：单 workspace（default）= 整 daemon；多 workspace（advanced）= 同 bridge 全部 N session，其他 workspace 不受影响

### 为什么 Default 是 "1 Daemon = 1 Workspace"

**核心 framing**：`qwen --acp` stdio 本身就是 "1 stdio 进程 = 1 workspace × N session"——daemon 把它包装成 HTTP 时，**最纯粹的 default 是 1:1 mapping**，多 workspace 是显式开启的高级功能。

| # | Default = 1 daemon = 1 workspace 的优点 |
|---|---|
| 1 | **Blast radius 最小**：daemon crash 只影响 1 workspace；多 workspace 模式下 daemon crash 影响全部 |
| 2 | **资源 quota 直接对应**：systemd `MemoryMax=` / cgroup / docker `--memory` 直接 = per-workspace quota；不需要 daemon 内部 per-workspace quota 抽象 |
| 3 | **多 tenant 隔离最强**：1 daemon = 1 user × 1 workspace 是 OS 进程级真隔离，无需应用层 tenant 区分 |
| 4 | **心智简单**：不需要 daemon ↔ workspace 两层概念；`qwen serve` 等价 "当前目录的 HTTP server" — 与 `qwen --acp` 心智一致 |
| 5 | **Observability 直接**：`htop` / `ps` 列表 1 OS process = 1 workspace；logs / metrics / traces 自然分割；`kill <pid>` 清一个 workspace |
| 6 | **水平扩展自然**：N machine 分布 N workspace = `qwen serve` × N 即可，不需 orchestrator 介入 |
| 7 | **崩溃恢复简单**：systemd restart 1 daemon = 1 workspace 重启 |
| 8 | **省 ~200+ LOC 路由代码**：default 模式 daemon 无需 `byWorkspaceChannel: Map` / `inFlightChannelSpawns` / `getOrCreateChannel`（关闭 advanced mode 时） |
| 9 | **K8s / 云原生天然契合**：1 pod = 1 daemon = 1 workspace 是云原生最自然形态；Anthropic Managed Agents 推测就是 per-session container（同方向）|

### 为什么仍保留 Multi-Workspace 作为 Advanced 模式

| # | Multi-workspace advanced 模式的适用场景 |
|---|---|
| 1 | **本地多项目并行**（开发者日常）：5+ workspace 同机时，单 daemon baseline 比 5 daemon × Express baseline (~30-50MB) × 5 节省 ~150-200 MB |
| 2 | **Mode A 本地 TUI 多端**：用户希望"一开 daemon 服全部本地项目"，远端 client 用单 endpoint 看全部 workspace |
| 3 | **IM bot 跨 workspace 路由**：`packages/channels/` IM bot 单连接 daemon + channel→workspace 二级路由（多 daemon 时需多连接 + 三级路由）|
| 4 | **多端协调**：手机微信查 N workspace background task 进度，单 SSE 流可观察不同 workspace 事件 |

**Advanced 模式的代价**：
- daemon crash 影响全部 workspace（vs default 只影响 1 workspace）
- 多 tenant 时共 OS 权限（不能跨 tenant 复用）
- 需要 daemon 内部 quota / observability 抽象层

### 适用场景决策矩阵

| 场景 | Default `qwen serve` | Advanced `qwen serve --multi-workspace` |
|---|:---:|:---:|
| K8s / docker 部署（1 pod / 1 container）| ✅ **强推** | 🟡 不自然 |
| 多 tenant SaaS（强隔离）| ✅ **强推** | ❌ 不推荐（共 OS 权限） |
| Blast radius 关键 | ✅ **强推** | 🟡 daemon crash 影响全部 |
| 资源 quota = workspace | ✅ **强推**（cgroup 直接套用）| 🟡 需应用层抽象 |
| 单用户本地 1 项目 | ✅ **强推** | 🟡 浪费 |
| 单用户本地多项目并行 | 🟡 多 daemon 管理麻烦 | ✅ **强推** |
| Mode A 本地 TUI 多 workspace | 🟡 一 daemon 一项目 | ✅ **强推** |
| IM bot 跨 workspace 路由 | 🟡 多 daemon 路由复杂 | ✅ **强推** |

### 与 OpenCode 的设计哲学差异（重要）

**OpenCode 设计的 default 是 single daemon multi workspace**（`Map<workspace, Instance>` ALS in-process）—— 因为 OpenCode 主场景是 **IDE + Web SDK + 个人开发者多项目**，1 daemon 多 workspace 与场景自然契合。

**Qwen Code 主场景包含 IM Channels（钉钉/Telegram/微信）+ External Reference 多 tenant SaaS**，这两类场景对**强隔离 / quota / blast radius 要求更高**。**Qwen 不应该 copy OpenCode 的 default**——Qwen default 选 single-workspace 反而更贴合 Qwen 的主场景（IM bot 是 advanced opt-in；SaaS 多 tenant 走 OS-level 真隔离）。

### 为什么不允许跨 workspace 共 bridge（advanced 模式约束）

advanced 模式下源码硬约束（`acpAgent.ts:600`）：

```ts
private async newSessionConfig(cwd: string, ...) {
  this.settings = loadSettings(cwd);   // ← instance-wide 字段，被新 cwd 覆盖
```

`this.settings` 是 `QwenAgent` instance 级字段（非 per-session）。`newSession({cwd})` 时 `loadSettings(cwd)` 覆盖；跨 workspace 共 bridge 会污染 settings / MCP / OAuth。所以 advanced multi-workspace 模式仍需 per-workspace 独立 bridge（不能跨 workspace 复用）。

### 演进背景（简）

早期 PR#3889 设计：1 Daemon Instance = 1 Session = 1 `qwen --acp` child（spawn-per-session）。Review 过程中（LaZzyMan / tanzhenxin / 维护者反馈）发现 `QwenAgent.sessions: Map` 已原生支持单 child 多 session（`yiliang114` VSCode 插件早已生产用）。commit `6a170ef8`（2026-05-12）重构为 bridge-per-workspace + N session multiplexed。**当前 PR#3889 已 merge 但未区分 default / advanced — Stage 1.5a must-have 加 `--multi-workspace` flag + default 改为 single-workspace**。

### 三种设计模式对比

| 维度 | **Default (推荐)**: 1 daemon = 1 workspace | Advanced: 1 daemon + M workspace | OpenCode: 1 daemon 全部 workspace ALS |
|---|---|---|---|
| 跨 workspace 隔离 | OS 进程级（多 daemon 进程隔离）| OS 进程级（多 bridge child 隔离）| 应用层（ALS）|
| 同 workspace N session 经济性 | ✓ OAuth/Cache/CLAUDE.md/MCP × 1 | ✓ 同 | ✓ 同 |
| Blast radius | 最小（1 daemon = 1 workspace）| 中（同 bridge N session）| 大（整 daemon）|
| Daemon baseline | 每 workspace 独立 ~30-50MB | 1 baseline 共享 | 1 baseline 共享 |
| 资源 quota 颗粒度 | cgroup / systemd 直接套 | 需应用层抽象 | 需应用层抽象 |
| 客户端复杂度 | client 需多 daemon discovery | 单 endpoint + workspace 路由 | 单 endpoint + workspace 路由 |
| K8s / 云原生 | ✅ 1 pod = 1 daemon = 1 workspace | 🟡 1 pod 多 workspace | 🟡 1 pod 多 workspace |
| Cold start（首 session）| ~1-3s | ~1-3s | ~10ms |
| Cold start（同 ws 第 N session）| **<200ms** | **<200ms**（attach bridge）| <50ms |
| 实现现状 | **Stage 1.5a 待加 flag** | **✅ PR#3889 MERGED** | OpenCode 已上线 |

详 [§06 §六 vs OpenCode](./06-roadmap.md#六vs-opencode最相似的竞品)。

### 工程约束（两种模式共享）

| 约束 | 验证 |
|---|---|
| daemon 主线程**永不**调用 `process.chdir()` | CI grep audit |
| 顶层 `process.on('uncaughtException')` log + graceful exit | top-level handler |
| `acpAgent.ts:600 loadSettings(cwd)` 跨 workspace 污染防护 | default = 无跨 workspace；advanced = `byWorkspaceChannel: Map` 拒绝跨 workspace 复用 |
| `killSession` 引用计数清理 bridge | sessionIds set 空才 kill `qwen --acp` child（advanced 模式才有引用计数）|
| `channel.exited` cleanup 所有 session | 该 bridge 全部 session 收 `session_died` event |
| daemon 启动后绑定 cwd 不变 | per-`qwen --acp` child cwd 启动时一次性确定 |

---

## 3. MCP server 生命周期

**决策**：**per-`qwen --acp` child（= per-workspace）MCP state**。

- 每个 Workspace Bridge 内的 child 持自己的一套 MCP client 集，child 退出全部清理
- 同 workspace N session **共享** MCP children
- 跨 workspace 不同 child 各自独立 MCP children（OS 进程级隔离）

### 依据

1. **MCP 持 workspace-specific state**：`filesystem` MCP 限制目录 / `git` MCP 持 repo path / 企业 DB MCP 持 workspace 连接串——per-bridge 边界天然清晰
2. **配置可能微小差异**：同 `github` MCP 不同 workspace 可能用不同 token
3. **OpenCode `Effect.acquireUseRelease`** 可借鉴—per-workspace 范围（与 bridge-per-workspace 自然对齐）

### Qwen 独有优化

| 优化 | 价值 |
|---|---|
| **PR#3818 in-flight rediscovery coalesce** | 同 bridge 并发 reconnect 合并为单一 in-flight restart |
| **30s 健康检查 + 自动重连** | OpenCode 没有；掉线后用户主动 connect |

### 重复 spawn 代价

同 user 同 workspace N session 共 1 套 `github` MCP children（commit `6a170ef8` 后的 key win）。跨 workspace 同 daemon = M workspaces × M sets of MCP children（每 bridge 一份）。单 MCP ~50-200MB；N < 50 workspaces 可接受。

---

## 4. FileReadCache 共享语义

**决策**：**Session 内严格私有**。同 workspace N session 各自持独立 FileReadCache（`SessionService` per-session 字段）；不向其他 session 泄漏。

### 依据

1. **PR#3717 已是 session-scoped** —— `FileReadCache` instance 由 `SessionService` 持有，daemon 化天然兼容
2. **PR#3774 prior-read enforcement 依赖 session 私有**：cache miss = "**当前 session** 没看过该文件" → 拒绝 Edit/WriteFile。共享 cache 后此语义失效
3. **PR#3810 invalidation 5 路径** 表明跨 session 共享会把 fragility 半径扩到全 daemon
4. **跨 session 重复 read 代价小** —— OS page cache 兜底；FileReadCache 节省的是 LLM token 不是 disk I/O

### PR#3810 / PR#3774 与 cache 语义耦合

| PR | 行为 | 依赖 session-scoped |
|---|---|---|
| **PR#3810** | `microcompactHistory` / `setHistory` / `truncateHistory` / `resetChat` / `stripOrphanedUserEntriesFromHistory` 5 路径触发 cache invalidation | 操作 per-session，invalidation 半径不扩至 workspace 级 |
| **PR#3774** | `EDIT_REQUIRES_PRIOR_READ` / `FILE_CHANGED_SINCE_READ` 错误码 | "miss" 等同 "当前 session 未读过"；共享 cache 后此语义失效 |

### 其他 daemon 内资源共享汇总

| 资源 | 共享范围 | 隔离机制 |
|---|---|---|
| Provider registry | daemon 全局 | 不可变 |
| Skill registry | daemon 全局 + path-conditional | 不可变 + per-tool-call 激活 |
| Auth credentials | per-workspace | workspace 隔离 |
| **LSP server** | per-bridge（= per-workspace）| 同 workspace N session 共享；跨 workspace 进程级隔离 |
| **MCP server** | per-bridge（= per-workspace）| 同上 + reconnect coalesce + 30s 健康检查 |
| Background shell / agent / monitor / dream | per-task / 调度面 per-bridge | task ID + sessionId 关联 |
| **Session state** | per-session（同 ws N session 各自 SessionService）| SessionService 持久化 + transcript JSONL |
| **FileReadCache** | per-session（不向其他 session 泄漏）| PR#3717 session-scoped |
| Permission flow | per-tool-call | PR#3723；workspace/global scope decisions 文件 per-ws 共享（详 [§05](./05-permission-auth.md)）|
| FastModel config | per-model | PR#3815 |

---

## 5. Permission Flow（链接 §05）

**决策**：**复用 PR#3723 共享 L3→L4 permission flow + daemon 第 4 种 execution mode + permission_request 走 SSE + first-responder 应答**。

```
ExecutionMode = 'interactive' | 'non-interactive' | 'acp' | 'daemon-http'
```

`daemon-http` mode 下 `ask` 决策不阻塞 HTTP，改 SSE 推 `permission_request` event；HTTP request 挂起等任意 client `POST /session/:id/permission/:requestId` 响应（first-responder）。

详 [§05 Security & Permission](./05-permission-auth.md)。

---

## 6. 多 Client 并发请求

**决策**：**同 session 串行 prompt（FIFO 队列）+ 多 client 同时观察事件流（fan-out SSE/WS）+ 跨 session 并行**。

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

### 依据

ACP 协议本身就是"client → agent → 同步 response"语义，不允许同 session 并发 prompt。daemon 跟随这个约束 + 加上事件 fan-out 实现"多 client 协作观察"。同 session 并发 prompt 几乎无实际收益且实现复杂度极高（LLM 调用 / 工具调用并行化 / FileReadCache 同步）。

---

## 7. 部署模式 — Mode A vs Mode B

### 决策

**支持两种部署模式 + 共享同一 daemon process 抽象**：

| 模式 | 启动命令 | TUI | 适用场景 |
|---|---|---|---|
| **Mode A: CLI + HttpServer** | `qwen --serve [--port N]` | ✅ 本地（super-client）| 单用户终端 + WebUI / IDE / IM bot 同时接入 |
| **Mode B: Headless + HttpServer** | `qwen serve [--port N]` | ❌ | 服务器 / 容器 / 远端机器 |

两种模式都遵循 §2 状态进程模型（default = 1 daemon = 1 workspace；advanced = `--multi-workspace` opt-in），区别仅在 daemon process 是否同时承载本地 TUI 客户端。**Wire 协议字节级一致** —— TUI（Mode A）走 in-process EventBus 替代 SSE。

### 依据

1. **Mode A 是 daemon 化最大 UX 价值** —— 用户不需要"先关 CLI 再起 serve 再重连"
2. **Mode B 是云 / 服务器场景必需** —— 容器 / 远端机器没人在终端
3. **两种模式实现成本几乎相同** —— 共享 Core / Express / EventBus / subscriber 协议
4. **PR#3889 已实现 Mode B**（Stage 1 ✅ MERGED 2026-05-13）；Mode A 是 Stage 1.5b ~4d 增量

### TUI 在多 session daemon 下的语义

详 [§04 §三 TUI super-client](./04-deployment-and-client.md)。简：

- **Mode A 本地 TUI 是 super-client**（保留 ~15 Ink dialogs + local-jsx slash commands）
- **wire 只承载 agent ↔ user conversation axis**——TUI mutations 不出 wire
- **远程 client 是 thin shell**（Stage 1 现状）——Stage 1.5c daemon-side state CRUD 落地后功能对齐 Mode A
- TUI 退出 = 整个 daemon process 退出（含所有 in-daemon sessions）

---

## 九、决策矩阵汇总

| # | 决策 | 选择 | 关键依据 |
|---|---|---|---|
| 1 | session 跨 client 共享 | **默认 `sessionScope: 'single'` 同 workspace 多 client 共享 session**（commit `6a170ef8` 后）；per-request scope override 是 Stage 1.5 must-have #1 | PR#3739 transcript-first fork resume + Stage 1.5 must-have #1 |
| 2 | 状态进程模型 | **Default = 1 daemon = 1 workspace × N session multiplexed**（与 `qwen --acp` stdio 1:1 心智 + OS 进程级隔离 + cgroup 自然 quota + 云原生契合）；**Advanced opt-in via `--multi-workspace`** = 1 daemon + M Workspace Bridges（PR#3889 commit `6a170ef8` 已实现，Stage 1.5a 改为 opt-in flag）| 默认走最纯粹 1:1 mapping；多 workspace 是显式 advanced 功能 |
| 3 | MCP server 生命周期 | **per-bridge（= per-workspace）** + in-flight coalesce + 30s 健康检查 | PR#3818 + 30s 健康检查（OpenCode 无）|
| 4 | FileReadCache 共享 | **per-session 严格私有**（同 workspace N session 各自实例不共享；跨 workspace 自然独立）+ PR#3774 prior-read 守卫 + PR#3810 5 路径 invalidation | PR#3717 / PR#3774 / PR#3810 |
| 5 | Permission flow | 复用 PR#3723 + daemon 第 4 mode + SSE permission_request | PR#3723 evaluatePermissionFlow() |
| 6 | 多 client 并发 | **同 session prompt 串行（FIFO）+ 事件 fan-out + 任何 client 可应答 permission** | PR#3889 commit `ca996ecb5`（FIFO + no-poison）+ ACP 协议语义 + EventBus subscriber set |
| 7 | 部署模式 | **支持 Mode A（CLI+HttpServer）+ Mode B（Headless+HttpServer）双模式** | PR#3889 Mode B ✅ MERGED 2026-05-13；Mode A 归 Stage 1.5b ~4d 增量 |

---

下一篇：[03 — HTTP API & Protocol →](./03-http-api.md)
