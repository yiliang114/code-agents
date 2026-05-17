# 01 — Overview

> [← 返回 README](./README.md) · [下一篇：Design Decisions →](./02-architectural-decisions.md)

## TL;DR

**qwen serve** 是 Qwen Code 的 HTTP daemon 模式——把 ACP NDJSON 协议通过 HTTP+SSE 暴露成可被任何 client / orchestrator 消费的服务。

**核心架构**：

```
1 daemon process = 1 workspace × N sessions multiplexed
```

与 `qwen --acp` stdio **1:1 心智对齐**——daemon 把 ACP stdio 包装成 HTTP。多 workspace 部署 = 多 daemon process（systemd / docker / k8s 各 1 process 自然管理）。

**关键设计依据**：
- **OS 进程级隔离**：跨 workspace = 跨 daemon process = 跨 OS process（最强）
- **资源 quota 直接对应**：systemd `MemoryMax=` / cgroup / docker `--memory` 直接 = per-workspace quota
- **K8s 云原生天然契合**：1 pod = 1 daemon = 1 workspace
- **Blast radius 最小**：daemon crash 只影响 1 workspace
- **Observability 直接**：`htop` / `ps` 列表 1 OS process = 1 workspace
- **心智简单**：daemon ↔ session 两层（无中间抽象）

**两种部署**：
- **Mode B** `qwen serve` — 当前主线：headless HTTP front，所有 client 通过 HTTP/SSE 接入同一 daemon runtime。
- **Mode A** `qwen --serve` — 2026-05-15 后暂停推进；作为 parking lot 保留，待 Mode B event/control/client contract 稳定后再评估。

**主线 scope**：daemon building block + 协议表面锁定（Stage 2 后）。多 tenant / 跨 daemon process 路由 / SaaS 部署属 **External Reference Architecture**（外部商业平台实施）。

---

## 一、术语表

| 术语 | 定义 | 源码 anchor |
|---|---|---|
| **Daemon process** | `qwen serve` HTTP front 进程；启动时绑定 cwd = 单 workspace；持 Express 5 server + EventBus + 1 个内嵌 `qwen --acp` child | `packages/cli/src/serve/server.ts` |
| **Session** | ACP `Session` 实例（`QwenAgent.sessions: Map<sessionId, Session>` 内一条）；持 transcript / FileReadCache / PermissionManager | `packages/cli/src/acp-integration/session/Session.ts` |

**核心约束**：
- 1 daemon process **严格 1 workspace**（启动 cwd 绑定）
- 1 daemon process **可持 N sessions**（`QwenAgent.sessions: Map` 多路复用）
- 同 workspace N session 共享同一个 `qwen --acp` child process；当前 `Config` / `FileReadCache` / `ToolRegistry` / `McpClientManager` 仍随 ACP session 创建，跨 session MCP 共享需要未来 pool/proxy。

> 代码中可能看到的废弃符号：`byWorkspaceChannel` / `ChannelInfo` / `Workspace Bridge`（PR#3889 multi-workspace 路由层，已由 [PR#4113](https://github.com/QwenLM/qwen-code/pull/4113) 移除）。

---

## 二、架构图

```
qwen serve (1 Daemon process, 绑定 cwd = /work/repo-a)
├─ Express 5 HTTP server + bearer auth + Host allowlist
├─ EventBus（per-session fan-out + ring replay + Last-Event-ID 重连）
└─ qwen --acp child (workspace = /work/repo-a)
   ├─ QwenAgent.sessions: Map → {sess-1, sess-2, sess-3}
   └─ per-session Config / MCP manager / FileReadCache
```

**多 workspace 部署**（开发者本地多项目 / 多 user / 多 tenant）：

```
┌────────────────────────────────────────┐
│ 同机多 daemon 部署                       │
├────────────────────────────────────────┤
│ qwen serve (cwd=/work/repo-a) :8001    │  ← daemon-1
│ qwen serve (cwd=/work/repo-b) :8002    │  ← daemon-2
│ qwen serve (cwd=/work/repo-c) :8003    │  ← daemon-3
└────────────────────────────────────────┘
                ↓ systemd / docker-compose / k8s
        OS-level 进程隔离 + per-daemon cgroup quota
```

跨 workspace 协调（IM bot 多项目 / WebUI 多 workspace 概览 / IDE multi-root）由 **client 侧 / orchestrator 侧**做（多 daemon endpoint 发现 + 路由）——daemon 自身只管"当前 workspace"。

