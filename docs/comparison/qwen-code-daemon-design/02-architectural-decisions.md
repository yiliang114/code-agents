# 02 — 7 个架构决策

> [← 上一篇：架构总览](./01-overview.md) · [下一篇：HTTP API 设计 →](./03-http-api.md)

> daemon 化的"难点不是代码量，而是几个架构决策"。本章为每个决策点给出明确选择 + 关键理由 + 已实现 PR 对应。

## 1. session 是否跨 client 共享

**问题**：多 client（CLI + VSCode + WebUI + IM bot）打开同一项目时，互相能看到对方的 prompt 吗？跨设备续行（手机 → 电脑）走哪条路？

### 选择

**默认跨 client 共享同一 daemon instance**——多 client 接入同一 daemon URL 即自动共享该 daemon 的唯一 session（**Daemon Instance ↔ Session 是 1:1 关系**）。session 由 orchestrator 创建/分配 daemon instance 时确定。

| 维度 | 行为 |
|---|---|
| 1 Daemon Instance = 1 Session | 进程级隔离，无 daemon 内多 session 路由 |
| 多 client 连同一 daemon = 共享 session | live collaboration 模型（CLI + WebUI + IM 同看 message_part 流）|
| 不同 daemon instance 互相不可见 | 跨 daemon 跨 session 自然成立 |
| scope 概念在 orchestrator 层 | `coordinator.sessionScope: 'single' / 'user' / 'thread'` 决定如何路由到 daemon |

### 共享 daemon instance 的具体语义

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
- ✓ 跨 workspace 隔离（不同 daemon 实例自然隔离）
- ✓ 跨 daemon 进程隔离
- ⚠️ 同 daemon 内跨 client **能互相看见** —— 有意设计

**多租户场景在 orchestrator 层切到 `thread` scope**——每 client 路由到独立 daemon instance，彻底隔离。详见 [§14 Orchestrator 多租户与配额](./14-orchestrator-multi-tenancy.md)。

---

## 2. 状态进程模型

**问题**：所有 session 都跑在 daemon 主进程？还是每 session 一个独立进程？

### 决策

**1 Daemon Instance = 1 Session = 1 Process**。多 session 通过 orchestrator spawn 多个 daemon 实例实现，daemon 内部只承载一个 session 的状态。

```
┌──────────────────────────────────────────────────────┐
│ Orchestrator (qwen-coordinator)                      │
│   - sessionScope 'single'/'user'/'thread' 路由策略     │
│   - daemon spawn / route / cleanup                    │
└──────────────────────┬───────────────────────────────┘
                       │ spawn / route
        ┌──────────────┼──────────────┐
        ↓              ↓              ↓
   ┌────────┐     ┌────────┐     ┌────────┐
   │daemon-1│     │daemon-2│     │daemon-3│
   │(sess-A)│     │(sess-B)│     │(sess-C)│
   │ 1 V8   │     │ 1 V8   │     │ 1 V8   │
   │+LSP+MCP│     │+LSP+MCP│     │+LSP+MCP│
   └────────┘     └────────┘     └────────┘
```

### 与 PR#3889 的对应

