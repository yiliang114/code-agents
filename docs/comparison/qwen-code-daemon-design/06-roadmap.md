# 06 — Roadmap & Ecosystem

> [← 上一篇：Security & Permission](./05-permission-auth.md) · [回到 README](./README.md)

## TL;DR

**主线 ~7-10 周 feature complete**：Stage 1 ✅ MERGED 2026-05-13（PR#3889）→ Stage 1.5 (1.5a/1.5b/1.5c 并行 ~3-4 周) → Stage 2 (2a-2d ~3-4 周 + 可选 2e)。**Stage 2 后协议表面锁定**——后续不扩展 wire 协议；平台层（orchestrator / 多租户 / sandbox / SaaS）由 External Reference Architecture 实施。

**与竞品定位**：qwen-code daemon = building block + Unix-style 可组合；OpenCode 走端到端 SaaS；Anthropic Managed Agents 是托管服务。详 §五 / §六。

---

## 一、主线时间线

```
                Week 1-2      Week 3-6        Week 7-10        Week 11-12
qwen-code 主线
   Stage 1       ████ ✅ MERGED 2026-05-13（PR#3889 merge commit 870bdf2a）
   Stage 1.5a            ████████ chiga0 10 must-haves（~2-3w）
   Stage 1.5b            ███ Mode A flag（~4d，与 1.5a 并行）
   Stage 1.5c            ███ daemon-side state CRUD（~3-5d，与 1.5a/b 并行）
   Stage 2                            ████████ 2a-2d（~3-4w）
   Stage 2e（可选）                                ██████ native in-process（~1-2w）
```

**核心判断**：qwen-code 是 building block，不是 SaaS 平台。Stage 2 完成后 daemon 协议表面 100% 稳定，外部集成方（商业平台 / k8s operator / 云厂商）基于此自由实现 orchestrator + 多租户 + SaaS。这与 OpenCode（端到端 SaaS）的设计哲学相反——保持 Unix 风格的可组合性。

**前置 PR 全部已合并**（2026-05-06 之前）：PR#3717 FileReadCache + PR#3810 5 路径 invalidation + PR#3723 共享 permission flow + PR#3739 transcript-first fork + PR#3642 `/tasks` + PR#3818 MCP rediscovery coalesce + PR#3836 Kind framework。

---

## 二、Stage 1：Mode B headless `qwen serve`（✅ MERGED 2026-05-13）