External Reference Architecture 提供 orchestrator 层（详 [§06 §五 External Reference Architecture](./06-roadmap.md)）。

---

## 三、双部署模式

| 模式 | 启动命令 | TUI | 适用场景 |
|---|---|---|---|
| **Mode B: Headless + HttpServer** | `qwen serve [--port N]` | ❌ | 当前主线：服务器 / 容器 / 远端机器 / K8s pod / 所有 client 的统一 runtime |
| **Mode A: CLI + HttpServer** | `qwen --serve [--port N]` | ✅ 本地 | 暂停推进；作为 parking lot 保留 |

**当前 client 边界**：TUI / channels / web / IDE 直接对接 `qwen serve` HTTP server；`GET /session/:id/events` 是 daemon 内部 EventBus 的 SSE projection。外部 client 不直接 import / subscribe 内存 EventBus。

**Mode B 远端 client 是 "thin shell"**（Stage 1）——只能渲染 wire 流，daemon-side state dialogs（`/memory` / `/mcp` / `/agents` 等）不可用。Stage 1.5c daemon-side state CRUD 补齐后，TUI / channels / web / IDE 才能成为完整 client。详 [§04](./04-deployment-and-client.md)。

---

## 四、资源经济性

**同 workspace N session 经济性**（继承 ACP `QwenAgent.sessions: Map` 原生 multi-session）：

| N 同 workspace session | 内存 RSS | 说明 |
|---|---|---|
| 1 | ~60-100 MB | baseline |
| 5 | **~60-100 MB** | N session 共 1 `qwen --acp` child |
| 10 | **~80-150 MB** | 同上 |
| OAuth refresh | 1× per daemon | 共享 |
| FileReadCache | per session | 当前随 `Config` 创建；跨 session 共享未做 |
| CLAUDE.md parse | per session | 当前随 session config 初始化 |
| Cold start（同 daemon 第 N session）| **<200ms** | attach existing child |

**多 workspace 部署成本**：M workspace = M daemon process。每 daemon baseline ~30-50 MB Express server + bearer auth + EventBus + Host allowlist。例 5 workspace × 5 session 同机 ≈ ~450-750 MB（5 × baseline + 5 × child）。换得 OS 进程级隔离 + cgroup quota + blast radius 最小 + 心智简单。

---

## 五、Stage 演进

