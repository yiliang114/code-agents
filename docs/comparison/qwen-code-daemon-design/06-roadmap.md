# 06 — 路线图

> [← 上一篇：权限 / 认证](./05-permission-auth.md) · [下一篇：与 OpenCode 详细对比 →](./07-comparison-with-opencode.md)

> Qwen Code 项目本身只承诺 **"daemon building block"** —— 把 ACP NDJSON 协议通过 HTTP+SSE 暴露成可被任何外部 client / 编排器消费的服务。多 session orchestrator / 多租户 / SaaS 部署等"平台层"由外部实现（商业平台 / k8s operator / 云厂商定制），项目提供 [§14](./14-single-vs-multi-session-design.md) / [§15](./15-orchestrator-multi-tenancy.md) / [§03 §8.2](./03-http-api.md#82-新增-orchestrator-层-apistage-2) 作为参考架构蓝图。

## 总览

```
qwen-code 主线（~3 周内 feature complete）：
├─ Stage 1   ✅ (~1 周, PR#3889 ~95% 实现) Mode B headless qwen serve
├─ Stage 1.5 🆕 (~4 天增量) Mode A CLI + HttpServer (qwen --serve)
└─ Stage 2   🆕 (~1-2 周) daemon 完善：mDNS / OpenAPI / WebSocket bidi / 多 token / Metrics

────────── qwen-code daemon feature complete ──────────

External Reference Architecture（外部 / 商业层，参考实现）：
├─ Orchestrator (multi-daemon spawn / route / cleanup)        → §14 / §03 §8.2 设计参考
├─ Multi-tenancy (Tenant / OIDC / Quota / Audit)              → §15 设计参考
├─ Shell sandbox (NoSandbox / OS user / Namespace / Container) → §09 设计参考
└─ SaaS deployment (k8s / Postgres / Redis / S3)              → External SaaS HA / §15 §七 设计参考
```

**核心判断**：qwen-code 是 building block，不是 SaaS 平台。Stage 1 + Stage 1.5 + Stage 2 完成后 daemon 协议表面 100% 稳定，外部集成方（如阿里云 DashScope / 自建团队 / 用户）可基于此自由实现 orchestrator + 多租户 + SaaS。这与 OpenCode（端到端 SaaS 路线）的设计哲学相反——后者绑定平台决策，前者保持 Unix 风格的可组合性。

---

## Stage 1：Mode B headless `qwen serve`（~1 周，✅ PR#3889 ~95% 实现）

### 目标

提供 daemon 的最小可用形态——`qwen serve` headless 进程，通过 HTTP+SSE 暴露 ACP NDJSON 协议。一 daemon instance 绑一 session（[§02 §2](./02-architectural-decisions.md#2-状态进程模型)），多 session 由外部 spawn 多个 instance 实现。

### 实现

```
[现有] qwen --acp                 → stdio NDJSON ACP agent
[Stage 1] qwen serve              → Express 5 HTTP server
                                  → 内部 spawn `qwen --acp` per session
                                  → HTTP body ↔ stdio NDJSON 桥接
                                  → SSE 事件流给多 client
```

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

### Stage 1 PR#3889 实现 audit（2026-05-07）

> 最近更新 2026-05-09：commits 23 → 32 / +7698/-46 → +8883/-4 / Stage 1 docs 已补全（commit `27a164c`）/ multi-model audit 累计 close ~30 review threads。

[**PR#3889**](https://github.com/QwenLM/qwen-code/pull/3889) `feat(cli,sdk): qwen serve daemon (Stage 1)` —— OPEN，**+8883/-4 / 32 commits** —— Stage 1 GA-ready（代码 ~95% 设计落地 + 文档 100% 补全 + 多轮 multi-model audit 收敛）。

#### 1️⃣ 体量与预估对比

| 维度 | 预估（本节工作清单）| 实际（PR#3889 当前）| 倍数 |
|---|---|---|---|
| LOC | ~700-1000 行 | **+8883 / -4**（含测试 + 文档；剔除测试 + 文档 ~5100 LOC）| **5x-9x** |
| 工作量 | ~7-8 天 / 1 人 | 多周（32 commits 跨多轮 multi-model audit + Stage 1 文档补全）| 几周 vs 1 周 |
| 提交数 | — | **32 commits**：7 实现 + 13 self-audit / review round（claude-opus-4-7 / gpt-5.5 / deepseek 多模型）+ 2 e2e/doc-note + 5 多模型 review threads close 批次（30+ threads）+ 1 Stage 1 docs + 4 merge / lint | — |

**超出原因**（设计 → 实现的工程现实）：

| 原因 | 详情 |
|---|---|
| **EventBus + ring replay + Last-Event-ID 重连** | 原 §03 §三 计划 Stage 6 HA 才详做，PR#3889 提前到 Stage 1（client_evicted overflow + bounded subscriber queues 都做了）|
| **Timing-safe bearer compare** | §05 设计为 Bearer，PR#3889 加 SHA-256 + `crypto.timingSafeEqual` + 401 uniform across no-header/bad-scheme/wrong-token，对应 §05 side-channel 防御（设计在 §05 但 Stage 1 实现）|
| **IPv6 loopback ergonomics** | `::1` / `[::1]` / `host.docker.internal` 等 LOOPBACK_BINDS 边界，原设计未具体化 |
| **EventBus correctness** | `client_evicted` overflow / replay ring / AsyncIterable abort handling 等几百行 |
| **Self-audit + multi-model reviewer rounds** | 32 commits 中 ~12 轮 audit（self-audit 1-10 + reviewer rounds 1-7 + 后续 multi-model review threads close）—— 这是 PR#3889 体量超出的最大来源；多模型审（claude-opus-4-7 + gpt-5.5 + deepseek）累计 close ~30 review threads（race / leak / IPv6 / SSE / Windows / env whitelist / abort timeout 等）|
| **DaemonClient SDK** | §03 没单独估算 SDK 端，但 sibling 同步实现 `parseSseStream` / `DaemonHttpError` |
| **child-crash recovery** | reviewer round 4 加，原设计未含 |
| **Stage 1 文档补全** | commit `27a164c` 补 §06 设计原计划的 1d "documentation + examples" 任务：`docs/users/qwen-serve.md`（114 行用户 quickstart）+ `docs/developers/qwen-serve-protocol.md`（287 行 HTTP 协议 reference）+ `docs/developers/examples/daemon-client-quickstart.md`（190 行 SDK ts 示例）+ README "Daemon mode" 入口；总 +591 行 docs |

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
| `session_events` | `GET /session/:id/events` SSE + Last-Event-ID + 15s heartbeat | §03 §三 + §03 §三 SSE 重连 |
| `session_set_model` | `POST /session/:id/model`（publishes `model_switched`）| §03 §一 |
| `permission_vote` | `POST /permission/:requestId` first-responder | §03 §三 + §02 §6 决策 + §05 §3 |

#### 3️⃣ 9 commits breakdown（核心实现部分）

| Commit | 关注章节 |
|---|---|
| `61f2f59a1` scaffold `qwen serve` Express + auth + Host allowlist + /health + /capabilities | §03 §一 + §05 §1 |
| `8d7c03a5f` HttpAcpBridge spawn `qwen --acp` per workspace + ACP 10s init + sessionScope:single | §02 §1 + §04 进程模型 |
| `ca996ecb5` POST /prompt FIFO + /cancel + SessionNotFoundError | §03 §一 + 决策 §6 |
| `41aa95094` EventBus + SSE Last-Event-ID + 15s heartbeat + ring replay + client_evicted overflow | §03 §三 + §03 §三 + §12 §五 |
| `6ee655f0a` POST /permission first-responder vote + cancelSession resolves outstanding | §02 §6 决策 + §05 §3 |
| `8206a64b5` SDK DaemonClient + DaemonHttpError + parseSseStream | §08 SDK / ACP 协议兼容性 |
| `a8ce5e08d` /workspace/:id/sessions + /session/:id/model + errorMessage helper | §03 §一 |
| `ad0e6ec06` audit round 1: timing-safe bearer / coalesce spawnOrAttach / parseLastEventId / IPv6 / failOnError | §05 §1 + §05 |
| 后续 14 commits（self-audit 2-10 + reviewer rounds 1-7）| 持续 audit |
| `0337f71` / `87255e1` / `11567a4` / `149999a` / `2cc2305` / `988507e` close ~30 multi-model（gpt-5.5 / claude-opus-4-7 / deepseek）review threads —— race / leak / IPv6 / SSE / Windows / env whitelist / abort timeout | §05 §1 + §05 + §03 §三 + §12 §五 |
| `27a164c` Stage 1 docs：用户 quickstart + HTTP 协议 reference + SDK ts 示例 + README "Daemon mode" 入口 | §03 §一 + §05 + §08 |

#### 4️⃣ 设计 vs 实现对应度评估

| 章节 | 对应度 |
|---|---|
| §02 §1 sessionScope='single' default | **100%** ✓ |
| §02 §6 prompt FIFO + first responder | **100%** ✓ |
| §03 §一 路由表 | **100%**（daemon 层核心路由全实现）|
| §03 §二.2 复用 ACP zod schema | **100%** ✓ |
| §03 §三 SSE / WebSocket | **80%**（SSE 完整 / WebSocket Stage 2 deferred）|
| §05 §1 Bearer token | **100%** + 加 timing-safe compare + 401 uniform |
| §05 §6.1 0.0.0.0 拒绝默认 | **100%** ✓ |
| §08 capabilities envelope | **100%**（9 tags 实现）|
| §03 §三 SSE Last-Event-ID 重连 | **100%**（ring + replay + 15s heartbeat）|
| §12 §五 liveness 协议 | **75%**（heartbeat 间隔 15s vs 设计 30s——更激进；client_evicted overflow 已实现）|
| §11 远端 CLI / Capability 反向 RPC | **0%**（Stage 1 不含；Stage 2 deferred）|
| **Stage 1 文档**（user guide + HTTP 协议 reference + SDK 示例）| **100%**（commit `27a164c` 补全 §06 §"Documentation + examples + e2e tests" 1d 任务）|

**综合**：~95% Stage 1 范畴内的设计决策 1:1 实现；文档 100% 补全；少数偏差都是**设计向更严格演进**（timing-safe / 401 uniform / 15s heartbeat 比 30s 更激进 / IPv6 ergonomics），不是简化。**Stage 1 GA-ready**——可 merge 后开 Stage 1.5（Mode A `qwen --serve` ~4d）follow-up。

#### 5️⃣ 经验沉淀

| 经验 | 详情 |
|---|---|
| **EventBus 在 Stage 1 就需要完整实现** | 原计划 Stage 6 HA 详做，但 SSE Last-Event-ID 重连是 Stage 1 用户必需，无法 deferred |
| **Timing-safe / 401 uniform 等 side-channel 防御 Stage 1 就要做** | §05 设计放在多租户章节，但 PR#3889 在 Stage 1 单租户也做了——开源 daemon 默认就该这么严 |
| **IPv6 loopback ergonomics 不能省略** | 容器化 / Docker / `host.docker.internal` 是常见用例，loopback 处理细节比预想复杂 |
| **多轮 self-audit + multi-model 流程的价值** | PR#3889 用 ~12 轮 audit（claude-opus-4-7 / gpt-5.5 / deepseek 三模型）—— close ~30 review threads；不同模型抓不同类问题（race / leak / IPv6 / SSE / Windows / env whitelist / abort timeout 互补覆盖）|
| **child-crash recovery 是必需的** | reviewer round 4 才补；spawn 子进程模式下，子进程崩溃时 daemon 必须 graceful 处理而不是把错误传播给所有 SSE clients |
| **PR 体量 ~5x-9x 预估是常态** | 工程文档预估 vs 实际几乎总是 5-9x，因为 audit + 边界 + ergonomics + 文档 占大头 |
| **文档不能 deferred 到 merge 后** | 原 §06 §1 "1d Documentation + examples" 在主实现之后被推迟；commit `27a164c` 补回（591 行 docs）。教训：文档要列入 PR scope 否则 merge 后没人会回填 |

#### 6️⃣ Stage 1 不含 / 推到 Stage 1.5 / Stage 2 / 外部的能力

| 能力 | 状态 |
|---|---|
| Mode A（CLI + HttpServer，`qwen --serve`）| Stage 1.5（~4d 增量）|
| `WS /session/:id`（双向 WebSocket）| Stage 2 |
| OpenAPI 自动生成 + mDNS 服务发现 | Stage 2 |
| 多 token / per-token user-id | Stage 2 |
| Prometheus metrics endpoint | Stage 2 |
| `POST /file/read` / `/file/write` | **External / Stage 2 可选**（agent 已有 fs，daemon-only file API 仅给远端 client 用）|
| Mobile / browser UI | **External**（参考 [§11 远端 CLI 模式](./11-remote-cli-mode.md)；PR#3929-3931 平行 stack 已有 mobile UI 参考）|
| Pairing token / LAN URL | **External**（参考 PR#3929-3931）|
| Orchestrator (multi-daemon spawn / route / cleanup) | **External**（参考 [§03 §8.2](./03-http-api.md#82-新增-orchestrator-层-apistage-2) + [§14](./14-single-vs-multi-session-design.md) + [§15](./15-orchestrator-multi-tenancy.md)）|
| Multi-tenancy / OIDC / Quota / Audit | **External**（参考 [§15](./15-orchestrator-multi-tenancy.md)）|
| Shell sandbox（OS user / namespace / container / remote）| **External**（参考 [§09](./09-multi-tenancy-and-sandbox.md)）|

#### 7️⃣ Stage 1 主线 HA 与稳定性已覆盖范围

qwen-code 主线 HA / 稳定性需求由 PR#3889 + PR#3739 已完整覆盖（详细 SaaS 部署 HA / 长跑稳定性蓝图作为 External Reference Architecture）：

| 机制 | 实现 | 覆盖 |
|---|---|---|
| **Daemon crash 自动重启** | 由外部进程管理器（systemd / k8s / orchestrator）负责 | 单 daemon 进程崩溃 → 重启 |
| **Transcript-first fork resume** | PR#3739 已合并 | 新 daemon 启动 replay transcript JSONL 重建 session 状态 |
| **SSE Last-Event-ID 重连** | PR#3889 commit `41aa95094` | client 网络抖动 / daemon 重启后断点续连（详细协议见 [§03 §三](./03-http-api.md#三sse--websocket-事件流核心)）|
| **Crash isolation 免费** | OS 进程边界（决策 §2 1 daemon = 1 session）| 一 daemon 崩溃只影响其唯一 session，其他 daemon 不受影响 |
| **资源 cleanup 简单** | OS process exit | kill daemon = 清理所有 fd / child process / memory，无需主动 cleanup hooks |
| **timing-safe bearer auth + 401 uniform** | PR#3889 commit `ad0e6ec06` | 防 side-channel 攻击 |

主线**不需要**：multi-pod sticky session / Postgres Patroni / Redis Sentinel / per-tenant heap budget / Worker thread tenant isolation / 30 天 Soak/Chaos 测试矩阵 等——这些都是 External SaaS 运营层关切，由  设计参考蓝图描述。

---

## Stage 1.5：Mode A CLI + HttpServer（~4 天增量）

### 目标

让 `qwen` CLI 进程同时挂载 HttpServer——TUI 在终端正常渲染，远端 client（WebUI / IDE / IM bot）通过 HTTP 接入同一 session（[§02 §7 双部署模式](./02-architectural-decisions.md#7-daemon-部署模式clihttpserver-vs-headlesshttpserver)）。

### 实现

```bash
# 用户在终端跑：
qwen --serve --port 7776 [--token-file ~/.qwen/local-token]

# TUI 启动 + Express HTTP server 同进程
# 远端 client 通过 :7776 接入；TUI 是 client #0（in-process EventBus）
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

### Stage 1.5 验收

- ✓ `qwen --serve` 启动 TUI + HTTP server 同进程
- ✓ 远端 client 通过 HTTP 接入同 session（与 TUI 共享 EventBus）
- ✓ TUI 退出 → HTTP server graceful drain → 整进程退出
- ✓ 默认 loopback only / no token（本地信任）；远端启用必须显式 `--token`
- ✓ 与 Stage 1 PR#3889 同 wire 协议（client SDK 不需要改）

---

## Stage 2：daemon 完善（~1-2 周）

### 目标

让 daemon 协议表面 **feature complete**——添加 mDNS 发现、OpenAPI codegen、WebSocket bidi、多 token、Prometheus metrics。Stage 2 完成后 qwen-code daemon scope 锁定，外部集成方可放心基于此构建。

### 工作清单

| 任务 | 工作量 | 说明 |
|---|---|---|
| WebSocket bidi 升级 | 2d | 默认 `express-ws`；SSE → WS 并存（[§03 §三 WebSocket 库选型](./03-http-api.md#websocket-库选型express-5--express-ws-默认)）|
| mDNS 服务发现 | 1d | `bonjour-service`（OpenCode 同款）—— `_qwen._tcp.local` |
| OpenAPI codegen | 3-5d | `@asteasolutions/zod-to-openapi` 从 ACP zod schema 生成 spec |
| 多 token / per-token user-id | 2-3d | `tokens.json` + 每 token 绑定 user-id（不做 OIDC——orchestrator 范畴）|
| Prometheus metrics endpoint | 1-2d | `/metrics` 标准 OpenMetrics（HTTP 请求 / SSE 订阅 / EventBus 队列等）|
| `HttpTransport` 适配器（SDK 端）| 2-3d | `packages/sdk-typescript/src/transport/HttpTransport.ts` —— 镜像 ProcessTransport 让现有 `query()` 透明走 daemon |
| 文档 + 示例 + 性能基准 | 2-3d | 单 daemon instance 性能基线 |
| **合计** | **~1.5-2 周 / 1 人** | ~1500-2500 行 |

### Stage 2 验收

- ✓ WebSocket bidi 升级（与 SSE 并存，client capability 检测）
- ✓ mDNS 自动发现（同网段零摩擦接入）
- ✓ OpenAPI spec 自动生成 + SDK 验证
- ✓ 多 token + 每 token user-id（基础多用户 daemon，不含 OIDC）
- ✓ Prometheus metrics（基础可观测性）
- ✓ HttpTransport SDK 适配器（透明替代 ProcessTransport）

### Stage 2 后 qwen-code 状态

```
                  ┌──────────────────────────┐
SDK / Web UI ─────│ qwen serve daemon         │
VSCode       ─────│  - Mode A (含 TUI)        │
IM bot       ─────│  - Mode B (headless)      │
                  │  - HTTP + SSE + WebSocket  │
                  │  - mDNS + OpenAPI          │
                  │  - Bearer + 多 token       │
                  │  - Prometheus metrics      │
                  └──────────────────────────┘
                  ↑
              wire 协议稳定，外部可信赖
```

**daemon protocol surface 锁定**——后续不再扩展 wire 协议，平台层（orchestrator / 多租户 / SaaS）由外部基于此构建。

---

## External Reference Architecture（参考实现，非项目路线图）

下面这些不在 qwen-code 项目路线图中——是给外部集成方（商业平台 / k8s operator / 云厂商）的设计参考。详细文档已写好，可作为蓝图直接 fork 实现。

### Orchestrator（多 daemon 路由 / 生命周期 / 聚合 UI）

| 组件 | 工作量参考 | 设计文档 |
|---|---|---|
| `qwen-coordinator` HTTP server | ~3-5d | [§03 §8.2 Orchestrator API](./03-http-api.md#82-新增-orchestrator-层-apistage-2) |
| sessionScope routing（single / user / thread）| ~2d | [§02 §1](./02-architectural-decisions.md#1-session-是否跨-client-共享) |
| Daemon instance 注册表（sessionId → daemonUrl）| ~2d | [§03 §8.2 `POST /coordinator/sessions/:id/route`](./03-http-api.md#82-新增-orchestrator-层-apistage-2) |
| Spawn / cleanup / health watchdog | ~2d |  |
| Cross-daemon aggregate API（"我所有 task"）| ~2d | [§03 §8.2 `/aggregate`](./03-http-api.md#82-新增-orchestrator-层-apistage-2) |
| **合计参考** | **~1.5-2 周 / 1 人** | |

详见 [§14 单 vs 多 Session 设计深度对比](./14-single-vs-multi-session-design.md) 的决策树。

### Multi-tenancy + OIDC + Quota + Audit

| 组件 | 工作量参考 | 设计文档 |
|---|---|---|
| Tenant 抽象 + Workspace ACL | ~3-5d | [§15 §三 Tenant 抽象](./15-orchestrator-multi-tenancy.md) |
| AuthN 4 模式（Bearer / OIDC / mTLS / cookie）| ~5-7d | [§15](./15-orchestrator-multi-tenancy.md#二orchestrator-4-件事) |
| Quota engine（Redis sliding-window + reservation）| ~5-7d | [§15](./15-orchestrator-multi-tenancy.md#二orchestrator-4-件事) |
| Audit log 4 通道（jsonl / syslog / OpenTelemetry / Kafka）| ~3-5d | [§15](./15-orchestrator-multi-tenancy.md#二orchestrator-4-件事) |
| **合计参考** | **~3-4 周 / 1-2 人** | |

详见 [§15 Orchestrator 多租户与配额](./15-orchestrator-multi-tenancy.md)。

### Shell Sandbox

| 组件 | 工作量参考 | 设计文档 |
|---|---|---|
| `ShellSandbox` interface | ~1d | [§09 §二](./09-multi-tenancy-and-sandbox.md#二shellsandbox-抽象接口) |
| 4 种本地 sandbox（NoSandbox / OS user / Namespace / Container）| ~2-3w | [§09 §三 / §四](./09-multi-tenancy-and-sandbox.md) |
| 远程 sandbox（SSH / gRPC / k8s Job / containerd）| ~2-3w | [§09 §五](./09-multi-tenancy-and-sandbox.md#五远程-sandboxdaemon-与-shell-不在同机) |
| **合计参考** | **~4-6 周 / 1 人** | |

注：Sandbox 是 daemon 内能力，但具体策略取决于部署形态（个人/企业/SaaS），所以放在外部参考。

### SaaS deployment

| 组件 | 工作量参考 | 设计文档 |
|---|---|---|
| k8s native（StatefulSet + PVC + Service mesh）| ~1-2w |  |
| Postgres state + Redis cache + S3 transcript | ~1-2w | [§15 持久化栈](./15-orchestrator-multi-tenancy.md)（持久层） |
| Multi-region / cross-geo scheduling | ~1-2w |  |
| **合计参考** | **~3-6 周 / 2-3 人** | |

详见  + [§15 持久化栈](./15-orchestrator-multi-tenancy.md)（持久层）。

---

## 时间线

```
                  Week 1   Week 2   Week 3
qwen-code 主线
   Stage 1       ████ ✅
   Stage 1.5         ██
   Stage 2           ░░░░░░░░░░░░

里程碑:
   end Week 1: Stage 1 GA（PR#3889 merge）
   end Week 2: Stage 1.5 GA（Mode A）
   end Week 3: Stage 2 GA（daemon protocol surface 锁定）

External Reference Architecture（独立时间线，非项目路线图）:
   Orchestrator ~1.5-2w        → 外部团队按需实施
   Multi-tenancy ~3-4w         → 外部团队按需实施
   Shell sandbox ~4-6w         → 外部团队按需实施
   SaaS deployment ~3-6w       → 外部团队按需实施
```

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 单 daemon instance OOM / race condition | daemon crash 由外部 orchestrator（或 systemd / k8s）自动重启；transcript JSONL 持久化保证 PR#3739 fork-resume 恢复 |
| MCP server 跨 session 状态泄漏 | per-server `requiresPerSession` flag fallback；1 daemon = 1 session 后此问题大部分自动消失 |
| FileReadCache 与 history rewrite 同步问题 | PR#3810 已修 5 路径，新加 daemon 路径需类似 audit |
| Bearer token 泄漏 | 默认 0.0.0.0 binding 拒绝启动（无 token）；timing-safe compare + 401 uniform |
| `process.chdir()` 误调 | 落地后 grep audit + CI 守卫 |
| 与现有 ACP agent 行为不一致 | Stage 1 stdio 桥接持续保留作 reference impl |
| 用户期望"开箱即用 SaaS"失望 | README 顶部明确 scope：daemon building block，平台层外部实现；提供详细 reference architecture 文档 |

## Stage 0：前置 PR 完成度（确认已就绪）

进入 Stage 1 前确认以下 PR 已合并：

| PR | 状态 | 必要性 |
|---|---|---|
| PR#3717 FileReadCache | ✅ 已合并 | session-scoped cache 是 daemon 必备 |
| PR#3810 FileReadCache 5 路径 invalidation | ✅ 已合并 | 长 session 正确性 |
| PR#3723 共享 permission flow | ✅ 已合并 | daemon 加第 4 mode 的基础 |
| PR#3739 Background agent resume + transcript-first fork | ✅ 已合并 | daemon 重启 / 跨 client 续行 |
| PR#3642 `/tasks` + background shell pool | ✅ 已合并 | 跨 session 任务调度 |
| PR#3818 MCP rediscovery coalesce | ✅ 已合并 | MCP pool 共享 |
| PR#3836 Kind framework 4 消费者 | ✅ 已合并 | 跨 client 任务可见性 |

✓ **全部 PR 在 2026-05-06 之前已合并**——daemon 化的所有前置基础已就绪。

## 不复用 / 待弃用资产

| 资产 | 处理 | 理由 |
|---|---|---|
| `ProcessTransport.ts` 的 `spawn` 逻辑 | **不复用** | 假设对端是 CLI 子进程；daemon 模式下对端是 HTTP server，HttpTransport 从零写。生命周期管理 / abort 处理 / 错误分类的设计模式可参考 |
| `vscode-ide-companion/src/ide-server.ts` | **Stage 2 后逐步弃用** | VSCode 直接连 daemon 即可；保留兼容性 deprecation 期。需逐项核对其特殊功能（代码补全提示等）在 daemon HTTP 路由有等价物 |

---

下一篇：[09-与 OpenCode 详细对比 →](./07-comparison-with-opencode.md)
