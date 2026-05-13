# 02 — Architecture Decisions

> [← 上一篇：Overview](./01-overview.md) · [下一篇：HTTP API & Protocol →](./03-http-api.md)

## TL;DR

7 个核心架构决策（决策 §1-§7）。最关键的是 §2 状态进程模型：**1 daemon = 1 workspace × N session multiplexed**（与 `qwen --acp` stdio 1:1 心智完全对齐 + OS 进程级隔离 + cgroup quota / K8s 云原生契合 + blast radius 最小）。**终态决策矩阵见 [§九](#九决策矩阵汇总)**。

---

## 〇、术语表

> 详 [§01 §一 术语表](./01-overview.md#一术语表)。简表：

| 术语 | 定义 |
|---|---|
| **Daemon process** | `qwen serve` 进程，绑定启动时 cwd = 单 workspace |
| **Session** | per-daemon `QwenAgent.sessions: Map` 内一条 |

> **废弃术语**：Workspace Bridge / ChannelInfo / byWorkspaceChannel（PR#3889 commit `6a170ef8` 引入的 multi-workspace 路由层，由 [PR#4113](https://github.com/QwenLM/qwen-code/pull/4113) `refactor(serve): 1 daemon = 1 workspace` 移除）。

---

## 1. session 是否跨 client 共享 — 两种拓扑

### 两种正交拓扑（LaZzyMan PR#3889 review 提出）

| 拓扑 | 形态 | 典型场景 | 主要压力 |
|---|---|---|---|
| **P1 — 1:N**（multi-end sync）| 1 session × N clients 订阅同一 conversation 事件流 | 桌面 TUI + 手机 mirror / Web UI attach / pair programming | EventBus fan-out |
| **P2 — N:1**（resource sharing）| N session × 1 user 同 workspace 切换 / 并行 | **IDE multi-window**（不同分支 / 子目录）/ mobile app N conversations | 同 daemon 内 N session 共享 OAuth/cache/MCP children |

**关键观察**：IDE multi-window **是 P2 不是 P1**——多窗口为并行不同的事，不是同 session 多视图（Cursor / Continue / Claude Code / OpenCode / Gemini CLI 均原生支持 P2 single-process N-session）。

### 决策

**默认 `sessionScope: 'single'`**——同 daemon 多 client 自动 attach 到现有 session（语义 "first POST creates, subsequent POST attaches"）→ live collaboration（P1）。

**Stage 1.5 must-have #1** 落地后支持 per-request `sessionScope: 'thread'` override —— P2 同 daemon 内显式新建 isolated session，多 session 多路复用同 `qwen --acp` child（共享 OAuth / FileReadCache / CLAUDE.md parse / MCP children）。

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
- ✓ **跨 workspace = 跨 daemon process = OS 进程级隔离**（多 daemon 部署天然隔离）
- ✓ 跨 daemon process 进程级隔离（外部 orchestrator 多 daemon 部署时）
- ⚠️ **同 daemon 同 workspace 多 client 能互相看见** —— 有意设计
- ⚠️ **同 daemon N session 共 OS 权限**（同 `qwen --acp` child）—— 多 tenant 必须 1 daemon 1 tenant

**多租户约束**：orchestrator 在 daemon process 层做 1:1 tenant 绑定（1 daemon = 1 tenant × 1 workspace）。详 [§06 §5.2](./06-roadmap.md#52-multi-tenancy--oidc--quota--audit)。

---

## 2. 状态进程模型（核心决策）

### 决策

**1 Daemon Process = 1 Workspace × N Sessions Multiplexed**。

`qwen serve` 启动时绑定 cwd = 单 workspace，daemon 内嵌单 `qwen --acp` child（不引入 `byWorkspaceChannel: Map` 路由层）；`QwenAgent.sessions: Map<sessionId, Session>` 提供 N session multi-plexing。

```
qwen serve (绑定 cwd = /work/repo-a)
├─ Express HTTP front + bearer auth + Host allowlist
├─ EventBus（per-session fan-out + ring replay + Last-Event-ID 重连）
└─ qwen --acp child (workspace = /work/repo-a)
   └─ QwenAgent.sessions: Map → {sess-1, sess-2, sess-3}
```

**关键 invariants**：
- **N session 共享**：OAuth refresh × 1 / FileReadCache × 1 / CLAUDE.md parse × 1 / MCP children per server
- **跨 workspace 部署 = 多 daemon process**：systemd / docker-compose / k8s 各 1 process，OS 进程级隔离
- **daemon crash 半径**：整个 daemon 退出 = 该 workspace 全部 session 收到 `session_died`；其他 daemon（其他 workspace）不受影响

### 为什么不做 1 daemon + M workspace 路由

**Alternative considered**：PR#3889 commit `6a170ef8` 已实现 multi-workspace 路由（`byWorkspaceChannel: Map<workspace, ChannelInfo>` + `getOrCreateChannel` + per-workspace `qwen --acp` child）。**最终决定移除**——通过 [**PR#4113**](https://github.com/QwenLM/qwen-code/pull/4113) `refactor(serve): 1 daemon = 1 workspace (#3803 §02)`（OPEN，+1121/-374 across 13 files）落地，理由：

| # | 移除 multi-workspace 路由的收益 |
|---|---|
| 1 | **与 `qwen --acp` stdio 1:1 心智完美对齐**——`qwen --acp` 本身就是 "1 stdio = 1 workspace × N session"，daemon 把它包装成 HTTP 时应保持 1:1 mapping |
| 2 | **跨 workspace OS 进程级真隔离**（不依赖应用层 tenant 抽象）|
| 3 | **资源 quota 直接对应**：systemd `MemoryMax=` / cgroup / docker `--memory` 直接 = per-workspace quota；不需要 daemon 内部 per-workspace quota 抽象（chiga0 multi-tenant 关注点根本解）|
| 4 | **K8s / 云原生天然契合**：1 pod = 1 daemon = 1 workspace 是云原生最自然形态；Anthropic Managed Agents 推测就是 per-session container（同方向）|
| 5 | **Blast radius 最小**：daemon crash 只影响 1 workspace；multi-workspace 模式下影响 M workspace 全部 |
| 6 | **Observability 直接**：`htop` / `ps` 列表 1 OS process = 1 workspace；logs / metrics / traces 自然分割；`kill <pid>` 清一个 workspace |
| 7 | **水平扩展自然**：N machine 分布 N workspace = `qwen serve` × N 即可，不需 orchestrator 介入 |
| 8 | **省 ~500-700 LOC 路由代码**：`byWorkspaceChannel: Map` / `inFlightChannelSpawns` / `getOrCreateChannel` / `ChannelInfo` / 引用计数清理 / multi-workspace HTTP 路由 / 跨 workspace 测试 |
| 9 | **心智简单**：不需要 daemon ↔ workspace 两层概念抽象；用户启动 `qwen serve` 就知道"这是当前目录的 HTTP server" |

### Multi-workspace 路由的真实代价

| # | 多 workspace 路由层的代价 |
|---|---|
| 1 | **daemon 内部应用层 tenant 抽象**——cgroup / systemd quota 无法直接套，需 per-workspace 内部抽象 |
| 2 | **Blast radius 放大**：daemon crash 影响 M workspace |
| 3 | **`acpAgent.ts:600 loadSettings(cwd)` 跨 workspace 污染防护**——需 `byWorkspaceChannel: Map` 拒绝跨 workspace 复用，额外复杂度 |
| 4 | **引用计数清理 channel** 复杂逻辑：sessionIds set 空才 kill `qwen --acp` child + `channel.exited` cleanup 所有 session |
| 5 | **chiga0 / tanzhenxin reviewer 关注的"两套 Channel"命名冲突**：`byWorkspaceChannel` vs `packages/channels/base/ChannelBase`（IM 渠道）。移除 multi-workspace 路由 = 命名冲突自然消失 |

### 多 workspace 部署的替代方案：多 daemon process

```
┌──────────────────────────────────────────────┐
│ 同机多项目并行（开发者本地日常）                  │
├──────────────────────────────────────────────┤
│ qwen serve --port 8001 (cwd=/work/repo-a)    │
│ qwen serve --port 8002 (cwd=/work/repo-b)    │
│ qwen serve --port 8003 (cwd=/work/repo-c)    │
└──────────────────────────────────────────────┘
       ↓
  IM bot / WebUI / IDE 多 endpoint 路由（client 侧 / orchestrator 侧）
```

**Client 侧需要做的**：daemon discovery（哪个 port 对应哪个 workspace）+ 多 endpoint 路由。**External Reference Architecture** 提供 orchestrator 层（详 [§06 §五](./06-roadmap.md)）。

### 演进背景（简）

早期 PR#3889 设计：1 Daemon Instance = 1 Session = 1 `qwen --acp` child（spawn-per-session）。Review 过程中（LaZzyMan / tanzhenxin / 维护者反馈）发现 `QwenAgent.sessions: Map` 已原生支持单 child 多 session（`yiliang114` VSCode 插件早已生产用）。

commit `6a170ef8`（2026-05-12）做了第一轮重构：bridge-per-workspace + N session multiplexed（即 multi-workspace 路由）。**第二轮简化**：[PR#4113](https://github.com/QwenLM/qwen-code/pull/4113) 移除 multi-workspace 路由，回归 "1 daemon = 1 workspace × N session" 最纯粹形态——与 `qwen --acp` stdio 心智完全对齐。

### 与 IM Channels 实际用法 / ACP 协议能力的对比

tanzhenxin reviewer 反馈："ACP channels 是支持 working dir 的"——澄清三层支持现状：

| 层级 | 是否支持 multi-cwd | 实际用法 |
|---|---|---|
| **ACP 协议**（`newSession({cwd})`）| ✅ 协议层支持 per-call cwd | 协议设计意图："1 ACP child 可服多 cwd session" |
| **`packages/channels/base/`**（`AcpBridge.newSession(cwd)` + `SessionRouter.resolve(..., cwd?)`）| ✅ API 保留 per-session cwd 能力 | ❌ **实际只用 `this.config.cwd` 单 cwd**（`ChannelBase.ts:270`）—— 每个 IM channel 绑定 1 固定 cwd × N session |
| **`acpAgent.ts:600`** 实现 | ❌ `this.settings = loadSettings(cwd)` 是 instance-wide，新 cwd 覆盖旧值 | **阻止跨 cwd 多 session**（污染 settings / userHooks / projectHooks）|

**关键结论**：channels 当前生产用法 = "1 AcpBridge child = 1 cwd × N session"——**与 "1 daemon = 1 workspace × N session" 100% 同构，不冲突**。

**ACP 协议的 per-session cwd 能力当前在 qwen-code 实现层不可用**——commit `6a170ef8` 的 multi-workspace 路由实际是绕过 `loadSettings(cwd)` 污染（每 workspace 独立 child），不是真正打开 ACP 的 per-session cwd 能力。**[PR#4113](https://github.com/QwenLM/qwen-code/pull/4113) 回归 "1 daemon = 1 workspace × N session"——与 channels 实际用法（`config.cwd` 单值）完全一致**，且 daemon HTTP 层显式拒绝 cross-workspace 请求（`400 workspace_mismatch` + bound path + requested path）而非通过 spawn 多 child 假装支持。

**想真正打开 ACP per-session cwd 能力**：需重构 `acpAgent.ts` 把 `settings` / `userHooks` / `projectHooks` 从 instance-wide 改为 per-session 字段——属于 Stage 2e native in-process 前置任务，**不在 [PR#4113](https://github.com/QwenLM/qwen-code/pull/4113) 范围内**（PR#4113 不触碰 `packages/cli/src/acp-integration/`）。届时一个 daemon process 内可同时服多 cwd session（不需要 multi-workspace 路由层，因为 `acpAgent` 自己能 per-session 区分）。

### 与 OpenCode 的设计哲学差异

**OpenCode**：default 是 single daemon multi workspace（`Map<workspace, Instance>` ALS in-process）—— 主场景是 IDE + Web SDK + 个人开发者多项目，1 daemon 多 workspace 自然契合。

**Qwen Code**：default 是 **1 daemon = 1 workspace × N session**——主场景含 IM Channels（钉钉/Telegram/微信）+ External Reference 多 tenant SaaS + K8s 部署，**强隔离 / quota / blast radius 要求高**。**Qwen 不 copy OpenCode default**——Qwen 的设计选择更适合 Qwen 的主场景。

### 性能对比

| 维度 | OpenCode（多 workspace ALS）| **Qwen (1 daemon = 1 workspace)** | Qwen Stage 2e native in-process |
|---|---|---|---|
| 启动时间 | ~2-3s | ~2-3s | 类似 |
| 首 session 创建（新 workspace）| <100ms（同 daemon 内）| ~2-3s（启新 daemon）| <100ms |
| 同 workspace 第 N session | <50ms | **<200ms**（attach existing daemon）| <50ms |
| 跨 workspace 第 1 session | <50ms（同 daemon 内）| ~2-3s（启新 daemon）| <50ms |
| 100 同 workspace session 内存 | ~100-150MB | 类似 ~100-150MB | 类似 |
| 100 跨 workspace session 内存 | ~200MB（共 daemon）| ~10-15GB（100 daemon × baseline）| 类似 OpenCode |
| 隔离强度 | 应用层 ALS | **OS 进程级**（最强）| 应用层 |
| Blast radius | 整 daemon（全部 workspace）| **1 workspace** | 整 daemon |
| Quota 颗粒度 | 需应用层抽象 | **cgroup / systemd 直接套用** | 需应用层抽象 |
| 心智 | 抽象 + ALS context propagation | **与 `qwen --acp` stdio 1:1** | 抽象 |

**结论**：单 workspace 高密度场景三者经济性近似；跨 workspace 高密度场景 OpenCode > Qwen native > Qwen current；但 Qwen 换得 **OS 进程级真隔离 + 直接 cgroup quota + K8s 天然契合 + blast radius 最小 + 心智最简**——主场景下值得。

详 [§06 §六 vs OpenCode](./06-roadmap.md#六vs-opencode最相似的竞品)。

### 工程约束

| 约束 | 验证 |
|---|---|
| daemon 主线程**永不**调用 `process.chdir()` | CI grep audit |
| 顶层 `process.on('uncaughtException')` log + graceful exit | top-level handler |
| 启动时绑定 cwd 不变 | daemon 启动后 workspace 固化（无 `loadSettings(cwd)` 跨 workspace 切换风险）|
| `qwen --acp` child 退出 = daemon 进入终态 | 该 daemon 全部 session 收 `session_died` event；daemon 自身退出 |

---

## 3. MCP server 生命周期

**决策**：**per-daemon MCP state**（= per-workspace，因 1 daemon = 1 workspace）。

- daemon 内的 `qwen --acp` child 持自己的一套 MCP client 集，child 退出全部清理
- 同 daemon N session **共享** MCP children
- 跨 daemon（= 跨 workspace）不同 child 各自独立 MCP children（OS 进程级隔离）

### 依据

1. **MCP 持 workspace-specific state**：`filesystem` MCP 限制目录 / `git` MCP 持 repo path / 企业 DB MCP 持 workspace 连接串——per-daemon 边界天然清晰
2. **配置可能微小差异**：同 `github` MCP 不同 workspace 可能用不同 token——跨 daemon 自然隔离
3. **OpenCode `Effect.acquireUseRelease`** 可借鉴 — per-workspace 范围，与 1 daemon = 1 workspace 自然对齐

### Qwen 独有优化

| 优化 | 价值 |
|---|---|
| **PR#3818 in-flight rediscovery coalesce** | 同 daemon 并发 reconnect 合并为单一 in-flight restart |
| **30s 健康检查 + 自动重连** | OpenCode 没有；掉线后用户主动 connect |

### 重复 spawn 代价

同 user 同 workspace N session 共 1 套 `github` MCP children。多 workspace 同 user = M daemon × M sets of MCP children（每 daemon 一份）。单 MCP ~50-200MB；本地多项目 N < 5 workspace 可接受；服务器/K8s 部署多 tenant 时各 tenant 独立 daemon 自然隔离。

---

## 4. FileReadCache 共享语义

**决策**：**Session 内严格私有**。同 daemon N session 各自持独立 FileReadCache（`SessionService` per-session 字段）；不向其他 session 泄漏。

### 依据

1. **PR#3717 已是 session-scoped** —— `FileReadCache` instance 由 `SessionService` 持有，daemon 化天然兼容
2. **PR#3774 prior-read enforcement 依赖 session 私有**：cache miss = "**当前 session** 没看过该文件" → 拒绝 Edit/WriteFile。共享 cache 后此语义失效
3. **PR#3810 invalidation 5 路径** 表明跨 session 共享会把 fragility 半径扩到全 daemon
4. **跨 session 重复 read 代价小** —— OS page cache 兜底；FileReadCache 节省的是 LLM token 不是 disk I/O

### PR#3810 / PR#3774 与 cache 语义耦合

| PR | 行为 | 依赖 session-scoped |
|---|---|---|
| **PR#3810** | `microcompactHistory` / `setHistory` / `truncateHistory` / `resetChat` / `stripOrphanedUserEntriesFromHistory` 5 路径触发 cache invalidation | 操作 per-session，invalidation 半径不扩至 daemon 级 |
| **PR#3774** | `EDIT_REQUIRES_PRIOR_READ` / `FILE_CHANGED_SINCE_READ` 错误码 | "miss" 等同 "当前 session 未读过"；共享 cache 后此语义失效 |

### daemon 内资源共享汇总

| 资源 | 共享范围 | 隔离机制 |
|---|---|---|
| Provider registry | daemon 全局 | 不可变 |
| Skill registry | daemon 全局 + path-conditional | 不可变 + per-tool-call 激活 |
| Auth credentials | per-daemon | 跨 daemon OS 进程级隔离 |
| **LSP server** | per-daemon | 同 daemon N session 共享；跨 daemon 进程级隔离 |
| **MCP server** | per-daemon | 同上 + reconnect coalesce + 30s 健康检查 |
| Background shell / agent / monitor / dream | per-task / 调度面 per-daemon | task ID + sessionId 关联 |
| **Session state** | per-session（N session 各自 SessionService）| SessionService 持久化 + transcript JSONL |
| **FileReadCache** | per-session（不向其他 session 泄漏）| PR#3717 session-scoped |
| Permission flow | per-tool-call | PR#3723；workspace/global scope decisions 文件 per-daemon 共享（详 [§05](./05-permission-auth.md)）|
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
| **Mode A: CLI + HttpServer** | `qwen --serve [--port N]` | ✅ 本地（super-client）| 单用户终端 + WebUI / IDE / IM bot 同时接入当前 workspace |
| **Mode B: Headless + HttpServer** | `qwen serve [--port N]` | ❌ | 服务器 / 容器 / 远端机器 / K8s pod |

两种模式都遵循 §2 状态进程模型（1 daemon = 1 workspace × N session），区别仅在 daemon process 是否同时承载本地 TUI 客户端。**Wire 协议字节级一致** —— TUI（Mode A）走 in-process EventBus 替代 SSE。

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
| 1 | session 跨 client 共享 | **默认 `sessionScope: 'single'` 同 daemon 多 client 共享 session**；per-request scope override 是 Stage 1.5 must-have #1 | PR#3739 transcript-first fork resume + Stage 1.5 must-have #1 |
| 2 | 状态进程模型 | **1 daemon = 1 workspace × N session multiplexed**（与 `qwen --acp` stdio 1:1 心智 + OS 进程级隔离 + cgroup quota + K8s 云原生契合 + blast radius 最小）| [PR#4113](https://github.com/QwenLM/qwen-code/pull/4113) 移除 PR#3889 multi-workspace 路由 |
| 3 | MCP server 生命周期 | **per-daemon** + in-flight coalesce + 30s 健康检查 | PR#3818 + 30s 健康检查（OpenCode 无）|
| 4 | FileReadCache 共享 | **per-session 严格私有**（同 daemon N session 各自实例不共享；跨 daemon 自然独立）+ PR#3774 prior-read 守卫 + PR#3810 5 路径 invalidation | PR#3717 / PR#3774 / PR#3810 |
| 5 | Permission flow | 复用 PR#3723 + daemon 第 4 mode + SSE permission_request | PR#3723 evaluatePermissionFlow() |
| 6 | 多 client 并发 | **同 session prompt 串行（FIFO）+ 事件 fan-out + 任何 client 可应答 permission** | PR#3889 commit `ca996ecb5`（FIFO + no-poison）+ ACP 协议语义 + EventBus subscriber set |
| 7 | 部署模式 | **支持 Mode A（CLI+HttpServer）+ Mode B（Headless+HttpServer）双模式** | PR#3889 Mode B ✅ MERGED 2026-05-13；Mode A 归 Stage 1.5b ~4d 增量 |

---

下一篇：[03 — HTTP API & Protocol →](./03-http-api.md)