| Stage | 范围 | 状态 |
|---|---|---|
| **Stage 1** | Mode B headless `qwen serve` + N session multiplexed + EventBus + first-responder permission + 9 STAGE1_FEATURES | ✅ **MERGED 2026-05-13** ([PR#3889](https://github.com/QwenLM/qwen-code/pull/3889)) |
| **Stage 1.5a §02** | [PR#4113](https://github.com/QwenLM/qwen-code/pull/4113) 1 daemon = 1 workspace 收紧 | ✅ **MERGED 2026-05-15** |
| **Stage 1.5a must-haves** **(P0)** | chiga0 10 must-haves 剩 9 项 — Mode B 生产 blocker（loadSession HTTP / pair tokens / sessionScope override）| ~2 周（9 PRs 可并行）|
| **Stage 1.5c** **(P0)** | daemon-side state CRUD 8 routes — Mode B 远端 client 摆脱 thin shell | ~3-5d |
| **Stage 1.5-prereq** **(P1)** | chiga0 6 architecture findings — lift `AcpChannel` / `EventBus` / `PermissionMediator` 到 `@qwen-code/acp-bridge` | ~1-2 周 |
| **Stage 1.5-client adapters** **(P1 behind flag)** | TUI / channels / web/debug / IDE 接入 Mode B daemon；默认切换必须等 P0/P1 | ~2-3 周 |
| **Stage 1.5b** Mode A **(P2 推迟)** | Mode A `qwen --serve` flag — [Issue #4156](https://github.com/QwenLM/qwen-code/issues/4156)；A1 [PR#4160](https://github.com/QwenLM/qwen-code/pull/4160) ✅ MERGED；**推迟到 1.5c 后**（Mode A 价值依赖 1.5c）| ~5-6d |
| **Stage 1.5-remote-control** **(P2 后置)** | [PR#3929](https://github.com/QwenLM/qwen-code/pull/3929) / [#3930](https://github.com/QwenLM/qwen-code/pull/3930) / [#3931](https://github.com/QwenLM/qwen-code/pull/3931) 后续作为 daemon facade | 待 primary clients 收敛 |
| **Stage 2** | 协议补齐（WebSocket / mDNS / OpenAPI / Prometheus / `/ext` + Reverse RPC 5 类 Client Capability）| ~3-4 周（拆 2a-2d）|
| **Stage 2e** | 可选 native in-process（去 `qwen --acp` child）| ~1-2 周 |

> **优先级决策（2026-05-15）**：Mode B 优先 — must-haves + 1.5c 摆脱 thin shell → 1.5-prereq 架构清洁 → Mode A（1.5b）推迟。详 [§06 §三 推进顺序](./06-roadmap.md)。
>
> 💡 **Implementation tracker**：[Issue #4175](https://github.com/QwenLM/qwen-code/issues/4175) doudouOUC 的 Mode B v0.16 production-ready 25-PR rollout plan（6 Wave）—— 上表的 Stage 1.5a/c/-prereq 映射到 Wave 1-5；Wave 6 是 release hardening + v0.16。详 [§06 §三·一 Wave breakdown](./06-roadmap.md#三一-issue-4175--25-pr-wave-breakdown-production-ready-tracker)。
>
> 🎉 **Wave 1 + Wave 2 完整 + Wave 2.5/4 起手**（2026-05-16~17 32h 窗口 **10 MERGED** + 2 OPEN：Wave 1 = 4/4 + Wave 2 = 4/4 + 2 follow-up + Wave 2.5 PR 10 起 + Wave 4 PR 15 起；**无 block 点**）：
> - ✅ Wave 1 **PR 2** [PR#4191](https://github.com/QwenLM/qwen-code/pull/4191) capability registry + protocol versions — **MERGED 2026-05-16 10:07** (doudouOUC)
> - ✅ Wave 2 **PR 5** [PR#4209](https://github.com/QwenLM/qwen-code/pull/4209) per-request `sessionScope` override — **MERGED 2026-05-16 15:54** (doudouOUC, 4h26m open→merge)
> - ✅ Wave 1 **PR 1** [PR#4205](https://github.com/QwenLM/qwen-code/pull/4205) baseline harness — **MERGED 2026-05-16 16:41** (doudouOUC, 4 Critical 修后；首份 `baseline-stage-1.json` 存档 macOS arm64 / RSS 223.5 MB / attach 1-3 ms / MCP 4 children constant under single-scope)
> - ✅ Wave 1 **PR 3** [PR#4201](https://github.com/QwenLM/qwen-code/pull/4201) DaemonSessionClient skeleton — **MERGED 2026-05-16 17:01** (chiga0；前身 PR#4195 CLOSED；v2 补 AbortSignal/event-without-id/error-path 测试)
> - ✅ Wave 2 follow-up [PR#4214](https://github.com/QwenLM/qwen-code/pull/4214) — **MERGED 2026-05-16 17:51** (doudouOUC, 1h23m) — 校准 integration-test 9→10 + 建立 capability registry **三套来源 lockstep** 模式
> - ✅ Wave 1 **PR 4** [PR#4217](https://github.com/QwenLM/qwen-code/pull/4217) typed event schema — **MERGED 2026-05-17 04:31** (chiga0, squashed `ab88f6f1`，5 轮 review / 2 轮自我修复：① 4 Critical 修 ② 5 项 reducer hardening invariants：`lastEventId` 单调推进抗回退 / `pendingPermissions` cap 64/session + dropped 诊断计数 / `permission_resolved` 未匹配 requestId 诊断 + cancelled outcome / `toolCall` 校验收紧 + finite number / reducer 存储时复制抗引用共享)
> - ✅ Wave 2 **PR 6** [PR#4222](https://github.com/QwenLM/qwen-code/pull/4222) HTTP load/resume session — **MERGED 2026-05-17 04:58** (doudouOUC `[codex]`, 3h17m open→merge, 5 轮 review；体量 review 期间几乎翻倍 +1091/-35 → **+2078/-51 16 文件**；wenshao 03:33 第一次 APPROVE 后 11 分钟二次 /review 发现 **asymmetric coalesce guard** 等 2 Critical 翻回 CHANGES_REQUESTED——原只 guard load-on-resume，因 `resume()` seeds `lastEventId: 0` 与 load 语义不同必须双向；commit `db55b1c8b` 修后 04:55 最终 APPROVE)
> - ✅ Wave 2 **PR 7** [PR#4231](https://github.com/QwenLM/qwen-code/pull/4231) daemon-stamped client identity — **MERGED 2026-05-17 08:19** (chiga0, 1h23m open→merge, 最终 +910/-79；wenshao **9 parallel review agents** 覆盖 correctness/security/code quality/performance/test coverage + 3 audit personas；commit `52295980f4` 修 1 Critical（`InvalidClientIdError` 走 `sendBridgeError` 翻 400 而非 500）+ 6/7 其他 concern；`randomUUID()` + `client_` 前缀 122 bits entropy)
> - ✅ Wave 2 **PR 8** [PR#4232](https://github.com/QwenLM/qwen-code/pull/4232) session-scoped permission route — **MERGED 2026-05-17 09:48** (chiga0, 2h44m open→merge, 最终 +801/-30；rebase 到 main 后 single-commit `4eae97a33b`；review 抓 3 项：barrel re-export 新 type / **抽 `parsePermissionOutcome()` 共享 helper** 去掉 scoped+legacy 两 route 重复 / input validation 测试补全；`permission_already_resolved` event + bounded record 防 memory leak（同 PR#4217 cap pattern）+ 新 capability tag `session_permission_vote`)
> - 🔧 Wave 2.5 **PR 10** [PR#4237](https://github.com/QwenLM/qwen-code/pull/4237) SSE replay sizing + `slow_client_warning` backpressure — **OPEN** (doudouOUC, 2026-05-17 09:11, +845/-80 18 文件, 321 tests passing；`DEFAULT_RING_SIZE` 4000→8000 / `--event-ring-size` flag / **`slow_client_warning` frame at 75% queue full + hysteresis re-arm 37.5%** / `?maxQueued=N` query [16,2048] 越界 `400 invalid_max_queued` before opening SSE / 新 capability tag；⚠️ 内存翻倍：64 subs × 8000 frames × 500 B ≈ ~256 MB worst-case)
> - 🔧 Wave 4 **PR 15** [PR#4236](https://github.com/QwenLM/qwen-code/pull/4236) mutation gating helper + `--require-auth` — **OPEN** (doudouOUC, 2026-05-17 09:04, +523/-23 11 文件；`createMutationGate({ tokenConfigured, requireAuth })` 4-cell behavior matrix + Wave 1-2 mutation routes opt-in non-strict 作 `grep gateMutation` centralization marker + `CONDITIONAL_SERVE_FEATURES` registry primitive 为未来 per-deployment toggle 建 shape；与 Wave 2.5 并行不卡 heartbeat/replay/lifecycle；解锁 Wave 4 PR 16-21)
> - ✅ PR 3 follow-up [PR#4225](https://github.com/QwenLM/qwen-code/pull/4225) DaemonSessionClient hardening — **MERGED 2026-05-17 07:05** (chiga0, 3h11m open→merge, +323/-18 测试 141→205 行；多模型 /review pipeline：DeepSeek-v4-pro + claude-opus-4-7 + wenshao 4 轮 review；**chiga0 最终让步把 eager guard 改回 lazy**+ 加 `cursor monotonicity via Math.max`（同 PR#4217 reducer hardening pattern）+ abort-signal propagation + SSE `event.id` validation + test 钉 lazy-guard 防 regression)
> - ⚠️ [PR#4226](https://github.com/QwenLM/qwen-code/pull/4226) typed event schema 竞品 OPEN (doudouOUC, 2026-05-17 03:58, +1398/-18, 测试/生产 1.8x)；与 PR#4217 重叠，开 4 分钟后 PR#4217 即 MERGED；**待 close 或拆 SessionState reducer 部分作 Wave 5 PR 25 提前**
> - 🔧 **Bonus** client adapter spikes：[PR#4202](https://github.com/QwenLM/qwen-code/pull/4202) TUI / [PR#4203](https://github.com/QwenLM/qwen-code/pull/4203) channel / [PR#4199](https://github.com/QwenLM/qwen-code/pull/4199) IDE (chiga0)；DaemonSessionClient + typed event 两层都已 ship，现可全 typed reducer 切换

详 [§06 Roadmap & Ecosystem](./06-roadmap.md)。

---

## 六、阅读指引

| 角色 | 推荐路径 |
|---|---|
| **想知道这是什么** | §01（本章）|
| **想知道何时 ship 什么** | §06 Roadmap |
| **想知道为什么这么设计** | §02 Design Decisions |
| **想集成 client** | §03 HTTP API → §04 Client Experience |
| **关心安全** | §05 Security & Permission |
| **商业平台集成方** | §06 §四 External Reference Architecture |

---

下一篇：[02 — Design Decisions →](./02-architectural-decisions.md)