[PR#3889](https://github.com/QwenLM/qwen-code/pull/3889) 已按此模型实现：`qwen serve` 主进程内置 daemon HTTP server + 简单 spawn `qwen --acp` child（绑唯一 session）= daemon instance。完整 orchestrator（多租户 / 配额 / discovery API）是 [External Reference Architecture](./06-roadmap.md#external-reference-architecture参考实现非项目路线图) 范畴，不在 PR#3889 / Stage 1/1.5/2 scope。

### 决策依据

1. **进程级隔离免费**——一个 session crash 不影响其他（V8 / OS 自动）
2. **避开跨 session 隔离复杂度**——不需要 AsyncLocalStorage Instance ctx / per-session resource managers / Effect-TS LocalContext
3. **多租户简化**——daemon 不感知 tenant，orchestrator 层做 ACL
4. **资源生命周期清晰**——kill daemon = 清理所有 fd / child / memory（无需 per-session cleanup hooks）
5. **与 PR#3889 child-process-per-session 一致**——~0 改造成本

### 代价权衡

| 维度 | 1 daemon = 1 session | 单 daemon 多 session（OpenCode）|
|---|---|---|
| 跨 session 资源共享 | ✗ 每 daemon 自己一份 | ✓ 共享省内存 |
| 隔离强度 | OS 进程级 | 应用层 ALS |
| Crash 半径 | 仅 affected session | 整 daemon |
| Cold start | ~1-3s/session | ~10ms/session |
| 内存 baseline | ~30-50MB × N | ~50MB / daemon |
| 适用规模 | 个人 / 小团队 / 中等 SaaS | 大规模 SaaS |

适用边界：单机 N < 50 经济性可接受；N ≥ 100 时投资源池化或迁移多 session（详见 [§13 设计对比](./13-single-vs-multi-session-design.md)）。

### 必要的工程约束

| 约束 | 验证 |
|---|---|
| daemon 主线程**永不**调用 `process.chdir()` | CI grep audit |
| 顶层 `process.on('uncaughtException')` log + graceful exit | top-level handler |
| Orchestrator 健康监测 daemon，超阈值 restart | `/health` + watchdog |
| daemon 启动后**永不接受第二个 session** | session ID 启动时绑定 |

详见 [§04 进程模型](./04-process-model.md)。

---

## 3. MCP server 生命周期

**问题**：MCP server 是每 session 启动一个？daemon 全局 fingerprint pool 跨实例共享？还是 per-daemon 边界管理？

### 决策

**per-daemon MCP state**——每个 daemon instance 持有自己的一套 MCP client 集，daemon 退出全部清理。**不跨 daemon 实例共享**。1 daemon = 1 session 模型下 daemon 进程边界天然就是 MCP children 的生命周期边界。

### 决策依据

1. **MCP server 可能持有 workspace-specific state** —— `filesystem` MCP 限制目录、`git` MCP 持 repo path、企业 DB MCP 持 workspace 连接串。每 daemon 1 workspace 1 session，state 边界天然清晰
2. **配置可能微小差异**——同 `github` MCP 不同 daemon 可能用不同 token；per-daemon 实例化避免 fingerprint pool 复杂性
3. **OpenCode 工程实践仍可借鉴**——`Effect.acquireUseRelease` + `concurrency: 'unbounded'` + 单 server 失败不传染，作用对象从 per-workspace 变 per-daemon

### Qwen 保留的两项独有优化

| 优化 | 状态 | 价值 |
|---|---|---|
| **PR#3818 in-flight rediscovery coalesce** | ✓ 已合并 | 同 daemon 并发 reconnect 合并为单一 in-flight restart |
| **30s 健康检查 + 自动重连** | ✓ | OpenCode 没有；掉线后用户主动 connect |

### 重复 spawn 代价

同 user 同 workspace 跑 N daemon 都用同 `github` MCP → 启 N 个 children。单 MCP ~50-200MB，N < 50 可接受；N ≥ 50 时考虑 External SaaS 资源池化（用户级 MCP daemon 共享）。

---

## 4. FileReadCache 共享语义

**问题**：FileReadCache（PR#3717）的"模型已看过整文件"标记是 session 级私有还是跨 session 共享？

### 决策

**Session 内私有**。不跨 session 共享，**1 daemon = 1 session 模型下等同 per-daemon**。

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
| **LSP server** | per-daemon | LSP 是项目级（不是 per-conversation），TypeScript LSP 启动 5-15s，daemon 进程边界自然就是 LSP 生命周期边界 | — |
| **PTY / Background shell** | per-task / 调度面 daemon 级 | PR#3642 `BackgroundShellRegistry` 跨 session 调度；4 kinds（shell / agent / monitor / dream）通过 `/workspace/:id/tasks` 暴露 | PR#3642 / PR#3687 / PR#3720 / PR#3801 |
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
| LSP server | per-daemon | daemon 进程级 |
| MCP server | per-daemon | daemon 进程级 + reconnect coalesce + 30s 健康检查 |
| Background shell / agent / monitor / dream | per-task / 调度面 daemon 级 | task ID + sessionId 关联 |
| **Session state** | **per-session（= per-daemon）** | SessionService 持久化 + transcript JSONL |
| **FileReadCache** | **per-session（= per-daemon）** | PR#3717 天然 session-scoped |
| Permission flow | per-tool-call | PR#3723 |
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

两种模式都遵循"1 Daemon Instance = 1 Session"语义（决策 §2）——区别仅在于 daemon instance 是否同时承载本地 TUI 客户端。**Wire 协议字节级一致**——TUI（Mode A）走 in-process EventBus 替代 SSE。

### Mode A 拓扑（核心特征）

- TUI 是 **client #0**（in-process bus 直连 Core），与 HTTP 远端 client 走 §6 fan-out 同套通道
- TUI 退出（Ctrl+C / `/quit`）= **整个 daemon instance 退出**
- 远端 client 在 TUI 跑期间断开 / 重连不影响 TUI
- TUI 输入和 WebUI 输入排同一 prompt 队列；任何 client（含 TUI）都能应答 permission

### Mode B 拓扑（核心特征）

- 无 in-process TUI client；所有 client 全走 HTTP/SSE
- 进程没有终端；通过 systemd / pm2 / Docker 后台运行
- 重启策略由进程管理器决定；session 通过 PR#3739 transcript-first fork resume 重建

### 决策依据

1. **Mode A 是 daemon 化最大 UX 价值**——用户不需要"先关 CLI 再起 serve 再重连"才能让 WebUI 接入正在跑的 session
2. **Mode B 是云 / 服务器场景必需**——容器 / 远端机器没人在终端坐着
3. **两种模式实现成本几乎相同**——共享 Core / Express HTTP server / EventBus / subscriber 协议；区别只是 Mode A 多挂一个 in-process bus client
4. **PR#3889 已实现 Mode B（Stage 1 scope 100% / GA-ready）**；Mode A 是把同一套 HttpServer 嵌入 `qwen` 进程内
5. **与决策 §2 完全自洽**——两种模式都是"1 daemon = 1 session"

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

---

## 决策矩阵汇总

| # | 决策 | 选择 | 关键依据 PR / 工具 |
|---|---|---|---|
| 1 | session 跨 client 共享 | **默认共享同一 daemon instance**；scope 在 orchestrator 层（`coordinator.sessionScope`）| PR#3739 transcript-first fork resume + orchestrator 路由策略（§14）|
| 2 | 状态进程模型 | **1 Daemon Instance = 1 Session**（与 PR#3889 child-process-per-session 一致）| OS process 隔离 |
| 3 | MCP server 生命周期 | **per-daemon MCP state** + in-flight coalesce + 30s 健康检查 | PR#3818 + 30s 健康检查（OpenCode 无）|
| 4 | FileReadCache 共享 | **per-daemon** + PR#3774 prior-read 守卫 + PR#3810 5 路径 invalidation | PR#3717 / PR#3774 / PR#3810 |
| 5 | Permission flow | 复用 PR#3723 + daemon 第 4 mode + SSE permission_request | PR#3723 evaluatePermissionFlow() |
| 6 | 多 client 并发 | **同 session prompt 串行（FIFO）+ 事件 fan-out + 任何 client 可应答 permission** | PR#3889 commit `ca996ecb5`（FIFO + no-poison）+ ACP 协议语义 + EventBus subscriber set |
| 7 | 部署模式 | **支持 Mode A（CLI+HttpServer）+ Mode B（Headless+HttpServer）双模式** | PR#3889 Mode B 已实现；Mode A ~4d 增量 |

---

下一篇：[03-HTTP API 设计 →](./03-http-api.md)