[**PR#3889**](https://github.com/QwenLM/qwen-code/pull/3889) `feat(cli,sdk): qwen serve daemon (Stage 1)` —— **✅ MERGED 2026-05-13 06:47 UTC**（merge commit `870bdf2a`）**+12993/-194 / 84 commits**。

### 落地的 9 个 STAGE1_FEATURES

```
['health', 'capabilities', 'session_create', 'session_list',
 'session_prompt', 'session_cancel', 'session_events',
 'session_set_model', 'permission_vote']
```

### 关键 commits（按时序）

| Commit | 改动 |
|---|---|
| `61f2f59a1` | scaffold `qwen serve` Express + auth + Host allowlist + /health + /capabilities |
| `8d7c03a5f` | HttpAcpBridge spawn `qwen --acp` per workspace + ACP 10s init + sessionScope:single |
| `ca996ecb5` | POST /prompt FIFO + /cancel + SessionNotFoundError |
| `41aa95094` | EventBus + SSE Last-Event-ID + 15s heartbeat + ring replay + client_evicted overflow |
| `6ee655f0a` | POST /permission first-responder vote + cancelSession resolves outstanding |
| `8206a64b5` | SDK DaemonClient + DaemonHttpError + parseSseStream |
| `a8ce5e08d` | /workspace/:id/sessions + /session/:id/model + errorMessage helper |
| `ad0e6ec06` | audit round 1: timing-safe bearer + IPv6 loopback ergonomics + failOnError |
| `27a164c` | Stage 1 文档补全（用户 quickstart + HTTP 协议 reference + SDK ts 示例 591 行）|
| **`6a170ef8`** 🌟 | **架构重构**：channel-per-workspace + N session multiplexed via `QwenAgent.sessions: Map`；N=5 内存 300-500MB → 60-100MB |
| `f29353a2` | N:1 framing 修正 docs |
| `bbc7b8b6` + `b1767903` | chiga0 第 3 轮 review：Stage 1 scope honesty + 10 must-haves for Stage 1.5+ + Durability model |
| `734d833b` / `e18b8fa6` / `b37cc01c` | 多轮 ~30 review threads close（atomic write / read-size cap / 6 critical bugs + 6 follow-ups）|

### 体量与经验

| 维度 | 预估 | 实际 | 倍数 |
|---|---|---|---|
| LOC | ~700-1000 行 | **+12993 / -194** | **7-12x** |
| 工作量 | ~7-8 天 / 1 人 | 多周（84 commits 跨 5 轮 multi-model audit + chiga0 三轮 + LaZzyMan + tanzhenxin reviews + 维护者 N:1 framing 反馈 + 架构重构）| 几周 vs 1 周 |
| Review threads close | — | ~60+ | — |

**超出原因**：EventBus 完整实现（提前到 Stage 1）+ Timing-safe bearer + IPv6 loopback ergonomics + 多 reviewer 多轮 audit + 架构重构（`6a170ef8`）+ Stage 1 docs 补全。**最 expensive 的 follow-up 是 `6a170ef8` channel-per-workspace 重构**（reviewer 反馈触发的架构反思）。

### Stage 1 已实现的 HA / 稳定性机制

| 机制 | 实现 |
|---|---|
| Daemon crash 自动重启 | 外部进程管理器（systemd / k8s）|
| Transcript-first fork resume | PR#3739（但 Stage 1 不在 HTTP 暴露 `loadSession` —— Stage 1.5 must-have #2）|
| SSE Last-Event-ID 重连 | commit `41aa95094` |
| Crash isolation 半径 | 同 channel（workspace）全部 N session；跨 workspace 进程级隔离 |
| `killSession` 引用计数清理 channel | sessionIds set 空才 kill `qwen --acp` child |
| timing-safe bearer auth + 401 uniform | commit `ad0e6ec06` |
| Durability model | 显式 documented as ephemeral（chiga0 must-have #10）|

主线**不需要**：multi-pod sticky session / Postgres Patroni / Redis Sentinel / per-tenant heap budget / Worker thread tenant isolation / 30 天 Soak/Chaos 测试矩阵——这些都是 External SaaS 运营层关切。

---

## 三、Stage 1.5：chiga0 10 must-haves + Mode A + daemon-side state CRUD（~3-4 周）

### 拆分

| Sub-stage | 内容 | 工作量 |
|---|---|---|
| **1.5-prereq** | chiga0 6 architecture refactor findings（lift `AcpChannel` / `EventBus` / `PermissionMediator` 到共享包 `@qwen-code/acp-bridge`）| ~1-2 周 |
| **1.5a** | chiga0 10 must-haves（blockers 3 + reliability 4 + ergonomics 3，#10 已 shipped）| ~2-3 周 |
| **1.5b** | Mode A `qwen --serve` flag（TUI co-host HTTP server） | ~4d |
| **1.5c** | daemon-side state CRUD（远端 client 功能等价 Mode A） | ~3-5d |
| **合计**（并行）| | **~3-4 周** |

### 1.5a — chiga0 10 must-haves

> 来源：chiga0 PR#3889 第 3 轮 review [comment 4427875644](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427875644)——从 IM bot / mobile / IDE 三个 downstream consumer 视角审计 Stage 1 protocol surface。

#### 🚨 Blockers（生产必需）

| # | must-have | 设计 |
|---|---|---|
| 1 | **Per-request `sessionScope` override** | body 字段 `{ scope: 'single' \| 'thread' \| 'user' }` 覆盖 daemon-wide default |
| 2 | **`loadSession` / `unstable_resumeSession` HTTP** | `POST /session/:id/load` + `POST /session/:id/resume` |
| 3 | **Persistent client identity（pair tokens + revocation）** | token registry + revocation API；daemon-stamped `originatorClientId` |

#### 🛡️ Reliability

| # | must-have |
|---|---|
| 4 | Client-initiated heartbeat（`POST /session/:id/heartbeat`）|
| 5 | `permission_already_resolved` event |
| 6 | Larger / per-session-configurable replay ring（default 8000）|
| 7 | `slow_client_warning` event before `client_evicted` |

#### 🎨 Ergonomics

| # | must-have | 状态 |
|---|---|---|
| 8 | `POST /session/:id/_meta`（IM-style context）| 待做 |
| 9 | `/capabilities` actual feature negotiation（`protocol_versions`）| 待做 |
| 10 | First-class durability documentation | ✅ shipped (commit `bbc7b8b6`) |

### 1.5b — Mode A `qwen --serve` flag

`qwen --serve` flag 解析 + TUI 启动后挂 HttpServer + TUI 作为 in-process subscriber + 默认 auth/CORS 区分本地 vs 远端 + 生命周期协同（Ctrl+C drain HTTP）+ e2e 测试 = **~4 天 / 1 人**。

Mode A daemon 同样能持 N session（继承 Stage 1 channel multiplexing）；TUI 绑定其中一个 session（详 [§04 §三 TUI](./04-deployment-and-client.md)）。

### 1.5c — daemon-side state CRUD（远端 client 等价 Mode A）

> 来源：[§04 §三·五 Mode B 远端 client 限制分析](./04-deployment-and-client.md)——Stage 1 远端 client 是 thin shell（8/9 dialogs 不可用）是 scope choice 不是技术约束。同行竞品（Cursor / Continue / Claude Code / OpenCode / Gemini CLI）都让远端 UI 完整访问 daemon state。Stage 1.5c 加 6-8 个 HTTP route 让远端 client 功能对齐。

| 新 wire route | 替代的 dialog | 工作量 |
|---|---|---|
| `GET/POST /workspace/:id/memory` | `/memory` | ~0.5d |
| `GET /workspace/:id/mcp` + `POST .../mcp/:server/restart` | `/mcp` | ~1d |
| `GET/POST /workspace/:id/agents` | `/agents` | ~0.5d |
| `POST /workspace/:id/tools/:name/enable` | `/tools` | ~0.5d |
| `POST /session/:id/approval-mode` | `/approval-mode` | ~0.5d |
| `POST /workspace/:id/init` | `/init` | ~0.5d |
| `POST /workspace/:id/auth/device-flow` 或 Capability RPC | `/auth` | ~2-3d |
| **合计** | 6-7 项 dialogs | **~3-5d** |

### 1.5-prereq — chiga0 6 architecture refactor findings

> 来源：chiga0 第 2 轮 review [comment 4427773706](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427773706) "cross-module unification"——repo 已有 6 条独立 "expose agent capabilities" 路径（`acp-integration/` / `nonInteractive/` / `dualOutput/` / `remoteInput/` / `channels/` / `serve/`）共享 ~80% machinery 但 ~0% abstractions。Stage 1 ships 4 个 inline `FIXME(stage-1.5, chiga0 finding N)` 标记。

| # | Finding | 改造方案 |
|---|---|---|
| 1 | `HttpAcpBridge` 混淆 transport + bridging | 抽 `AcpChannel` interface + `Transport` interface → `@qwen-code/acp-bridge` 包 |
| 2 | `EventBus` 私有于 HTTP/SSE | Lift 到 top-level building block，6 consumer 都接 |
| 3 | Permission flow 自实现（vs `ControlDispatcher`）| Lift `PermissionMediator` + 4 strategy policy（first-responder / designated / consensus / local-only）|
| 4 | `BridgeClient` fs 是 fork | Inject `FileSystemService` ctor dep |
| 5 | Capability registry hard-coded | Plug-in registry + `POST /ext/:method` extMethod |
| 6 | `dualOutput`/`remoteInput` convergence | 把 2 条 expose 路径接到 `AcpChannel`/`EventBus` |

---

## 四、Stage 2：daemon 协议补齐（拆分 2a-2d，~3-4 周）

> **拆分动机**（chiga0 Recommendation 5）：原 Stage 2 6 项打包到 "1-2w"——protocol completion / observability / perf evaluation / ecosystem 是 4 个不同 workstream，混在一起 review/merge 阻塞。

| Sub-stage | 内容 | 工作量 |
|---|---|---|
| **2a Protocol** | WebSocket bidi + `/health?deep=1` + `POST /ext/:method` + permission policy schema | ~5-7d |
| **2b Ecosystem** | OpenAPI codegen + `HttpTransport` SDK 适配器 | ~5-8d |
| **2c Observability** | Prometheus metrics + mDNS + `--max-sessions` guard rail | ~3-5d |
| **2d Perf eval + docs** | TTI / streaming / memory baseline + cookbook | ~4-5d |
| **合计**（可并行 2a/2c · 后接 2b · 收尾 2d）| | **~3-4 周** |

### 可选 Stage 2e — Native in-process

去掉 `qwen --acp` child 桥接，daemon 直接 import `QwenAgent`——省 ~50MB/workspace bridge child 开销 + IPC 延迟。需解决 `acpAgent.ts:601 loadSettings(cwd)` 跨 workspace 污染。工作量 ~1-2 周。**仅在大规模 SaaS（500+ session / 机）必需时推进**。

---

## 五、External Reference Architecture（参考实现，非项目路线图）

> qwen-code 主线只交付 daemon building block。下面是给外部集成方（商业平台 / k8s operator / 云厂商）的设计参考蓝图，**不在 qwen-code 项目路线图**。

### 5.1 Cross-Daemon Orchestrator（跨 daemon process / 跨机器）

| 组件 | 工作量参考 |
|---|---|
| `qwen-coordinator` HTTP front | ~3-5d |
| Daemon process pool / spawn-per-tenant | ~2-3d |
| Cross-daemon sessionId → daemonUrl 注册表 | ~2d |
| Cross-daemon aggregate API | ~2d |
| Sticky cookie / failover routing | ~2-3d |
| **合计** | **~1.5-2 周** |

> **何时需要**：单机 daemon 容量到顶（N=50+ workspaces 或 cross-tenant 隔离要求）需要多 daemon process 时；k8s 多 pod 部署时。单机单 daemon 完全不需要本节。

### 5.2 Multi-tenancy + OIDC + Quota + Audit

> 🚨 **Multi-Tenant 关键约束**（Stage 1 commit `6a170ef8` 后）：daemon 同 workspace channel 内 N session **共享同 `qwen --acp` child 的 OS 权限**。**不可让多 tenant 共一个 workspace channel**——orchestrator 必须在以下两层之一做 1:1 tenant 绑定：
> - **Workspace 层（推荐）**：1 tenant ↔ 1 workspace
> - **Daemon process 层（高安全）**：1 tenant ↔ 独立 daemon process

| 组件 | 工作量参考 |
|---|---|
| Tenant 抽象 + Workspace ACL | ~3-5d |
| AuthN 4 模式（Bearer / OIDC / mTLS / cookie）| ~5-7d |
| Quota engine（Redis sliding-window + reservation）| ~5-7d |
| Audit log 4 通道（jsonl / syslog / OpenTelemetry / Kafka）| ~3-5d |
| **合计** | **~3-4 周 / 1-2 人** |

### 5.3 Shell Sandbox

主线 daemon 默认 **NoSandbox**——agent 跑 daemon 进程权限（PR#3889 现状）。同 workspace N session 共享同 `qwen --acp` child 的 OS 权限，多 tenant / 跨用户必须由 orchestrator 做 daemon-per-tenant 隔离。

| 方向 | 方案 | 工作量参考 |
|---|---|---|
| 本地 sandbox | OS user 切换 / Linux namespace / Container（Docker/Podman）| ~2-3w |
| 远程 sandbox | SSH / gRPC / k8s Job / containerd over TCP | ~2-3w |
| **合计** | | **~4-6 周 / 1 人** |

### 5.4 SaaS deployment

| 组件 | 工作量参考 |
|---|---|
| k8s native（StatefulSet + PVC + Service mesh）| ~1-2w |
| Postgres state + Redis cache + S3 transcript | ~1-2w |
| Multi-region / cross-geo scheduling | ~1-2w |
| **合计** | **~3-6 周 / 2-3 人** |

---

## 六、vs OpenCode（最相似的竞品）

### 设计哲学

| 维度 | OpenCode | Qwen Daemon |
|---|---|---|
| 进程模型 | 单 daemon 多 session 跨 workspace 共享 | **PR#3889 Stage 1 = channel per workspace + N session multiplexed**（同 workspace in-process N-session 与 OpenCode 对齐；跨 workspace OS 进程级隔离；Stage 2e 可选演进解决跨 workspace 共享）|
| `process.cwd()` | 永不改变 | 同款 |
| 上下文传播 | Effect-TS `LocalContext` | Stage 1 wire 自带 sessionId 路由；Stage 2e 需 Node 内建 `AsyncLocalStorage`（不引 Effect-TS）|
| HTTP 框架 | Hono | Express 5（复用 vscode-ide-companion）/ Hono 可选 |
| 协议 schema | OpenAPI codegen（13525 行 `openapi.json`）| **复用 ACP NDJSON zod schema**（已有 838 行 ACP agent）|
| Session 共享 | 否（per-SDK call）| **默认 `sessionScope: 'single'` + live collaboration 模型** |
| 数据持久化 | SQLite（drizzle-orm）| JSONL（PR#3739）+ SQLite for permission decisions |
| 默认安全 | 无 token 警告，仍启动 | **无 token + 0.0.0.0 拒绝启动** |

### 5 大独有选择

1. **复用 ACP zod schema 而非自创 OpenAPI**——0 设计成本 + 与 IDE/Zed 生态天然兼容
2. **多 channel 路由**（IM / VSCode / Web / SDK 全走 SessionRouter）—— Qwen Channels 已有
3. **PR#3723 应用层权限流**（4 mode 共享 evaluatePermissionFlow）
4. **默认 0.0.0.0 + 无 token = 拒绝启动**（比 OpenCode 严格）
5. **Multi-expose 路径 convergence**（Stage 1.5-prereq finding 1）—— 抽 `AcpChannel` 到 `@qwen-code/acp-bridge` 让 6 条 expose 路径共享同一组多 session primitives

### 性能对比预期

| 维度 | OpenCode（实测）| Qwen Stage 1 channel-per-workspace | Qwen Stage 2e native in-process |
|---|---|---|---|
| 启动时间 | ~2-3s | ~2-3s | 类似 |
| 首 session 创建（新 workspace）| <100ms | ~1-3s（spawn child）| <100ms |
| 同 workspace 第 N session | <50ms | **<200ms**（attach channel）| <50ms |
| 跨 workspace 第二个 session | <50ms | ~1-3s（不同 child）| <50ms（如解 cwd 污染）|
| 100 同 workspace session 内存 | ~100-150MB | 类似 ~100-150MB | 类似 |
| 100 跨 workspace session 内存 | ~200MB | ~6-10GB（100 child）| 类似 OpenCode |

**结论**：Stage 1 同 workspace 高密度场景已对齐 OpenCode 经济性；跨 workspace 高密度场景 OpenCode 仍优，Stage 2e 是 Qwen 的可选演进。

---

## 七、vs Anthropic Managed Agents

> **本节是 External Reference Architecture 范畴**——qwen-code 主线只交付 daemon building block，不直接对标 Anthropic Managed Agents（云 SaaS 平台）。本节对比的是**基于 qwen-code daemon + 完整 External Reference Architecture 包装出来的 "Managed Qwen Agents" 产品** vs Anthropic Managed Agents。
>
> **免责声明**：基于 Anthropic 公开文档（截至 2026 Q1）；Managed Agents 是闭源服务，具体细节、定价、内置工具可能已变更。本系列与 Anthropic / Qwen 团队均无关联。

### 架构哲学相似性

Anthropic Managed Agents 的内部模型很可能是 per-session container/process（云原生隔离的最自然形态）；**Qwen daemon Stage 1 channel-per-workspace 在同 workspace 内偏离纯 per-session 隔离**（共 OS 权限 + 共 MCP），跨 workspace 仍保持进程级隔离。Anthropic 内部具体实现未公开，可能也走类似 hybrid 模型节省 container baseline。

| 维度 | Anthropic Managed Agents | Qwen daemon |
|---|---|---|
| 本质 | 云托管 SaaS agent runtime | 自托管 agent daemon |
| 代码 | 闭源 | Apache-2.0 开源 |
| 模型 | Claude only | 任意 provider（DashScope / Claude / OpenAI / 自训练）|
| 进程模型 | 推测 per-session container/process 或 hybrid | channel-per-workspace + N session multiplexed |
| Session 共享 | per call 独立 / 持久化跨 call | sessionScope:single 多 client 共享 |
| 多租户 | Anthropic 管理 | 由 External orchestrator 做 1 tenant 1 workspace / daemon process |

### 关键差异

- **自托管 vs 云托管**：Qwen 走 building block 路线；Anthropic 提供托管服务
- **多 channel 生态**：Qwen 通过 Channels 包 + IM 路由原生支持 Telegram / 微信 / 钉钉 / Slack；Anthropic 只暴露 API
- **Java SDK 直连**：Qwen 唯一有 Java acp-sdk，daemon 后跨语言更顺
- **Background tasks 4 kinds 跨 client 可见**：Qwen kind framework（PR#3836）能在 daemon 模式下让所有 client 看到所有后台任务（agent/shell/monitor/dream）

---

## 八、风险与缓解

| 风险 | 缓解 |
|---|---|
| 单 daemon process OOM / race condition | 外部 orchestrator（systemd / k8s）自动重启；transcript JSONL 持久化保证 PR#3739 fork-resume；Stage 1.5 must-have #2 `loadSession` HTTP 后 client 跨 daemon restart 重建 |
| MCP server 跨 session 状态泄漏 | per-server `requiresPerSession` flag fallback；同 workspace N session 共享需审计；跨 workspace 进程级隔离不受影响 |
| FileReadCache 与 history rewrite 同步 | PR#3810 已修 5 路径 |
| Bearer token 泄漏 | 默认 0.0.0.0 binding 拒绝启动 + timing-safe compare + 401 uniform |
| `process.chdir()` 误调 | 落地后 grep audit + CI 守卫 |
| 与现有 ACP agent 行为不一致 | Stage 1 stdio 桥接持续保留作 reference impl |
| 用户期望"开箱即用 SaaS"失望 | README 顶部明确 scope：daemon building block，平台层外部实现 |

---

## 九、不复用 / 待弃用资产

| 资产 | 处理 | 理由 |
|---|---|---|
| `ProcessTransport.ts` 的 `spawn` 逻辑 | 不复用 | 假设对端是 CLI 子进程；daemon 模式下对端是 HTTP server，HttpTransport 从零写 |
| `vscode-ide-companion/src/ide-server.ts` | Stage 2 后逐步弃用 | VSCode 直接连 daemon 即可；保留 deprecation 期 |

---

下一篇：[← 回到 README](./README.md)
