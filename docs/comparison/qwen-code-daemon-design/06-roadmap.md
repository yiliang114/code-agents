# 06 — 路线图

> [← 上一篇：权限 / 认证](./05-permission-auth.md) · [下一篇：与 OpenCode 详细对比 →](./07-comparison-with-opencode.md)

> Qwen Code 项目本身只承诺 **"daemon building block"** —— 把 ACP NDJSON 协议通过 HTTP+SSE 暴露成可被任何外部 client / 编排器消费的服务。多 session orchestrator / 多租户 / SaaS 部署等"平台层"由外部实现（商业平台 / k8s operator / 云厂商定制），项目提供 [§13](./13-single-vs-multi-session-design.md) / [§14](./14-orchestrator-multi-tenancy.md) / [§03 §8.2](./03-http-api.md#82-orchestrator-层-apiexternal-reference-architecture) 作为参考架构蓝图。

## 总览

```
qwen-code 主线（~7-10 周 feature complete · Stage 1 merge ~1-2w + Stage 1.5 ~3-4w + Stage 2 ~3-4w）：
├─ Stage 1     ✅ **MERGED 2026-05-13** (PR#3889 merge commit `870bdf2a`, 84 commits / +12993/-194, 经 5 轮 multi-model audit + chiga0 三轮 follow-up + LaZzyMan/tanzhenxin reviews 收敛)
│              │
│              └─ Mode B headless qwen serve · 1 daemon + M qwen --acp children (1 per workspace)
│                 + N sessions multiplexed per workspace via QwenAgent.sessions: Map
│                 + 默认 --max-sessions=20 · --max-connections=256
├─ Stage 1.5   🆕 (~3-4 周总计, 1.5a / 1.5b / 1.5c 可并行)
│   ├─ Stage 1.5a chiga0 10 must-haves（blockers 3 + reliability 4 + ergonomics 3，~2-3 周）
│   ├─ Stage 1.5b Mode A `qwen --serve` flag（~4d 增量）
│   └─ Stage 1.5c daemon-side state CRUD（远端 client 功能等价 Mode A，~3-5d，[§09 §〇·五](./09-tui-compatibility.md#〇五mode-b-远端-client-限制--stage-1-scope-choice建议-stage-152-切到-option-b)）
└─ Stage 2     🆕 (~3-4 周, 2a-2d 拆分) daemon 完善 · 可选 Stage 2e native in-process（去 qwen --acp child）~1-2w

────────── qwen-code daemon feature complete ──────────

External Reference Architecture（外部 / 商业层，参考实现）：
├─ Cross-Daemon Orchestrator（跨 daemon process / 跨机器路由 / failover）  → §13 / §03 §8.2 设计参考
├─ Multi-tenancy (Tenant / OIDC / Quota / Audit)              → §14 设计参考
├─ Shell sandbox (NoSandbox / OS user / Namespace / Container) → External 设计
└─ SaaS deployment (k8s / Postgres / Redis / S3)              → External SaaS HA / §14 §七 设计参考
```

**核心判断**：qwen-code 是 building block，不是 SaaS 平台。Stage 1 + Stage 1.5 + Stage 2 完成后 daemon 协议表面 100% 稳定，外部集成方（如阿里云 DashScope / 自建团队 / 用户）可基于此自由实现 orchestrator + 多租户 + SaaS。这与 OpenCode（端到端 SaaS 路线）的设计哲学相反——后者绑定平台决策，前者保持 Unix 风格的可组合性。

> **Stage 1 架构演进**（2026-05-12 commit `6a170ef8`）：早期设计假设 "1 daemon = 1 session = 1 `qwen --acp` child"——但 PR#3889 review 过程中（LaZzyMan / tanzhenxin / 维护者反馈）发现 `packages/cli/src/acp-integration/acpAgent.ts:194` 的 `QwenAgent.sessions: Map<string, Session>` 已原生支持单 child 多 session。Stage 1 bridge 因此重构为 "**1 daemon + M qwen --acp children（1 per workspace）+ N sessions multiplexed per workspace via QwenAgent.sessions: Map**"，N=5 同 workspace session 内存从 300-500MB（5 child）降到 60-100MB（1 child + 5 session）。**跨 workspace 仍需独立 child**（`acpAgent.ts:601` 在 `newSession` 时 `loadSettings(cwd)` 重新加载 settings，跨 workspace 复用会互相污染）——Stage 2e native in-process 才能解决。

> **前置 PR 全部已合并**（2026-05-06 之前）：PR#3717 FileReadCache + PR#3810 5 路径 invalidation + PR#3723 共享 permission flow + PR#3739 transcript-first fork + PR#3642 `/tasks` + PR#3818 MCP rediscovery coalesce + PR#3836 Kind framework——daemon 化前置基础就绪。

---

## Stage 1：Mode B headless `qwen serve`（PR#3889 ✅ MERGED 2026-05-13 · 84 commits · +12993/-194）

### 目标

提供 daemon 的最小可用形态——`qwen serve` headless 进程，通过 HTTP+SSE 暴露 ACP NDJSON 协议。1 daemon + M `qwen --acp` children（1 per workspace）+ N sessions multiplexed per workspace via `QwenAgent.sessions: Map`（[§02 §2](./02-architectural-decisions.md#2-状态进程模型)）。**单机多 workspace 已由 daemon 内部 `byWorkspaceChannel` spawn child 处理**（commit `6a170ef8`）；跨 daemon process / 跨机器 / 多 tenant 隔离才需要外部 orchestrator。Stage 2e native in-process 进一步把 child 桥接也去掉，daemon 直接持 `QwenAgent`。

### 实现

```
[现有] qwen --acp                 → stdio NDJSON ACP agent · QwenAgent.sessions: Map 原生多 session
[Stage 1] qwen serve              → Express 5 HTTP server
                                  → 内部 spawn `qwen --acp` per workspace（不再 per session）
                                  → byWorkspaceChannel: Map<workspace, ChannelInfo>
                                  → connection.newSession({cwd, mcpServers}) 加新 session 到 existing channel
                                  → HTTP body ↔ stdio NDJSON 桥接
                                  → SSE 事件流给多 client
```

### Stage 1 内存模型（commit `6a170ef8` 数据）

| N 同 workspace session | 早期设计（1 child per session）| 当前实现（1 child per workspace）|
|---|---|---|
| 1 | ~60-100 MB RSS | ~60-100 MB RSS（相同）|
| 5 | 300-500 MB RSS | **60-100 MB RSS**（节省 ~5x）|
| 10 | 600-1000 MB RSS | **80-150 MB RSS**（节省 ~6-7x）|
| OAuth refresh | N× | 1× per channel |
| FileReadCache | N× 独立 | shared per channel |
| CLAUDE.md parse | N× | parse 一次 per channel |
| Cold start（第 N 个 session）| ~1-3s | ~1-3s（首个 session）/ <200ms（后续 same workspace）|

### 工作清单（设计估算）

| 任务 | 工作量 | 文件 |
|---|---|---|
| 新建 `packages/server/` 包 | 0.5d | `packages/server/package.json` |
| `qwen serve` CLI cmd | 0.5d | `packages/cli/src/cli/cmd/serve.ts` |
| Express 5 HTTP server scaffold（复用 ide-server.ts CORS+Bearer+Origin lock 模板）| 0.5d | `packages/server/src/index.ts` |
| HTTP→stdio bridge | 2d | `packages/server/src/bridge/HttpAcpBridge.ts` |
| Auth middleware | 0.5d | bearer token 校验 |
| `/session/*` 路由 | 1d | 复用 ACP request schema |
| SSE event stream | 1d | NDJSON → SSE 适配 |
| 文档 + 示例 + e2e 测试 | 1d | |
| **合计** | **~7-8 天 / 1 人** | ~700-1000 行新增代码 |

### Stage 1 PR#3889 实现 audit（最近更新 2026-05-12 第三轮）

> 累计更新历程：commits 23 → 32 → 78 → **84** / +7698/-46 → +8883/-4 → +12993/-194 → **+12993/-194 (final)** / 经历 5 轮 multi-model audit + LaZzyMan / tanzhenxin reviews + chiga0 三轮 follow-up + 维护者 N:1 framing 反馈 → **2026-05-13 06:47 UTC merged (merge commit `870bdf2a`)**。

[**PR#3889**](https://github.com/QwenLM/qwen-code/pull/3889) `feat(cli,sdk): qwen serve daemon (Stage 1)` —— **✅ MERGED 2026-05-13 06:47 UTC**（merge commit `870bdf2a`）**+12993/-194 / 84 commits** —— Stage 1 scope 代码完成 + 文档 100% 补全 + 5 轮 multi-model audit + chiga0 三轮 follow-up + LaZzyMan/tanzhenxin reviews 全部收敛。

#### 最新关键 commits（2026-05-12）

| Commit | 说明 |
|---|---|
| **`6a170ef8`** | 🌟 **架构重构**：Stage 1 bridge 改为 multiplex sessions on one `qwen --acp` child per workspace（复用 `QwenAgent.sessions: Map`）。N=5 内存 300-500MB → 60-100MB |
| **`f29353a2`** | 🌟 **N:1 framing 修正**：纠正"qwen-code 不支持多 session 资源共享"的早期错误描述（来自 LaZzyMan + 维护者反馈）；指明 `acpAgent.ts:194` 已支持多 session |
| **`bbc7b8b6`** + `b1767903` | chiga0 第 3 轮 review：Stage 1 scope honesty + 10 must-haves for Stage 1.5+ + durability model 显式化 |
| `8de72dcf` + `9352627f` | LaZzyMan reviews：Mode A vs Mode B 语义澄清 + Stage 1 scope 边界 |
| `734d833b` | 7 review threads close：atomic write / read-size cap / force-exit on 2nd signal / doc fixes |
| `e18b8fa6` + `b37cc01c` | 12 review threads close 两轮：6 critical bugs + 6 follow-ups |

#### 1️⃣ 体量与预估对比

| 维度 | 预估（本节工作清单）| 实际（PR#3889 2026-05-12）| 倍数 |
|---|---|---|---|
| LOC | ~700-1000 行 | **+12393 / -194**（含测试 + 文档；剔除测试 + 文档 ~7000 LOC）| **7x-12x** |
| 工作量 | ~7-8 天 / 1 人 | 多周（84 commits 跨 5 轮 multi-model audit + LaZzyMan/tanzhenxin/chiga0 reviews + N:1 framing 重构）| 几周 vs 1 周 |
| 提交数 | — | **84 commits**：7 实现 + 多轮 self-audit / review round（claude-opus-4-7 / gpt-5.5 / deepseek 多模型）+ chiga0 三轮 follow-up + LaZzyMan reviews + tanzhenxin reviews + 维护者 N:1 framing 反馈 + 架构重构（6a170ef8 channel per workspace） + Stage 1 docs + merge/lint | — |

**超出原因**（设计 → 实现的工程现实）：

| 原因 | 详情 |
|---|---|
| **EventBus + ring replay + Last-Event-ID 重连** | 原 §03 §三 计划放在 External Reference Architecture / SaaS HA 才详做，PR#3889 提前到 Stage 1（client_evicted overflow + bounded subscriber queues 都做了）|
| **Timing-safe bearer compare** | §05 设计为 Bearer，PR#3889 加 SHA-256 + `crypto.timingSafeEqual` + 401 uniform across no-header/bad-scheme/wrong-token，对应 §05 side-channel 防御（设计在 §05 但 Stage 1 实现）|
| **IPv6 loopback ergonomics** | `::1` / `[::1]` / `host.docker.internal` 等 LOOPBACK_BINDS 边界，原设计未具体化 |
| **EventBus correctness** | `client_evicted` overflow / replay ring / AsyncIterable abort handling 等几百行 |
| **Self-audit + multi-model reviewer rounds + 多 reviewer follow-up** | 84 commits 中 ~25 轮 audit（self-audit 1-10 + reviewer rounds 1-7 + chiga0 三轮 follow-up + LaZzyMan reviews + tanzhenxin reviews + 后续 multi-model review threads close）—— PR#3889 体量超出的最大来源；多模型审（claude-opus-4-7 + gpt-5.5 + deepseek）累计 close ~60+ review threads |
| **🌟 架构重构（commit `6a170ef8` 2026-05-12）** | Stage 1 bridge 重构为 multiplex sessions on one `qwen --acp` child per workspace（复用 `QwenAgent.sessions: Map`）；新增 `ChannelInfo` 类型 + `byWorkspaceChannel: Map` + `getOrCreateChannel(workspaceKey)` coalesce + `connection.newSession({cwd, mcpServers})` 多 session 多路复用 + `killSession` 引用计数清理。这是最 expensive 的 follow-up（原设计完全没料到这个能力可以在 Stage 1 实现）|
| **DaemonClient SDK** | §03 没单独估算 SDK 端，但 sibling 同步实现 `parseSseStream` / `DaemonHttpError` |
| **child-crash recovery** | reviewer round 4 加，原设计未含 |
| **Stage 1 文档补全** | commit `27a164c` 补 §06 设计原计划的 1d "documentation + examples" 任务：`docs/users/qwen-serve.md`（用户 quickstart）+ `docs/developers/qwen-serve-protocol.md`（HTTP 协议 reference）+ `docs/developers/examples/daemon-client-quickstart.md`（SDK ts 示例）+ README "Daemon mode" 入口 |
| **chiga0 第 3 轮 review docs**（`bbc7b8b6`）| Stage 1 scope honesty + durability model 显式化 + 10 must-haves for Stage 1.5+ |

#### 2️⃣ 实现的 9 个 STAGE1_FEATURES（capabilities envelope）

```
['health', 'capabilities', 'session_create', 'session_list',
 'session_prompt', 'session_cancel', 'session_events',
 'session_set_model', 'permission_vote']
```

逐项映射设计章节：

| Feature | 路由 | 设计章节 |
|---|---|---|
| `health` | `GET /health` | §03 §一 |
| `capabilities` | `GET /capabilities`（9 tags）| §08 §三（Stage 1 协议兼容性）|
| `session_create` | `POST /session` | §03 §一 |
| `session_list` | `GET /workspace/:id/sessions` | §03 §一 |
| `session_prompt` | `POST /session/:id/prompt`（per-session FIFO + no-poison）| §03 §一 + 决策 §6 prompt FIFO |
| `session_cancel` | `POST /session/:id/cancel` | §03 §一 |
| `session_events` | `GET /session/:id/events` SSE + Last-Event-ID + 15s heartbeat | §03 §三 SSE 重连 |
| `session_set_model` | `POST /session/:id/model`（publishes `model_switched`）| §03 §一 |
| `permission_vote` | `POST /permission/:requestId` first-responder | §03 §三 + §02 §6 决策 + §05 §3 |

#### 3️⃣ 核心 commits breakdown

| Commit | 关注章节 |
|---|---|
| `61f2f59a1` scaffold `qwen serve` Express + auth + Host allowlist + /health + /capabilities | §03 §一 + §05 §1 |
| `8d7c03a5f` HttpAcpBridge spawn `qwen --acp` per workspace（早期 sessionScope:single 复用一个 session）+ ACP 10s init + BridgeClient fs proxy | §02 §1 + §04 进程模型 |
| `ca996ecb5` POST /prompt FIFO + /cancel + SessionNotFoundError | §03 §一 + 决策 §6 |
| `41aa95094` EventBus + SSE Last-Event-ID + 15s heartbeat + ring replay + client_evicted overflow | §03 §三 SSE Last-Event-ID + §11 §五 liveness |
| `6ee655f0a` POST /permission first-responder vote + cancelSession resolves outstanding | §02 §6 决策 + §05 §3 |
| `8206a64b5` SDK DaemonClient + DaemonHttpError + parseSseStream | §08 SDK / ACP 协议兼容性 |
| `a8ce5e08d` /workspace/:id/sessions + /session/:id/model + errorMessage helper | §03 §一 |
| `ad0e6ec06` audit round 1: timing-safe bearer / coalesce spawnOrAttach / parseLastEventId / IPv6 / failOnError | §05 §1 + §05 |
| 中间 ~14 commits（self-audit 2-10 + reviewer rounds 1-7 multi-model）| 持续 audit close ~30 review threads |
| `27a164c` Stage 1 docs：用户 quickstart + HTTP 协议 reference + SDK ts 示例 + README "Daemon mode" 入口 | §03 §一 + §05 + §08 |
| **`6a170ef8`**（2026-05-12 🌟）| **架构重构** —— `ChannelInfo` + `byWorkspaceChannel: Map` + `getOrCreateChannel` coalesce + `connection.newSession({cwd, mcpServers})` multiplex N session per workspace + `killSession` 引用计数清理 | §02 §2 + §04 进程模型 |
| **`f29353a2`**（2026-05-12 🌟）| **N:1 framing 修正 docs** —— qwen-code 自身 `QwenAgent.sessions: Map` 已支持多 session（VSCode 插件早就用），更正早期文档措辞 | docs/users/qwen-serve.md |
| **`bbc7b8b6`** + `b1767903`（2026-05-12）| chiga0 第 3 轮 review：Stage 1 scope honesty + 10 must-haves for Stage 1.5+ + Durability model section（must-have #10 shipped）| §06 Stage 1.5 段 |
| `8de72dcf` + `9352627f`（2026-05-12）| LaZzyMan reviews：Mode A vs Mode B 语义澄清 + Stage 1 scope 边界 | §02 §7 |
| `734d833b` / `e18b8fa6` / `b37cc01c` 等多轮（2026-05-12）| 后续 ~30 review threads close：atomic write / read-size cap / force-exit on 2nd signal / 6 critical bugs + 6 follow-ups | 多章节 |

#### 4️⃣ 设计 vs 实现对应度评估

| 章节 | 对应度 |
|---|---|
| §02 §1 sessionScope='single' default | **100%** ✓ |
| §02 §6 prompt FIFO + first responder | **100%** ✓ |
| §03 §一 路由表 | **100%**（daemon 层核心路由全实现）|
| §03 §二.2 复用 ACP zod schema | **100%** ✓ |
| §03 §三 SSE | **100% Stage 1 scope**（SSE 完整；WebSocket 在 Stage 2 范畴内）|
| §05 §1 Bearer token | **100%** + 加 timing-safe compare + 401 uniform |
| §05 §6.1 0.0.0.0 拒绝默认 | **100%** ✓ |
| §08 capabilities envelope | **100%**（9 tags 实现）|
| §03 §三 SSE Last-Event-ID 重连 | **100%**（ring + replay + 15s heartbeat）|
| §11 §五 liveness 协议（Stage 1 子集）| **100%**（server-push 15s SSE keepalive + req.close TCP RST 即时剔除 + client_evicted overflow 全部实现；client-POST heartbeat / SessionCleaner 是 Stage 2+ 范畴）|
| §10 远端 CLI / Capability 反向 RPC | **0%**（Stage 1 不含；External 范畴）|
| **Stage 1 文档**（user guide + HTTP 协议 reference + SDK 示例）| **100%**（commit `27a164c` 补全 §06 §"Documentation + examples + e2e tests" 1d 任务）|

**综合**：100% Stage 1 范畴内的设计决策 1:1 实现；文档 100% 补全；少数偏差都是**设计向更严格演进**（timing-safe SHA-256 + crypto.timingSafeEqual / 401 uniform across no-header/bad-scheme/wrong-token / IPv6 loopback ergonomics），不是简化。**✅ Stage 1 已合并 2026-05-13 06:47 UTC**（merge commit `870bdf2a`），收敛了 chiga0 三轮 follow-up + LaZzyMan/tanzhenxin reviews + 维护者反馈。下一步开 Stage 1.5（chiga0 10 must-haves + Mode A `qwen --serve` + daemon-side state CRUD）follow-up。

#### 5️⃣ 经验沉淀

| 经验 | 详情 |
|---|---|
| **EventBus 在 Stage 1 就需要完整实现** | 原计划放在 External Reference Architecture / SaaS HA 详做，但 SSE Last-Event-ID 重连是 Stage 1 用户必需，无法 deferred |
| **Timing-safe / 401 uniform 等 side-channel 防御 Stage 1 就要做** | §05 设计放在多租户章节，但 PR#3889 在 Stage 1 单租户也做了——开源 daemon 默认就该这么严 |
| **IPv6 loopback ergonomics 不能省略** | 容器化 / Docker / `host.docker.internal` 是常见用例，loopback 处理细节比预想复杂 |
| **多轮 self-audit + multi-model + 多 reviewer follow-up 流程的价值** | PR#3889 用 ~25 轮 audit（self-audit 1-10 + reviewer rounds 1-7 + chiga0 三轮 follow-up + LaZzyMan reviews + tanzhenxin reviews）—— close ~60+ review threads；不同模型 / 不同 reviewer 抓不同类问题（race / leak / IPv6 / SSE / Windows / env whitelist / abort timeout / N:1 framing / Stage scope honesty 互补覆盖）|
| **child-crash recovery 是必需的** | reviewer round 4 才补；spawn 子进程模式下，子进程崩溃时 daemon 必须 graceful 处理而不是把错误传播给所有 SSE clients；commit `6a170ef8` 后扩展为 channel-level crash（一 channel 崩溃 → 该 workspace 全部 N session 收 `session_died` 事件）|
| **架构能在 Stage 1 内重构**（commit `6a170ef8`）| reviewer 反馈触发架构反思——`QwenAgent.sessions: Map` 已具备多 session 能力（VSCode 插件早就用），bridge 不该假设 1 child = 1 session。教训：reviewer 多视角能发现"设计偏差"而非仅"实现 bug" |
| **PR 体量 ~7x-12x 预估是常态** | 工程文档预估 vs 实际几乎总是 7x-12x，因为 audit + 边界 + ergonomics + 文档 + 反向架构修订 占大头 |
| **文档不能 deferred 到 merge 后** | 原 §06 §1 "1d Documentation + examples" 在主实现之后被推迟；commit `27a164c` 补回（591 行 docs）。教训：文档要列入 PR scope 否则 merge 后没人会回填 |

#### 6️⃣ Stage 1 不含 / 推到 Stage 1.5 / Stage 2 / 外部的能力

| 能力 | 状态 |
|---|---|
| Per-request `sessionScope` override + `loadSession` HTTP 暴露 + pair token registry | **Stage 1.5a**（chiga0 blockers 1-3）|
| Client heartbeat / `permission_already_resolved` event / 大 replay ring / `slow_client_warning` | **Stage 1.5a**（chiga0 reliability 4-7）|
| `POST /session/:id/_meta` + `/capabilities` protocol_versions 协商 | **Stage 1.5a**（chiga0 ergonomics 8-9）|
| Mode A（CLI + HttpServer，`qwen --serve`）| **Stage 1.5b**（~4d，可与 1.5a 并行）|
| `WS /session/:id`（双向 WebSocket）| **Stage 2a** |
| OpenAPI 自动生成 + HttpTransport SDK 适配器 | **Stage 2b** |
| 多 token / per-client identity / pair tokens / revocation | **Stage 1.5a** Blocker #3（不在 Stage 2 范畴）|
| mDNS 服务发现 + Prometheus metrics endpoint + `--max-sessions` flag | **Stage 2c** |
| Native in-process（去 `qwen --acp` child 桥接） | **可选 Stage 2e**（~1-2w）|
| `POST /file/read` / `/file/write` | **External / Stage 2 可选**（agent 已有 fs，daemon-only file API 仅给远端 client 用）|
| Mobile / browser UI | **External**（参考 [§10 远端 CLI 模式](./10-remote-cli-mode.md)；PR#3929-3931 平行 stack 已有 mobile UI 参考）|
| Pairing token / LAN URL | **External**（参考 PR#3929-3931）|
| Cross-Daemon Orchestrator（跨 daemon process / 跨机器路由 / failover） | **External**（单机内多 session 已由 daemon 自身 in-daemon orchestration 解决；参考 [§03 §8.2](./03-http-api.md#82-orchestrator-层-apiexternal-reference-architecture) + [§13](./13-single-vs-multi-session-design.md) + [§14](./14-orchestrator-multi-tenancy.md)）|
| Multi-tenancy / OIDC / Quota / Audit | **External**（参考 [§14](./14-orchestrator-multi-tenancy.md)）|
| Shell sandbox（OS user / namespace / container / remote）| **External**（参考本章 Shell Sandbox 段）|

#### 7️⃣ Stage 1 主线 HA 与稳定性已覆盖范围

qwen-code 主线 HA / 稳定性需求由 PR#3889 + PR#3739 已完整覆盖（详细 SaaS 部署 HA / 长跑稳定性蓝图作为 External Reference Architecture）：

| 机制 | 实现 | 覆盖 |
|---|---|---|
| **Daemon crash 自动重启** | 由外部进程管理器（systemd / k8s / orchestrator）负责 | 单 daemon 进程崩溃 → 重启 |
| **Transcript-first fork resume** | PR#3739 已合并 | 新 daemon 启动 replay transcript JSONL 重建 session 状态（但 PR#3889 Stage 1 不在 HTTP 上暴露 `loadSession` —— chiga0 must-have #2 推到 Stage 1.5）|
| **SSE Last-Event-ID 重连** | PR#3889 commit `41aa95094` | client 网络抖动 / daemon 重启后断点续连（详细协议见 [§03 §三](./03-http-api.md#三sse--websocket-事件流核心)）|
| **Crash isolation 半径**（commit `6a170ef8` 后修订）| 1 channel per workspace（含 N session）| Stage 1：一 channel 崩溃影响该 workspace 全部 N 个 session（不再是 1 个），其他 workspace channel 不受影响。`session_died` 事件 fan-out 到所有 session 的 SSE 订阅者；无 resume，client 须 `POST /session` 重建 |
| **资源 cleanup 简单** | OS process exit + channel teardown | kill daemon = 清理所有 fd / child / memory；`killSession` 引用计数清理（其他 session 仍在的 workspace 保留 channel）|
| **timing-safe bearer auth + 401 uniform** | PR#3889 commit `ad0e6ec06` | 防 side-channel 攻击 |
| **Durability model**（chiga0 must-have #10）| 显式 documented as ephemeral | Stage 1 sessions 不跨 daemon restart 存活；`writeTextFile` atomic across crash 但 not across restart；ring overflow on long disconnects |

主线**不需要**：multi-pod sticky session / Postgres Patroni / Redis Sentinel / per-tenant heap budget / Worker thread tenant isolation / 30 天 Soak/Chaos 测试矩阵 等——这些都是 External SaaS 运营层关切，作为 External Reference Architecture 设计参考蓝图。

---

## Stage 1.5：chiga0 10 must-haves + Mode A flag（~3-4 周总计，分 1.5a / 1.5b 两条并行 workstream）

### 来源

PR#3889 review 中 chiga0 第 3 轮 review（[#3889 comment 4427875644](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427875644)）从 IM bot / mobile companion / IDE extension 三个 downstream consumer 视角审计 Stage 1 protocol surface，得出结论："**Stage 1 promises 'real workloads' but the protocol surface is sized for demo / single-user / never-crashes**"。作者拒绝把 must-haves 加入 Stage 1（保持 Stage 1 scope honesty），全部推到 Stage 1.5。

### Stage 1.5 拆分（1.5-prereq + 1.5a + 1.5b 并行 + 1.5c 远端 client 功能等价）

| Sub-stage | 内容 | 工作量 |
|---|---|---|
| **Stage 1.5-prereq** | chiga0 6 architecture findings 重构（lift `AcpChannel` / `EventBus` / `PermissionMediator` 到共享包；finding 1-6 见下方）| ~1-2 周 |
| **Stage 1.5a** | chiga0 10 must-haves（blockers 3 + reliability 4 + ergonomics 3，其中 #10 已 shipped）| ~2-3 周 |
| **Stage 1.5b** | Mode A `qwen --serve` flag | ~4d 增量 |
| **Stage 1.5c** 🆕 | daemon-side state CRUD routes（远端 client 拿到 Mode A 本地 TUI 的 6-8 项 dialog 能力 — `/memory` / `/mcp` / `/agents` / `/tools` / `/approval-mode` / `/init` 等）| ~3-5d |
| **合计**（1.5-prereq → 1.5a + 1.5b + 1.5c 并行）| | **~4-5 周 / 1 人** |

### Stage 1.5-prereq — chiga0 6 架构重构 findings（cross-module unification）

> 来源：chiga0 PR#3889 第 2 轮 review [comment 4427773706](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427773706) "Follow-up architecture review — cross-module unification & extensibility"。指出 repo 已有 6 条独立 "expose agent capabilities" 路径（`acp-integration/` / `nonInteractive/` / `dualOutput/` / `remoteInput/` / `channels/` / `serve/`）+ 即将加入第 7 条（chiga0 #3930 `remote-control/`）；共享 ~80% machinery 但 ~0% abstractions。Stage 1 ships 4 个 inline `FIXME(stage-1.5, chiga0 finding N)` 标记作为 grep 锚点。

| # | Finding | 改造方案 | PR Stage 1 标记位置 |
|---|---|---|---|
| **1** | **`HttpAcpBridge` 混淆 transport 与 bridging** | 抽 `AcpChannel` interface（`SpawnedAcpChannel` Stage 1 / `InProcessAcpChannel` Stage 2e 两个实现）+ `Transport` interface（`SseTransport` / `WebSocketTransport` / `InProcessTransport`）+ 把 `EventBus` lift 出来。新包 `@qwen-code/acp-bridge` 让 `channels/base/AcpBridge` 和 `serve/HttpAcpBridge` 共享同一组多 session primitives（tanzhenxin 同样观察 [4428974701](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4428974701)）| `BridgeOptions` FIXME |
| **2** | **`EventBus` 私有于 HTTP/SSE** | 把 `EventBus` lift 到 top-level building block（`packages/event-bus` 或 `packages/core/src/events/`）；让 6 个 consumer 都通过 `EventBus.subscribe()` 接：SSE / WebSocket / InProcessTUI / Channel / DualOutput / EventLog | `EventBus` class header FIXME |
| **3** | **Permission flow 自实现 first-responder，不复用 `ControlDispatcher`** | Lift `PermissionMediator` interface + 4 种 strategy policy：`first-responder` / `designated(clientId)` / `consensus(minVotes)` / `local-only`（TUI behavior）。daemon / nonInteractive / channels 共享同一 mediator。同时 close chiga0 audit Risk 2（first-responder 缺 authorization model）| `BridgeClient.requestPermission` FIXME |
| **4** | **`BridgeClient.readTextFile`/`writeTextFile` 是 fs 的 fork** | Inject `FileSystemService` ctor dep，让 daemon 不再重新实现 fs。统一 BOM handling / 非-UTF-8 / line endings 行为，避免 Stage 1 client 看到与 Stage 2 不同的 fs 语义 | `BridgeOptions` FIXME |
| **5** | **Capability registry hard-coded** | `STAGE1_FEATURES` 9-tag 数组改成 plug-in capability registry；加 `POST /ext/:method` ACP extMethod 桥接给 vendor zero-fork 扩展；与 must-have #9 `/capabilities` actual feature negotiation 协同 | `STAGE1_FEATURES` FIXME |
| **6** | **`dualOutput` / `remoteInput` convergence** | 把另外 2 条 expose 路径也接到 `AcpChannel` + `EventBus` 抽象上；删除 cross-cut 重复（~600 LOC）| 跨多文件 |

**wenshao Stage 1 内已落地的关联工作**（[reply comment 4428724218](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4428724218)）：4 个 inline `FIXME(stage-1.5, chiga0 finding N)` 标记 + URL backlink，让未来 maintainer grep `chiga0 finding` 直接拉到 review。

### Stage 1.5a — chiga0 10 must-haves

### Stage 1.5a — chiga0 10 must-haves

#### 🚨 Blockers（生产用必需）

| # | must-have | 设计点 |
|---|---|---|
| 1 | **Per-request `sessionScope` override on `POST /session`** | 今天 daemon-wide default 是唯一设置；VSCode 扩展无法说"这个 window 我要独立 session"对抗一个配置为 shared 的 daemon。需 body 字段 `{ scope: 'single' \| 'thread' \| 'user' }` 覆盖 |
| 2 | **`loadSession` / `unstable_resumeSession` over HTTP** | 没这个，integration 无法 survive child crash 或 daemon restart；任何 orchestrator 也无法恢复状态。需 `POST /session/:id/load` + `POST /session/:id/resume` 路由 |
| 3 | **Persistent client identity（pair tokens + 客户端 revocation）** | Stage 1 用单 shared bearer；leak 一个 token 全员撤销，且 `originatorClientId` 是 client 自报而非 daemon 从认证身份盖章。需 token registry + revocation API |

#### 🛡️ Reliability baseline

| # | must-have | 设计点 |
|---|---|---|
| 4 | **Client-initiated heartbeat path** | 区分 "agent 思考中" 和 "daemon 死了"，不等 15s server heartbeat。需 `POST /session/:id/heartbeat` 或 SSE 双向 ping |
| 5 | **`permission_already_resolved` event** | 当 vote 在 first-responder race 中失败，UI 现在只能从 404 推断状态。需主动 event 通知 |
| 6 | **Larger / per-session-configurable replay ring** | default 4000 frames 覆盖短断开；mobile / chatty-turn workload 需 8000+ 或 per-session config |
| 7 | **`slow_client_warning` event before `client_evicted`** | Soft backpressure，让 well-behaved slow client 自我节流（trim render depth / drop chunks）before 被终结 |

#### 🎨 Integration ergonomics

| # | must-have | 设计点 |
|---|---|---|
| 8 | **`POST /session/:id/_meta` for IM-style context** | per-session key-value 附加到后续 prompt（chat id / sender / thread id）替代 per-channel improvisation |
| 9 | **`/capabilities` actual feature negotiation** | `protocol_versions: { acp: '0.14.x', daemon_envelope: 1 }` 让 client 能 detect drift 而非 fall through 到 "unknown frame, ignore" |
| 10 | **First-class durability documentation** | 已 shipped（commit `bbc7b8b6` `docs/users/qwen-serve.md` "Durability model" section）|

### Stage 1.5a 工作量估算

| Workstream | 工作量 | 说明 |
|---|---|---|
| **Blockers 1-3** | ~5-7d | loadSession 是大头 + token registry/revocation 中等 |
| **Reliability 4-7** | ~3-5d | 多个轻量事件 + ring config 改造 |
| **Ergonomics 8-9** | ~2-3d | /_meta + capabilities 协商（#10 durability docs 已 shipped）|
| **合计** | **~10-15d ≈ 2-3 周 / 1 人** | |

### Stage 1.5a 验收

- ✓ `POST /session` 接受 `{ scope: 'single' \| 'thread' \| 'user' }` body 字段
- ✓ `POST /session/:id/load` + `POST /session/:id/resume` 路由（HTTP 暴露 `loadSession` / `unstable_resumeSession`）
- ✓ token registry + `DELETE /tokens/:id` revocation API
- ✓ `POST /session/:id/heartbeat` client-initiated 心跳路由
- ✓ `permission_already_resolved` event + `slow_client_warning` event + per-session ring config + `POST /session/:id/_meta`
- ✓ `/capabilities` 返回 `protocol_versions` 字段

---

## Stage 1.5b：Mode A CLI + HttpServer（~4 天增量，可与 1.5a 并行）

### 目标

让 `qwen` CLI 进程同时挂载 HttpServer——TUI 在终端正常渲染，远端 client（WebUI / IDE / IM bot）通过 HTTP 接入同一 daemon。Mode A 的 daemon 可同时持 N session（同 Stage 1 channel-per-workspace 多 session multiplexed 机制），TUI 绑定其中某一个 session（[§02 §7 双部署模式](./02-architectural-decisions.md#7-daemon-部署模式clihttpserver-vs-headlesshttpserver)）。

### 实现

```bash
# 用户在终端跑：
qwen --serve --port 7776 [--token-file ~/.qwen/local-token]

# TUI 启动 + Express HTTP server 同进程
# 远端 client 通过 :7776 接入；TUI 是 super-client（保留 ~15 Ink dialogs + local-jsx，详 §02 §7）
```

### 工作清单

| 任务 | 工作量 | 文件 |
|---|---|---|
| `qwen --serve` flag 解析 | 0.5d | `packages/cli/src/cli/cmd/index.ts` |
| TUI 启动后挂 HttpServer | 0.5d | `packages/cli/src/cli/main.ts` |
| TUI 作为 in-process subscriber | 1d | `packages/cli/src/ui/services/InProcAdapter.ts`（新建）|
| 默认 auth/CORS 区分本地 vs 远端 | 0.5d | server config 分发 |
| 生命周期协同（Ctrl+C drain HTTP）| 0.5d | shutdown hook |
| 文档 + e2e | 1d | |
| **合计** | **~4 天 / 1 人** | ~300-500 行新增 |

### Stage 1.5b 验收

- ✓ `qwen --serve` 启动 TUI + HTTP server 同进程
- ✓ 远端 client 通过 HTTP 接入同 daemon（与 TUI 共享 EventBus）；同 workspace 内 daemon 可持 N session（继承 Stage 1 channel multiplexing），TUI 绑定其中一个
- ✓ TUI 退出 → HTTP server graceful drain → 整进程退出
- ✓ 默认 loopback only / no token（本地信任）；远端启用必须显式 `--token`
- ✓ 与 Stage 1 PR#3889 同 wire 协议（client SDK 不需要改）

---

## Stage 1.5c：daemon-side state CRUD（远端 client 完整功能等价 Mode A，补齐）

### 目标

让 Mode B headless 部署下的远端 client（TUI / Web UI / mobile）拿到与 Mode A 本地 super-client TUI **功能对等**的体验——不再是 thin shell。

### 来源

[§09 §〇·五](./09-tui-compatibility.md#〇五mode-b-远端-client-限制--stage-1-scope-choice建议-stage-152-切到-option-b) 分析显示：Stage 1 option A 让远端 client 是 thin shell（8/9 项 TUI dialogs 不可用），但这**不是技术约束，是 Stage 1 scope choice**——同行竞品（Cursor / Continue / Claude Code / OpenCode / Gemini CLI daemon）都让远端 UI 完整访问 daemon-side state。Qwen Code 当前 thin shell 限制是离群点。

Stage 1.5c 切到 option B（增量 wire route），用 ~3-5d 让 6-8 项 dialogs wire 化。

### 工作清单

| 任务 | 工作量 | 替代的 TUI dialog | capability tag |
|---|---|---|---|
| `GET/POST /workspace/:id/memory` —— 读写 `~/.qwen/memory.json` | 0.5d | `/memory` | `workspace_memory_crud` |
| `GET /workspace/:id/mcp` + `POST /workspace/:id/mcp/:server/restart` | 1d | `/mcp` | `workspace_mcp_management` |
| `GET/POST /workspace/:id/agents` —— agents 是 registered objects | 0.5d | `/agents` | `workspace_agents_crud` |
| `GET/POST /workspace/:id/tools` + `POST /workspace/:id/tools/:name/enable` | 0.5d | `/tools` | `workspace_tools_crud` |
| `POST /session/:id/approval-mode` —— 与 Stage 1 `POST /session/:id/model` 同构 | 0.5d | `/approval-mode` | `session_approval_mode` |
| `POST /workspace/:id/init` —— daemon-side workspace 初始化 | 0.5d | `/init` | `workspace_init` |
| `POST /workspace/:id/auth/device-flow` 或 Client Capability OAuth RPC | 2-3d | `/auth` | `auth_device_flow` 或 `auth_via_capability` |
| `/ide` —— 语义场景明确后再设计 | TBD | `/ide` | TBD |
| **合计** | **~3-5d** | 6-7 项（除 `/auth` 是 2-3d） | 7-8 capability tags |

### Stage 1.5c 验收

- ✓ 6-8 项新 daemon-side state CRUD routes 落地
- ✓ 各 route 在 `/capabilities` 注册 capability tag，远端 client 可协商可用功能集
- ✓ 远端 thin TUI shell 升级为完整 TUI 体验（除 `/ide` 等场景模糊项）
- ✓ Web UI / mobile 同等获益
- ✓ Mode A 本地 super-client TUI 实现路径不变（local-jsx 仍是默认；wire 是 fallback / 远端等价路径）

### 与 chiga0 finding 5 capability registry 的协同

Stage 1.5c 7-8 个新 capability tag 作为 [chiga0 finding 5](./06-roadmap.md#stage-15-prereq--chiga0-6-架构重构-findingscross-module-unification) plug-in capability registry 的首批 entries。`STAGE1_FEATURES` 9-tag 数组改造为 registry 后，Stage 1.5c 7-8 tags 注册进去；远端 client 通过 `GET /capabilities` 拿到完整可用 tag 列表，对不支持的 tag gray-out dialog。

### 与同行竞品对齐

Stage 1.5c 落地后 Qwen Code 远端 client 体验：

| 工具 | 远端 UI 完整访问 daemon state |
|---|---|
| Cursor / Continue / Claude Code / OpenCode / Gemini CLI daemon | ✅ |
| **Qwen Code Stage 1.5c 后** | ✅ **对齐**（除 `/ide` / `/auth` 部分场景）|
| Qwen Code Stage 1（current）| ❌ 离群点（thin shell only）|

---

## Stage 2：daemon 完善（拆分 2a-2d，~3-4 周总计）

### 目标

让 daemon 协议表面 **feature complete**——分 4 个独立 workstream 推进，每个 sub-stage 可单独 review/merge，互相**不阻塞**。Stage 2d 完成后 qwen-code daemon scope 锁定。

> **拆分动机**（[chiga0 PR#3889 external review](https://github.com/QwenLM/qwen-code/pull/3889) Recommendation 5）：原 Stage 2 把 6 项打包到 "1-2w"——protocol completion / observability / perf evaluation / ecosystem 是 4 个不同 workstream，混在一起 review/merge 阻塞。拆为 4 sub-stage 各自 ~1 周。
>
> **可选 Stage 2e — Native in-process**（去除 `qwen --acp` child 桥接）：Stage 1 已实现 multi-session per workspace via child + bridge；Stage 2e 进一步把 `QwenAgent` 直接 import 到 daemon 进程内，**省去 ~50MB/workspace bridge 进程开销 + IPC 延迟**。需解决 `acpAgent.ts:601 loadSettings(cwd)` 在 cross-workspace 时互相污染问题，工作量估 ~1-2 周。Stage 2e 不在 chiga0 拆分的 2a-2d 之内，是更后期的可选演进。

### Stage 2a — Protocol Completion（~1 周）

让 wire 协议补齐主线缺口：

| 任务 | 工作量 | 说明 |
|---|---|---|
| WebSocket bidi 升级 | 2d | 默认 `express-ws`；SSE → WS 并存（[§03 §三 WebSocket 库选型](./03-http-api.md#websocket-库选型express-5--express-ws-默认)）|
| `/health?deep=1` 深度探测 | 1d | ACP child liveness + EventBus 状态（[§03 §七·五](./03-http-api.md#七五health-深度探测协议stage-2)）|
| `POST /ext/:method` ACP extMethod 桥接 | 2-3d | 给 vendor zero-fork 扩展点（[§03 §七·六](./03-http-api.md#七六acp-extmethod--extnotification-http-桥接stage-2)）|
| `permission_request` policy 字段 schema 预留 | 0.5d | 即使仅实现 first-responder，schema 加 `policy` + `X-Client-Id`（[§05 §3.2.1](./05-permission-auth.md#321-permission-policy-扩展设计stage-2)）|
| **合计** | **~5-7d / 1 人** | 协议表面闭环 |

### Stage 2b — Ecosystem / Security（~1 周）

让 SDK 客户端能透明用 daemon + OpenAPI codegen：

| 任务 | 工作量 | 说明 |
|---|---|---|
| OpenAPI codegen | 3-5d | `@asteasolutions/zod-to-openapi` 从 ACP zod schema 生成 spec |
| `HttpTransport` 适配器（SDK 端）| 2-3d | `packages/sdk-typescript/src/transport/HttpTransport.ts` —— 镜像 ProcessTransport 让现有 `query()` 透明走 daemon |
| **合计** | **~5-8d / 1 人** | 注：基础多 token / per-client identity 已在 Stage 1.5a Blocker #3 落地（pair tokens + revocation + daemon-stamped identity），Stage 2b 不再重复 |

### Stage 2c — Observability（~3-5d）

Operator UX：

| 任务 | 工作量 | 说明 |
|---|---|---|
| Prometheus metrics endpoint | 1-2d | `/metrics` 标准 OpenMetrics（HTTP 请求 / SSE 订阅 / EventBus 队列 / ACP child IPC RTT 等）|
| mDNS 服务发现 | 1d | `bonjour-service`（OpenCode 同款）—— `_qwen._tcp.local` |
| `--max-sessions` flag（默认 20）| 0.5d | Guard rail against N≈50 cliff（[chiga0 audit Risk 1](https://github.com/QwenLM/qwen-code/pull/3889) recommendation 3）|
| **合计** | **~3-5d / 1 人** | 上线运维基线 |

### Stage 2d — Perf Eval + 文档（~3-5d）

| 任务 | 工作量 | 说明 |
|---|---|---|
| 单 daemon instance 性能基准 | 2-3d | TTI / streaming throughput / memory baseline 测量 + README 公开数字 |
| 文档 + 示例 + cookbook | 2d | Mode A / Mode B / multi-token / `/ext` 使用示例 + README 顶部明确 "local-collaboration grade, not service grade"（[chiga0 audit Risk 1](https://github.com/QwenLM/qwen-code/pull/3889)）|
| **合计** | **~4-5d / 1 人** | 锁定 protocol surface 前的最后一道 |

### Stage 2 总计

| Sub-stage | 工作量 | 阻塞依赖 |
|---|---|---|
| 2a Protocol | 5-7d | 无（独立 wire 协议补齐）|
| 2b Ecosystem | 5-8d | 部分依赖 2a（OpenAPI 含 2a 新路由）|
| 2c Observability | 3-5d | 无（独立观察层）|
| 2d Perf Eval | 4-5d | 依赖 2a/2b 完成做基准 |
| **合计** | **~3-4 周 / 1 人**（可并行 2a/2c · 后接 2b · 收尾 2d）| 整体 |

### Stage 2 验收

- ✓ 2a：WebSocket bidi + `/health?deep=1` + `/ext/:method` + permission policy schema
- ✓ 2b：OpenAPI spec auto-gen + HttpTransport SDK 适配器
- ✓ 2c：Prometheus metrics + mDNS + `--max-sessions`
- ✓ 2d：性能基准公开 + cookbook + README scope 声明

### Stage 2 后 qwen-code 状态

```
                  ┌──────────────────────────┐
SDK / Web UI ─────│ qwen serve daemon         │
VSCode       ─────│  - Mode A (含 TUI)        │
IM bot       ─────│  - Mode B (headless)      │
                  │  - HTTP + SSE + WebSocket  │
                  │  - mDNS + OpenAPI          │
                  │  - Bearer + pair tokens    │
                  │  - Prometheus metrics      │
                  └──────────────────────────┘
                  ↑
              wire 协议稳定，外部可信赖
```

**daemon protocol surface 锁定**——后续不再扩展 wire 协议，平台层（orchestrator / 多租户 / SaaS）由外部基于此构建。

---

## In-daemon Orchestration（Stage 1 已实现，commit `6a170ef8` 后）

> **范围演进**（2026-05-12）：commit `6a170ef8` 之前 "orchestration" 全部归 External；之后以下 5 项 orchestration 职责已内化到 daemon HTTP front 进程内，**单机部署不再需要外部 orchestrator**。

| In-daemon 职责（Stage 1 已实现）| 实现细节 |
|---|---|
| **Workspace channel pool 管理** | `byWorkspaceChannel: Map<workspace, ChannelInfo>` 在 daemon HTTP front 内部维护 |
| **Per-workspace child spawn 协调** | `getOrCreateChannel(workspaceKey)` + `inFlightChannelSpawns` coalesce，concurrent 同 workspace 请求合并 |
| **Per-workspace child lifecycle / cleanup** | `channel.exited` cleanup tear down all sessions on channel；`killSession` 引用计数清理（sessionIds set 空才 kill child）|
| **Session routing via sessionScope** | 默认 `sessionScope: 'single'` 同 workspace attach；Stage 1.5 must-have #1 加 per-request override |
| **Cross-session aggregate API** | `GET /workspace/:id/sessions`（PR#3889 commit `a8ce5e08d`）daemon 内一个 query 拿所有 session |

**单机部署 N session × M workspace** —— 完全在 daemon 内完成，无需外部组件。

---

## External Reference Architecture（参考实现，非项目路线图）

下面这些不在 qwen-code 项目路线图中——是给外部集成方（商业平台 / k8s operator / 云厂商）的设计参考。详细文档已写好，可作为蓝图直接 fork 实现。**Stage 1 commit `6a170ef8` 之后 External 范围已收缩**——只覆盖跨 daemon process / 跨机器 / 多 tenant / SaaS 才需要的能力，单机多 session 已被 daemon 自身吃掉。

### Cross-Daemon Orchestrator（跨 daemon process / 跨机器路由）

> **何时需要**：单机 daemon 容量到顶（N=50+ workspaces 或 cross-tenant 隔离要求）需要多 daemon process 时；k8s 多 pod 部署时。**单机单 daemon 场景完全不需要本节**。

| 组件 | 工作量参考 | 设计文档 |
|---|---|---|
| `qwen-coordinator` HTTP front | ~3-5d | [§03 §8.2 Orchestrator API](./03-http-api.md#82-orchestrator-层-apiexternal-reference-architecture) |
| Daemon process pool / spawn-per-tenant | ~2-3d | 跨 daemon process 池化 + tenant → daemon-process 1:1 绑定（**daemon 内 sessionScope 仍归 daemon 自己**）|
| Cross-daemon sessionId → daemonUrl 注册表 | ~2d | 跨 daemon process 需要外部目录服务（单 daemon 时 daemon 自己的 `byWorkspaceChannel` 就够）|
| Cross-daemon aggregate API（跨 daemon"我所有 task"）| ~2d | 跨 daemon 聚合（单 daemon 已有 `GET /workspace/:id/sessions`，无需外部）|
| Sticky cookie / failover routing | ~2-3d | k8s 多 pod 场景把 client 路由到含其 sessionId 的 pod |
| **合计参考** | **~1.5-2 周 / 1 人** | |

详见 [§13 单 vs 多 Session 设计深度对比](./13-single-vs-multi-session-design.md) 的决策树。

### Multi-tenancy + OIDC + Quota + Audit

| 组件 | 工作量参考 | 设计文档 |
|---|---|---|
| Tenant 抽象 + Workspace ACL | ~3-5d | [§14 §三 Tenant 抽象](./14-orchestrator-multi-tenancy.md) |
| AuthN 4 模式（Bearer / OIDC / mTLS / cookie）| ~5-7d | [§14](./14-orchestrator-multi-tenancy.md#二orchestrator-4-件事) |
| Quota engine（Redis sliding-window + reservation）| ~5-7d | [§14](./14-orchestrator-multi-tenancy.md#二orchestrator-4-件事) |
| Audit log 4 通道（jsonl / syslog / OpenTelemetry / Kafka）| ~3-5d | [§14](./14-orchestrator-multi-tenancy.md#二orchestrator-4-件事) |
| **合计参考** | **~3-4 周 / 1-2 人** | |

详见 [§14 Orchestrator 多租户与配额](./14-orchestrator-multi-tenancy.md)。

### Shell Sandbox

主线 daemon 默认 **NoSandbox**——agent 跑 daemon 进程权限（PR#3889 现状）。Stage 1 PR#3889 1 daemon + M children（per workspace）+ N sessions per workspace 模型下 daemon 不感知 tenant，sandbox 是给 multi-tenant SaaS 部署的外部隔离方案，不在主线 scope。同 workspace 的 N session 共享同 `qwen --acp` child 的 OS 权限（即同 user UID + 同 fs 视图），shell 工具调用没有 session 级隔离——这是 Stage 1 的 known boundary，多租户 / 跨用户场景必须由 orchestrator 层做 daemon-per-tenant 隔离。Stage 2e native in-process 下跨 workspace 多 session 共享 OS 权限，sandbox 重要性进一步上升，届时 ShellSandbox 抽象的 in-process Worker isolation 优先级应提升到 daemon 主线 scope。

External 实施方向（按 ShellSandbox interface 抽象）：

| 方向 | 方案 | 工作量参考 |
|---|---|---|
| 本地 sandbox（同机隔离）| OS user 切换 / Linux namespace / Container（Docker/Podman）| ~2-3w |
| 远程 sandbox（daemon 与 shell 不在同机）| SSH / gRPC / k8s Job / containerd over TCP | ~2-3w |
| **合计参考** | **~4-6 周 / 1 人**（按部署形态选用）| |

PR#3889 已实现的 `BridgeClient` file-proxy 方法（`readTextFile` / `writeTextFile`）在 Stage 1 不强制 sandbox——agent 跑同 UID 且有 shell 工具权限，sandbox 在此层是 theatre。External Phase 2+ 远程 sandbox 替换 Client 为 sandbox-aware 变种即可。

### SaaS deployment

| 组件 | 工作量参考 | 设计文档 |
|---|---|---|
| k8s native（StatefulSet + PVC + Service mesh）| ~1-2w | External Phase 3 |
| Postgres state + Redis cache + S3 transcript | ~1-2w | [§14 持久化栈](./14-orchestrator-multi-tenancy.md)（持久层） |
| Multi-region / cross-geo scheduling | ~1-2w | External Phase 4 |
| **合计参考** | **~3-6 周 / 2-3 人** | |

详见 [§14 持久化栈](./14-orchestrator-multi-tenancy.md)（持久层）。

---

## 时间线

```
                  Week 1-2     Week 3-6        Week 7-10        Week 11-12
qwen-code 主线
   Stage 1       ████ ✅ MERGED 2026-05-13（PR#3889 merge commit 870bdf2a）
   Stage 1.5a            ████████ chiga0 10 must-haves（~2-3w）
   Stage 1.5b            ███ Mode A flag（~4d，与 1.5a 并行）
   Stage 1.5c            ███ daemon-side state CRUD（~3-5d，与 1.5a/1.5b 并行）
   Stage 2                            ████████ 2a-2d（~3-4w）
   Stage 2e（可选）                                ██████ native in-process（~1-2w）

里程碑:
   end Week 2:   Stage 1 PR#3889 merge ✅ 2026-05-13 06:47 UTC（收敛 chiga0 + LaZzyMan + tanzhenxin reviews）
   end Week 6:   Stage 1.5 GA（1.5a must-haves + 1.5b Mode A 并行完成）
   end Week 10:  Stage 2 GA（daemon protocol surface 锁定）
   end Week 12:  可选 Stage 2e native in-process（去 child 桥接）

External Reference Architecture（独立时间线，非项目路线图）:
   Orchestrator ~1.5-2w        → 外部团队按需实施
   Multi-tenancy ~3-4w         → 外部团队按需实施
   Shell sandbox ~4-6w         → 外部团队按需实施
   SaaS deployment ~3-6w       → 外部团队按需实施
```

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 单 daemon instance OOM / race condition | daemon crash 由外部 orchestrator（或 systemd / k8s）自动重启；transcript JSONL 持久化保证 PR#3739 fork-resume 恢复。Stage 1.5 must-have #2 把 `loadSession` 暴露到 HTTP 之后 client 也能跨 daemon restart 重建 |
| MCP server 跨 session 状态泄漏 | per-server `requiresPerSession` flag fallback；PR#3889 Stage 1 同 workspace N session 共享同 `qwen --acp` child + 同 MCP children——需审计 `requiresPerSession` 工具。跨 workspace 不同 daemon child 自然隔离不受影响。Stage 2e native in-process 下跨 workspace 共享 MCP 时需再审计 |
| FileReadCache 与 history rewrite 同步问题 | PR#3810 已修 5 路径，新加 daemon 路径需类似 audit |
| Bearer token 泄漏 | 默认 0.0.0.0 binding 拒绝启动（无 token）；timing-safe compare + 401 uniform |
| `process.chdir()` 误调 | 落地后 grep audit + CI 守卫 |
| 与现有 ACP agent 行为不一致 | Stage 1 stdio 桥接持续保留作 reference impl |
| 用户期望"开箱即用 SaaS"失望 | README 顶部明确 scope：daemon building block，平台层外部实现；提供详细 reference architecture 文档 |


## 不复用 / 待弃用资产

| 资产 | 处理 | 理由 |
|---|---|---|
| `ProcessTransport.ts` 的 `spawn` 逻辑 | **不复用** | 假设对端是 CLI 子进程；daemon 模式下对端是 HTTP server，HttpTransport 从零写。生命周期管理 / abort 处理 / 错误分类的设计模式可参考 |
| `vscode-ide-companion/src/ide-server.ts` | **Stage 2 后逐步弃用** | VSCode 直接连 daemon 即可；保留兼容性 deprecation 期。需逐项核对其特殊功能（代码补全提示等）在 daemon HTTP 路由有等价物 |

---

下一篇：[07-与 OpenCode 详细对比 →](./07-comparison-with-opencode.md)
