# Qwen Code Daemon 架构设计（系列文档）

> Qwen Code 引入 HTTP daemon 模式的完整设计方案。基于 [SDK / ACP / Daemon 架构 Deep-Dive](../sdk-acp-daemon-architecture-deep-dive.md) 第七章"Qwen Code 引入 daemon 的工作量评估"展开为可执行的工程蓝图。

## 零、项目概况速览（截至 2026-05-29）

> 一句话：**daemon Mode B 功能面已完整**（routes + 协议 + bridge 抽离 + permission mediation + MCP shared pool + 双 transport），**剩 release 工程化**（PR#4490 反向 merge + PR 28 npm publish + PR 31 cut），**sustaining 工作并行推进**（DaemonWorkspaceService 重构 / telemetry / 新 route），客户端生态已扩到 **REST+SSE / ACP HTTP / MCP stdio 三维入口**，是 daemon 阶段性收官前最后一段路。

### 阶段定位

| 阶段 | 时间 | 状态 |
|---|---|---|
| Stage 1 (PR#3889) headless daemon 雏形 | 2026-05-13 | ✅ MERGED |
| Stage 1.5a (PR#4113) 1 daemon = 1 workspace | 2026-05-15 | ✅ MERGED |
| Wave 1-4 Protocol → Auth-gated mutation | 2026-05-16 ~ 18 | ✅ 24 PR MERGED |
| Wave 5 F1/F2/F3/F4 prereq + chiga0 SDK UI 双轨 | 2026-05-19 ~ 28 | ✅ MERGED to `daemon_mode_b_main` |
| **PR#4490 反向周期 merge `daemon_mode_b_main → main`** | 🚧 | **OPEN CHANGES_REQUESTED**（首次反向 merge，v0.16-alpha cut 前置）|
| **PR 28 npm publish + PR 31 v0.16-alpha cut** | ⏳ | 待开 |

**Wave plan 进度（22.75 / 31 ≈ 73%）**：

```text
Wave 1 Protocol foundation       ████████ 4/4 ✅
Wave 2 Session lifecycle         ████████ 4/4 ✅
Wave 2.5 Reliability             ██████   3/3 ✅
Wave 3 Read-only control plane   ██████   3/3 ✅
Wave 4 Auth-gated mutation       ██████████ 7/7 ✅
Wave 5 Architecture extraction   █████░    F1+F2+F3+F4prereq ✅ / F4 client adapter + PR 25 待
Wave 6 Release hardening         ░░░░░     PR 27 ✅ + PR 30a ✅；PR 28/29/31 待
```

### 团队与分工

| 作者 | 角色 | 重点 |
|---|---|---|
| **doudouOUC**（jinye）| **F-series 主力**，server-side 架构 | F1-F4 prereq / #4514 backlog / #4175 inventory / telemetry / file logger / route 扩 |
| **chiga0** | SDK + ACP transport + side-channel | SDK daemon UI 双 PR / cross-client sync / **ACP HTTP transport** / side-channel design / **non-blocking POST /prompt** |
| **ytahdn** | web-shell consumer | `packages/web-shell` daemon-backed React web-shell / context-usage API / daemon-react-sdk subpath |
| **jifeng**（2026-05-28 新加入）| MCP bridge | `qwen-serve-bridge` daemon 作 MCP server 让 Qoder / Claude Desktop / Cursor 接 |
| wenshao（项目 maintainer）| review + 架构守门 | 9-agent `/review` 并行 / 多轮 review fold-in |

### 9 个核心架构决策

| # | 决策 | 选择 |
|---|---|---|
| 1 | session 跨 client 共享 | default `sessionScope: 'single'` |
| 2 | 状态进程模型 | **1 daemon = 1 workspace × N session**（OS 进程级隔离）|
| 3 | MCP 生命周期 | F2 #4336 后 **workspace-scope shared transport pool** |
| 4 | FileReadCache 共享 | per-session 严格私有 |
| 5 | Permission flow | F3 #4335 **4 strategies**（first-responder / designated / consensus / local-only）|
| 6 | 多 client 并发 | 同 session prompt 串行（FIFO）+ 事件 fan-out |
| 7 | 部署模式 | **Mode B mainline**；Mode A parking lot |
| 8 | server / client / runtime boundary | 4 层分离 |
| 9 | **northbound transport** | **dual additive: qwen REST+SSE + 标准 ACP HTTP**（PR#4472 落地）|

详 [§02 Architectural Decisions](./02-architectural-decisions.md)。

### 客户端生态（3 维入口已建）

```text
                ┌──────────────────────────────────────────────┐
                │            qwen serve daemon                  │
                │  HttpAcpBridge + EventBus + workspace pool    │
                └──────────────────┬───────────────────────────┘
                                   │
       ┌───────────────────┬───────┴───────┬─────────────────┐
       ▼                   ▼               ▼                 ▼
  ① REST+SSE           ② ACP HTTP      ③ MCP stdio       (4) ACP stdio
  /session/* + /workspace/*   /acp     qwen-serve-bridge   (legacy local)
  消费者:                消费者:        消费者:            (in-process TUI)
  - web-shell (ytahdn)  - Zed         - Qoder
  - webui (chiga0)      - Goose       - Claude Desktop
  - 3 SDK / channel     - future      - Cursor / any MCP
    adapter / IM bot      ACP SDK       客户端
```

**关键差异化**：qwen-code 是**唯一同时打 ACP 标准 + MCP 标准**的 daemon —— Claude/Cursor 闭门；Goose 仅 ACP；qwen 开放协议生态是长期竞争轴。

### 正在进行的工作（截至 2026-05-29 OPEN PRs）

**优先级 1：v0.16-alpha cut 关键路径**：
- 🔥 [PR#4490](https://github.com/QwenLM/qwen-code/pull/4490) `chore(integration): daemon_mode_b_main → main` —— **首次反向周期 merge**，+87931/-22289，14 feature PR 周期 merge，OPEN CHANGES_REQUESTED，**alpha cut 必先合**
- ⏳ PR 28 npm publish scaffolding（发布清单已冻：`@qwen-code/{qwen-code, core, sdk, webui}`）
- ⏳ PR 31 v0.16-alpha.0 cut

**优先级 2：F-series 收尾 + 架构 sustaining**：
- 🚧 [PR#4563](https://github.com/QwenLM/qwen-code/pull/4563) `DaemonWorkspaceService` 重构（issue #4542 方案 C）+2054/-1011
- 🚧 [PR#4556](https://github.com/QwenLM/qwen-code/pull/4556) telemetry trace daemon prompt lifecycle +1325/-424
- 🚧 [PR#4552](https://github.com/QwenLM/qwen-code/pull/4552) T2.8 runtime MCP server add/remove +2886/-31
- 🚧 [PR#4608](https://github.com/QwenLM/qwen-code/pull/4608) telemetry tool spans + session.id to daemon/ACP +728/-632
- 🚧 [PR#4606](https://github.com/QwenLM/qwen-code/pull/4606) request-level logging for serve routes +178/-6

**优先级 3：新 daemon route + 客户端 UX**：
- 🚧 [PR#4610](https://github.com/QwenLM/qwen-code/pull/4610) `POST /session/:id/btw` for side questions（doudouOUC）+329/-128
- 🚧 [PR#4603](https://github.com/QwenLM/qwen-code/pull/4603) web-shell `/delete` 批量 delete（ytahdn）+948/-41
- 🚧 [PR#4511](https://github.com/QwenLM/qwen-code/pull/4511) side-channel coordination design docs (A1/A2/A4/A5) +434

### 仍未关的 backlog

**#4514 Tier-2 未开**：
- T2.1 `loadSession` / `resume` graduate from `unstable_`（需 #4253 prereq）
- T2.2 Pair tokens + per-client revocation（L sized，security review）

**#4514 Tier-3 全部待开**：branch/rewind/restore HTTP / `--max-body-size` / rate-limiting / `/extensions` HTTP / `/tasks` HTTP / multi-daemon coord

**#4511 side-channel design 剩余**：A2 / A5（A1+A4 ✅）

**Wave 5 剩余**：F4 client adapter 本体（scope 已两次 revisit）/ PR 25 output sinks

**Wave 6 剩余**：PR 28 npm publish / PR 29 auto-gen token / PR 30 容器化 deployment refs / PR 31 cut

### 未来方向参照：编排胶水层（dynamic workflows）

> 关联 [Claude Code Dynamic Workflows Deep-Dive](../claude-code-dynamic-workflows-deep-dive.md)。

Claude Code 2026-05-28 随 Opus 4.8 发布的 **dynamic workflows**（Claude 即兴写 JS 编排脚本 + 隔离 runtime 后台跑几十到上百 subagent）提示了 daemon 系列**还差的最上面一层抽象**：

- **当前缺口**：daemon 已铺好「后台执行 + 多 client + 非阻塞 prompt」的底层管道（non-blocking `POST /prompt` 返 202 / context-usage API / ACP HTTP transport / jifeng MCP bridge），但**没有「让 LLM 即兴写编排脚本 + 在 daemon runtime 跑 fan-out + 收敛」的胶水层**。
- **不需从零造**：可直接用 daemon 现有 route + jifeng MCP bridge 当 agent runtime，workflow 脚本只做 plan / fan-out / 收敛逻辑。
- **bundled workflow 是低成本 GA 抓手**：仿 `/deep-research` 绑 deep-research / codebase-bug-sweep / migration-helper 三个 flow 作 dogfooding 入口；`InlineParallelAgentsDisplay`（PR#4477）是天然展示载体。
- **避坑**：Anthropic 的双层 gate 静默失败是反例 —— daemon 已有 file logger（#4559）+ capability tag 机制，引入 workflow 灰度务必显式日志 + `/status` 暴露 flag 态。
- **实施成本估算 ~9-13 人周**（runtime 3-5 + 编排原语 2-3 + `/workflows` UI 2 + 1 bundled flow 1-2 + 灰度 1），可拆 3 Wave；详 [deep-dive §六](../claude-code-dynamic-workflows-deep-dive.md#六对-qwen-code-的启发)。

### 撤回的两条 backlog（架构 lesson）

| PR | backlog 项 | 撤回原因 |
|---|---|---|
| ❌ [PR#4516](https://github.com/QwenLM/qwen-code/pull/4516) T1.3 + T1.4 | `POST /compress` / `POST/GET /_meta` | 已可经 `POST /prompt` slash-passthrough + ACP `_meta` per-request 达到 |
| ❌ [PR#4515](https://github.com/QwenLM/qwen-code/pull/4515) T2.5 + T2.6 | `GET /session/:id/stats` / `/export` | 同理：可经 `POST /prompt` `/stats` / `/export` slash passthrough |

**lesson**：backlog "missing capability" 标记需 client demand 验证；发现 wire surface gap ≠ 要 implement；**已有 passthrough 的 surface 是 polish 不是 gap**。

### 关键文档入口

| 看什么 | 文档 |
|---|---|
| 项目当前状态 + 活动流 | [README](./README.md)（本文档，§一以下是活动流明细）|
| 项目概览 + Wave 进度 + 阶段说明 | [01-overview.md](./01-overview.md) |
| 9 个核心架构决策 | [02-architectural-decisions.md](./02-architectural-decisions.md) |
| HTTP / SSE API 完整路由表 | [03-http-api.md](./03-http-api.md) |
| 部署模式 / client 边界 | [04-deployment-and-client.md](./04-deployment-and-client.md) |
| Permission / Auth | [05-permission-auth.md](./05-permission-auth.md) |
| Roadmap + Wave breakdown | [06-roadmap.md](./06-roadmap.md) |
| **终态用户使用文档** | [07-user-guide.md](./07-user-guide.md) |
| 未来方向参照（编排胶水层）| [Claude Code Dynamic Workflows Deep-Dive](../claude-code-dynamic-workflows-deep-dive.md) |
| upstream 实施 tracker | [Issue #4175](https://github.com/QwenLM/qwen-code/issues/4175) |
| capability backlog | [Issue #4514](https://github.com/QwenLM/qwen-code/issues/4514) |
| side-channel design | [Issue #4511](https://github.com/QwenLM/qwen-code/issues/4511) |

---

## 一、TL;DR

> **2026-05-15 决策更新**：先忽略 Mode A（`qwen --serve`）。后续 roadmap 以 **Mode B：`qwen serve` headless daemon 作为底层 runtime** 为主线；Mode A 暂停在 [Issue #4156](https://github.com/QwenLM/qwen-code/issues/4156) 里作为 parking lot，已合并的 [PR#4160](https://github.com/QwenLM/qwen-code/pull/4160) 仅作为可复用 in-memory channel primitive 记录。

```
ACP NDJSON 协议 → HTTP+SSE daemon
1 daemon process = 1 workspace × N sessions multiplexed
```

`qwen serve` 启动时绑定 cwd = 单 workspace，daemon 内嵌单个 `qwen --acp` child；N session 通过 `QwenAgent.sessions: Map` 多路复用同一 child。多 workspace 部署 = 多 daemon process（systemd / docker / k8s 各 1 process）。

**关键设计依据**：
- 与 `qwen --acp` stdio **1:1 心智对齐**
- 跨 workspace = 跨 daemon process = **OS 进程级真隔离**（最强）
- systemd / cgroup / docker 直接 = per-workspace quota
- K8s 云原生天然契合（1 pod = 1 daemon = 1 workspace）
- Blast radius 最小（daemon crash 只影响 1 workspace）

**两种部署模式**：

| 模式 | 命令 | TUI | 适用场景 |
|---|---|:---:|---|
| **Mode B** | `qwen serve [--port N]` | ❌ | **当前主线**：服务器 / 容器 / 远端机器 / K8s pod / 所有 client 的统一 runtime |
| **Mode A** | `qwen --serve [--port N]` | ✅ 本地渲染 | **暂停推进**：待 Mode B HTTP/SSE event contract / control-plane / client identity 稳定后再评估 |

**当前状态**：
- ✅ [PR#3889](https://github.com/QwenLM/qwen-code/pull/3889) Stage 1 MERGED 2026-05-13（`qwen serve` headless daemon）
- ✅ [PR#4113](https://github.com/QwenLM/qwen-code/pull/4113) MERGED 2026-05-15（1 daemon = 1 workspace 收紧 + `--workspace` flag + `400 workspace_mismatch`）
- ✅ [PR#4160](https://github.com/QwenLM/qwen-code/pull/4160) MERGED 2026-05-15（`createInMemoryChannel` helper；从 Mode A stack 中产出，但现在只作为通用 primitive）
- 🔧 **Mode B 优先**（2026-05-15 决策）：Stage 1.5a must-haves（9 项）+ Stage 1.5c daemon-side state CRUD 优先；Mode A（[Issue #4156](https://github.com/QwenLM/qwen-code/issues/4156)）推迟到 1.5c 后
- 📋 **Implementation tracker**：[Issue #4175](https://github.com/QwenLM/qwen-code/issues/4175) doudouOUC Mode B v0.16 production-ready **31-PR rollout plan**（7 Wave：Protocol foundation → Session lifecycle → Wave 2.5 reliability → Read-only control plane → Auth-gated mutation → Architecture extraction → Release hardening）—— 详 [§06 §三·一](./06-roadmap.md#三一-issue-4175--31-pr-wave-breakdown-production-ready-tracker)
- 📦 **产品 v0.16.0 已发布**（2026-05-21，[PR#4404](https://github.com/QwenLM/qwen-code/pull/4404)）：semver 0.15.11 → 0.16.0 全 workspace 包 bump（含新 `acp-bridge` 包）。**在 main 上**含 daemon Wave 1-4 全部 + Wave 5 PR 22-series；Wave 5 **F-series（F1/F2/F3 + F4 prereq）在 `daemon_mode_b_main` 分支尚未周期 merge → 不在 v0.16.0**。⚠️ 产品 semver v0.16.0 ≠ daemon Wave plan 的 "PR 31 v0.16 production-ready" 里程碑
- 🎉 **Wave 1+2+2.5+3+4 + W5 PR 22-series + F1/F2/F3 + multi follow-up**（2026-05-16~21 daemon main 侧 **38 MERGED + OPEN/draft/CLOSED 若干**；F-series 4 PR 全 MERGED 到 `daemon_mode_b_main`：F1 #4319 / F1 follow-up #4334 / F2 #4336 / F3 #4335；F4 prereq #4360 OPEN；Wave plan 进度 **22.75/31 ≈ 73%**，剩余按 F1-F5 重组）：
  - ✅ [PR#4191](https://github.com/QwenLM/qwen-code/pull/4191) Wave 1 PR 2 capability registry **MERGED 2026-05-16 10:07** (doudouOUC)
  - ✅ [PR#4209](https://github.com/QwenLM/qwen-code/pull/4209) Wave 2 PR 5 per-request `sessionScope` override **MERGED 2026-05-16 15:54** (doudouOUC)
  - ✅ [PR#4205](https://github.com/QwenLM/qwen-code/pull/4205) Wave 1 PR 1 baseline harness **MERGED 2026-05-16 16:41** (doudouOUC)
  - ✅ [PR#4201](https://github.com/QwenLM/qwen-code/pull/4201) Wave 1 PR 3 DaemonSessionClient skeleton **MERGED 2026-05-16 17:01** (chiga0)
  - ✅ Wave 2 follow-up [PR#4214](https://github.com/QwenLM/qwen-code/pull/4214) **MERGED 2026-05-16 17:51** (doudouOUC) — capability registry 三套来源 lockstep 修
  - ✅ [PR#4217](https://github.com/QwenLM/qwen-code/pull/4217) Wave 1 PR 4 typed event schema **MERGED 2026-05-17 04:31** (chiga0, 5 轮 review / 2 轮自我修复；reducer hardening invariants：单调 lastEventId / 64-cap pendingPermissions / 诊断计数 / immutable storage)
  - ✅ [PR#4222](https://github.com/QwenLM/qwen-code/pull/4222) Wave 2 PR 6 HTTP load/resume session **MERGED 2026-05-17 04:58** (doudouOUC, 5 轮 review, 体量翻倍至 +2078/-51 16 文件；核心修：asymmetric coalesce guard bidirectional 收紧)
  - ✅ [PR#4231](https://github.com/QwenLM/qwen-code/pull/4231) Wave 2 PR 7 daemon-stamped client identity **MERGED 2026-05-17 08:19** (chiga0, 1h23m, wenshao 9 parallel review agents; randomUUID `client_` 前缀 122 bits entropy)
  - ✅ [PR#4232](https://github.com/QwenLM/qwen-code/pull/4232) Wave 2 PR 8 session-scoped permission route **MERGED 2026-05-17 09:48** (chiga0, 2h44m, rebase 到 main; permission_already_resolved event + bounded record + parsePermissionOutcome 共享 helper)
  - ✅ [PR#4235](https://github.com/QwenLM/qwen-code/pull/4235) Wave 2.5 PR 9 client heartbeat **MERGED 2026-05-17 10:57** (doudouOUC, 2h00m, **首轮一把过**；3471 serve/SDK tests pass + 4 安全不变式 + lockstep 维持)
  - ✅ [PR#4237](https://github.com/QwenLM/qwen-code/pull/4237) Wave 2.5 PR 10 SSE replay sizing + slow_client_warning backpressure **MERGED 2026-05-17 11:30** (doudouOUC, 2h19m, 3 轮 review; BoundedAsyncQueue.liveCount pre-emptive refactor + 8000 ring + 75%/37.5% hysteresis)
  - ✅ [PR#4236](https://github.com/QwenLM/qwen-code/pull/4236) Wave 4 PR 15 mutation gating helper + --require-auth **MERGED 2026-05-17 12:10** (doudouOUC, 3h06m, wenshao 端到端 verify 4-cell matrix, 解锁 Wave 4 PR 16-21)
  - ✅ [PR#4240](https://github.com/QwenLM/qwen-code/pull/4240) Wave 2.5 PR 11 session metadata + close/delete lifecycle **MERGED 2026-05-17 12:42** (doudouOUC, 2h16m, 4 轮 review, 1 Critical typecheck + events.close() ordering 修)
  - ✅ [PR#4241](https://github.com/QwenLM/qwen-code/pull/4241) Wave 3 PR 12 read-only status routes **MERGED 2026-05-17 13:37** (doudouOUC, 3h02m, wenshao 9 parallel agents + mimo-v2-5-pro + gpt-5.5 multi-model review, clientId forward for audit symmetry)
  - ✅ Follow-up [PR#4245](https://github.com/QwenLM/qwen-code/pull/4245) integration test mirror align **MERGED 2026-05-17 14:53** (doudouOUC, 40m 一把过；第三次 drift —— mirror pattern 工程债待解)
  - ✅ [PR#4251](https://github.com/QwenLM/qwen-code/pull/4251) Wave 3 PR 13 preflight + env diagnostics **MERGED 2026-05-17 23:29** (doudouOUC, 7h40m, 7 轮 review; **第六次 drift 被 wenshao 在 PR review 抓**; execSync→execFile migration + safeProxyValue 3-stage parse + 5 strict invariants 含 build-time grep + 第一个 land closed errorKind 7-value taxonomy)
  - ✅ [PR#4247](https://github.com/QwenLM/qwen-code/pull/4247) Wave 3 PR 14 MCP client guardrails **MERGED 2026-05-18 04:07** (doudouOUC, 13h09m daemon 项目史上最艰难一合; 9+ 轮 review / 11 [Critical] / 4 LLM model 多轮 audit; weReserved-driven 对称清理 across 3 spawn paths)
  - ✅ [PR#4249](https://github.com/QwenLM/qwen-code/pull/4249) Wave 4 PR 16 workspace memory + agents CRUD **MERGED 2026-05-18 06:27** (doudouOUC, **15h20m 新 lifetime 纪录**; 11 rounds + 6 LLM model; fold-in cascade 2a→2j; 最终 +5318/-8 23 文件)
  - ✅ [PR#4269](https://github.com/QwenLM/qwen-code/pull/4269) Wave 4 PR 19 safe workspace file read routes **MERGED 2026-05-18 08:17** (doudouOUC, **1h54m 极短** — PR 18 chokepoint 红利; 525/525 tests + 安全边界全过)
  - ✅ Follow-up [PR#4279](https://github.com/QwenLM/qwen-code/pull/4279) Windows 路径 normalize **MERGED 2026-05-18 09:53** (doudouOUC, **26m 极短 — daemon 项目最快 hotfix** 破 PR#4245 40m; `workspaceRelative` 漏 `path.sep` → `/` normalize)
  - ✅ [PR#4280](https://github.com/QwenLM/qwen-code/pull/4280) Wave 4 PR 20 file write/edit **MERGED 2026-05-18 14:37** (doudouOUC, 4h47m, 13 reviews; atomic temp+rename + content-hash precondition + edit single-match policy + X-Qwen-Client-Id 强制 audit; 最终 +2557/-266 25 文件)
  - ✅ [PR#4282](https://github.com/QwenLM/qwen-code/pull/4282) Wave 4 PR 17 approval/tools/init/MCP-restart **MERGED 2026-05-18 16:27** (doudouOUC, 6h21m, 34 reviews; 4 strict-gated mutation route + TrustGateError typed class 接 PR 13 errorKind taxonomy 不再 regex-match messages; 最终 +3685/-13 28 文件) — **Wave 4 完整 7/7 收尾 🎉**
  - ✅ [PR#4295](https://github.com/QwenLM/qwen-code/pull/4295) **Wave 5 PR 22a** acp-bridge skeleton + zero-coupling lift **MERGED 2026-05-18 17:23** (doudouOUC, **56 分钟极速** — pure refactor 红利; 8 reviews; wenshao "mechanically verified: 13 import sites unchanged, 28/28 new package tests, daemon SSE / ring replay / Last-Event-ID 链路保持"; **解锁 PR 22b/23/24**)
  - ✅ [PR#4291](https://github.com/QwenLM/qwen-code/pull/4291) Follow-up PR#4255 OAuth fold-in **MERGED 2026-05-18 23:01** (doudouOUC, 7h35m, 最终 +1406/-31 (×3.4 涨); 同时打 deepseek-v4-pro 5 post-merge + fold-in 1 deferred 5 项; OAuth 总线 ~+7578 LOC 史上最贵功能)
  - ❌ [PR#4293](https://github.com/QwenLM/qwen-code/pull/4293) Follow-up E2E baseline lockstep **CLOSED 16:45 (Superseded by PR#4282)** (8th drift, 24 分钟内 close; doudouOUC review-time bundle 模式真相: PR#4282 review 顺手做 3 cap baseline sync)
  - 🔧 [PR#4297](https://github.com/QwenLM/qwen-code/pull/4297) Follow-up PR#4282 post-merge 4 P2 **OPEN+CONFLICTING** (doudouOUC, review 期间 ×3.4 涨到 +1191/-54; init 用错 fileName + disabledTools stale 等)
  - ✅ [PR#4298](https://github.com/QwenLM/qwen-code/pull/4298) **Wave 5 PR 22b/1** acp-bridge lift status/paths/errors/bridge types **MERGED 23:00** (doudouOUC, 4h55m; **PR 22 改拆 4 阶段**: 22a + 22b/1 + **22b/2 design** + 22b/3 mechanical)
  - ✅ [PR#4300](https://github.com/QwenLM/qwen-code/pull/4300) Follow-up typed errors channel-closed + missing-cli-entry **MERGED 23:14** (doudouOUC, closes #4299; BridgeChannelClosedError + MissingCliEntryError 替代 regex on .message; typed-error 模式跨 PR 第 N 次复用)
  - ✅ [PR#4302](https://github.com/QwenLM/qwen-code/pull/4302) Follow-up telemetry Phase 1.5 polish **MERGED 2026-05-19 01:21** (doudouOUC, 2h14m, 最终 +454/-65 7 files **review 期间 +199 LOC** 255→454; 4 fix: `resolveParentContext()` ALS→OTel→synthetic fallback / coreToolScheduler abort-as-result snapshot / log/span consistency / sanitized error reason; **不在 daemon Wave plan** —— #4126 Phase 1 follow-up tracked in #4212)
  - ✅ [PR#4304](https://github.com/QwenLM/qwen-code/pull/4304) **Wave 5 PR 22b/2 design slice** `BridgeOptions` lift + `DaemonStatusProvider` seam **MERGED 2026-05-19 01:27** (doudouOUC, **1h57m** open→merge, +852/-371 11 files merge commit `68e3ec988a`; wenshao 1 轮 CHANGES_REQUESTED → 4 轮 inline 修 → qwen-latest /review LGTM → MERGED; **3-stage 改 4-stage split** —— 原 22b/2 implementation lift 拆为 22b/2 design (冻 contract, 6 design decisions) + 22b/3 mechanical (~3000 LOC IDE-driven `git mv`); `statusProvider?` optional + idle fallback 让 Mode A in-process consumer 可省不崩；**Wave 5 PR 22 现 3/4 MERGED，仅剩 22b/3 mechanical bulk lift**)
  - 🔧 [PR#4305](https://github.com/QwenLM/qwen-code/pull/4305) Follow-up #4291 post-merge 7 threads **OPEN+CHANGES_REQUESTED** 2026-05-18 23:50 (doudouOUC, +454/-116 5 files; qwen-latest review on MERGED #4291 后 7 项: memory+secret retention / DRY+回归预防 / log injection 姊妹堵 / audit DX / 死代码 / secret leak / polish; OAuth 总线 +8032 LOC if all merge)
  - ✅ [PR#4306](https://github.com/QwenLM/qwen-code/pull/4306) Follow-up unbreak E2E after #4271 **MERGED 2026-05-19 01:16** (doudouOUC, **41m 极短** — qwen-latest /review 一把 APPROVED; +48/-40 2 文件 integration test only; **第 9th drift** 同 #4268/#4284 class —— 揭示 integration test 是 unit baseline + production registry 之外第三处 hand-maintained 数据源 → "三套" 实际 4 套; **架构发现 double MCP discovery in ACP child**: `runAcpAgent` bootstrap + per-session `newSessionConfig` 各跑独立 `McpClientManager`, 2× spawn cost 真浪费, 值得 #4175 follow-up gate or share manager)
  - 🆕 **maintainer 分支策略重组（2026-05-19）**：剩余 Mode B 工作拆为 **F1-F5 feature PRs** target `daemon_mode_b_main` 长期 integration 分支，最终走 `daemon_mode_b_main → main` 周期 merge PR 触发 full CI
  - ✅ **F1** [PR#4319](https://github.com/QwenLM/qwen-code/pull/4319) acp-bridge self-sufficiency (原 PR 22b/3 + 22b' 合并) **MERGED 2026-05-19 16:26 to `daemon_mode_b_main`** (doudouOUC, ~8h, +5620/-4710 19 files, 5 rounds review, merge `981bc7c7e`; **`httpAcpBridge.ts` 4682 LOC → 97 LOC shim**; 4 lift step + 新 `BridgeFileSystem` 注入接口; 1221/1221 tests; 3 deferred 由 PR#4334 全 ship)
  - ✅ **F1 follow-up** [PR#4334](https://github.com/QwenLM/qwen-code/pull/4334) BridgeFileSystem wiring + channelInfo fix **MERGED 2026-05-20 05:10 to `daemon_mode_b_main`** (doudouOUC, +894/-54 9 files, merge `dfa8ca40`; 3 batched: ① ACP `writeTextFile/readTextFile` 走 PR 18 `WorkspaceFileSystem` 真关 PR 18 `ws.ts:613` TOCTOU 线 ② `closeSession/killSession` 用 `channelInfoForEntry(entry)` closes #4325 ③ 新 PR 18 primitive `WorkspaceFileSystem.writeTextOverwrite` 让 ACP writes 默认 0o600 + mode preservation + atomic temp+rename; **user-visible**: agent writes through symlinks 现 reject `symlink_escape`)
  - ✅ **F1 test split** [PR#4445](https://github.com/QwenLM/qwen-code/pull/4445) `httpAcpBridge.test.ts` 6861 LOC 跨包搬迁 **MERGED 2026-05-23 08:46 to `daemon_mode_b_main`** (doudouOUC, ~14h40m, +597/-449 5 files, merge `57d04786`; F1 第 3 也是最后一个 deferred follow-up; 181 tests → 177 `acp-bridge/src/bridge.test.ts` + 4 split 到 `cli/serve/daemonStatusProvider.test.ts`; `git mv` 100% rename 保 blame; 新 `internal/testUtils.ts` 抽共享 fixture; 跨包解析双通道 TS subpath export + vitest resolve.alias; 2 轮 self-review agent fold 8 findings; **F1 三个 deferred 全部 ship 完**)
  - ✅ **F2** [PR#4336](https://github.com/QwenLM/qwen-code/pull/4336) Wave 5 PR 23 shared MCP transport pool **MERGED 2026-05-21 15:56 to `daemon_mode_b_main`** (doudouOUC, ~40h open→merge, merge `46f8d48f`, 最终 +10308/-147 38 files, **22 commits = 6 feature + 16 review fold-in**, **247 reviews / 30 CHANGES_REQUESTED rounds**; **解 #4306 揭示 "double MCP discovery in ACP child" 架构发现**——N session 共享 `(name + fingerprint)` 一个 transport，4 session × `--mcp-client-budget=2` workspace 封顶 2 而非 8; 6 feature commit 全落地（discover split / `McpTransportPool` + `SessionMcpView` / cross-platform pid sweep / wire 到 `QwenAgent.mcpPool` ctor + SIGTERM/IDE-close lifecycle / pool-aware status + restart routes 加 `entryCount`+`entrySummary`+`?entryIndex=` + 2 cap tag `mcp_workspace_pool`/`mcp_pool_restart` / workspace-scope budget `WorkspaceMcpBudget` + `broadcastBudgetEvent`）; design doc v2.2; **existing standalone qwen 路径 untouched 71/71 tests pass unchanged**)
  - ✅ **F3** [PR#4335](https://github.com/QwenLM/qwen-code/pull/4335) Wave 5 PR 24 PermissionMediator 4 strategies **MERGED 2026-05-20 11:13 to `daemon_mode_b_main`** (doudouOUC, +9748/-517 62 files, merge `8eeb5100`; 4 strategies (first-responder pre-F3 default 字节保 / designated / consensus N-of-M + partial vote SSE / local-only kernel-stamped); MultiClientPermissionMediator owns all state; 512-entry audit ring NOT on SSE; 5 hardness invariants 含 N3 deliberately preserved 旧 originatorClientId 不一致 保 wire 字节; pair-token + revocation API 推迟 follow-up)
  - ✅ **F4 prereq** [PR#4360](https://github.com/QwenLM/qwen-code/pull/4360) daemon protocol completion **MERGED 2026-05-21 03:11 to `daemon_mode_b_main`** (doudouOUC, +897/-24 11 files; 2 commits bundled — F4 client-adapter wave 渲染前置: ① **#19 stamping** (chiga0 #4175 comment #19) — `serverTimestamp` (`_meta` at SSE write boundary) / `errorKind` on `stream_error` / tool `provenance` (builtin\|mcp\|subagent + serverId, emitStart+emitResult+emitError 都 stamp) ② **#15 SSE reducer gap detection** (Ilya0527 #4175 comment #15 multi-client state divergence bug) — ring eviction 时 force-push synthetic `state_resync_required` terminal frame; 全 additive backward-compat)
  - ✅ **chiga0 SDK 侧并行 track** —— [PR#4328](https://github.com/QwenLM/qwen-code/pull/4328) `feat(daemon): add shared UI transcript layer` **MERGED 2026-05-22 06:02** (chiga0, +6103/-1993 33 files, merge `d0563ecf5`; 为 web chat / web terminal 加共享 daemon UI 层: typed daemon events → UI events → transcript blocks → framework-free store + React bindings in `@qwen-code/webui`; 解决"web clients should not each reimplement streaming merge / tool preview / permission state / shell output"; **native local TUI / ACP / channel / IDE defaults 不动**——与 maintainer web-first 路线对齐); ✅ [PR#4353](https://github.com/QwenLM/qwen-code/pull/4353) `feat(sdk/daemon-ui): unified completeness follow-up to #4328` **MERGED 2026-05-24 00:51 to `daemon_mode_b_main`** (chiga0, ~4d 17h, +8531/-110 21 files, merge `cf5c2453`, **24 commits / 61 reviews**（review 强度第二高，仅次 F2 #4336 的 247）; **#4328 ~55% → #4353 ~95%**; PR-A through PR-K 覆盖 event 13→28+ types / serverTimestamp / state machine / tool preview taxonomy / render contract / adapter conformance / WebUI migration / 开发者指南 / subagent nesting 消费 / resync-required event handling; **R1-R7 7 轮 review**，收尾阶段从 SDK 消费功能转为 security+edge-case hardening (Critical OAuth fragment leak / ensureSafeImageUrl 限 `data:image/*` / escapeMarkdownText 覆盖 `<` / recovery flow chicken-and-egg); 剩 tool.progress + multimodal 跨包 follow-up)
  - ✅ **chiga0 第 7 PR — non-blocking POST /prompt return 202 (architectural)** [PR#4585](https://github.com/QwenLM/qwen-code/pull/4585) `feat(daemon): non-blocking POST /prompt — return 202 with promptId` **MERGED 2026-05-28 08:29 to `daemon_mode_b_main`** (chiga0, +528/-351 10 files, closes #4582); **重大架构变化**：`POST /session/:id/prompt` 现 **非阻塞** 立刻返 `202 Accepted` with `{promptId, lastEventId}`，prompt 完成通过 SSE `turn_complete` / `turn_error` 事件异步交付 by `promptId` correlated；从 daemon design §03 原 blocking model 演化；解决 long-running prompts 阻塞 connection 问题 + 让 client side 不再需要 await HTTP response 完成
  - ✅ **jifeng 新 contributor — serve-bridge MCP server (qwen-serve-bridge)** [PR#4555](https://github.com/QwenLM/qwen-code/pull/4555) `feat(sdk): add serve-bridge MCP server & rename mcp → daemon-mcp` **MERGED 2026-05-28 18:00 to `daemon_mode_b_main`** (jifeng, +2260/-204 25 files); **为 `qwen serve` daemon 加 MCP Server 桥接层 `qwen-serve-bridge`** 让**任何 MCP 兼容客户端（Qoder / Claude Desktop / Cursor）可通过 stdio 协议与 qwen-code agent 交互**——daemon 作 MCP server 提供 tools；原 `mcp` 重命名为 `daemon-mcp` 区分；commit `ce7a8afc5` 实现 + `0f2f6e6a9` README + `908158459` 2026 copyright
  - ✅ **session tasks snapshot endpoint** [PR#4578](https://github.com/QwenLM/qwen-code/pull/4578) `feat(daemon): add session tasks snapshot endpoint` **MERGED 2026-05-28 06:47 to `daemon_mode_b_main`** (doudouOUC, +934/-4 26 files); 新只读 daemon session task snapshot API `GET /session/:id/tasks` backed by ACP status extMethod `qwen/status/session/tasks` + SDK helpers + web-shell `/tasks` 本地处理；动机：**web-shell 需在 prompt streaming 中检查 background tasks 不再排队等 ACP prompt queue**；reviewer focus: whitelist task serialization / bridge status path bypass prompt FIFO / web-shell `/tasks` interception
  - ✅ **server-side shell execution for `!` bang prefix** [PR#4576](https://github.com/QwenLM/qwen-code/pull/4576) `feat(daemon): server-side shell command execution for ! (bang) prefix` **MERGED 2026-05-28 06:06 to `daemon_mode_b_main`** (doudouOUC, +356/-10 16 files); 新 `POST /session/:id/shell` 路由 **直接 daemon 端 shell 执行 bypass LLM**——bridge `executeShellCommand` 用 `ShellExecutionService` + streaming output via `shell_output` SSE 事件；ACP `sessionShellHistory` extMethod 注入 command+result 到 LLM history（匹配 CLI 的 `addShellCommandToGeminiHistory` 格式）；SDK 新 `shellCommand()` on `DaemonClient` / `DaemonSessionClient` + 新 `DaemonShellCommandResult` 类型；web-shell `!` 前缀 handler 走此路由
  - ✅ **chiga0 第 6 PR — cross-client real-time sync follow-up cleanup** [PR#4510](https://github.com/QwenLM/qwen-code/pull/4510) `fix(daemon): cross-client sync follow-up cleanup (epoch-reset resync, approval-mode serialization, catch-up indicator)` **MERGED 2026-05-28 02:52 to `daemon_mode_b_main`** (chiga0, 创建 2026-05-25 13:08, +1233/-117 10 files); **关 PR#4484 deferred 3 项 design items 中的几个**：① **Epoch-reset resync**——subscriber Last-Event-ID 在 bus high-water 之后（daemon restart 后 EventBus 重建），bus 现 emit `state_resync_required{reason:'epoch_reset'}` 在 replay 前；之前 empty post-restart ring 让 ring-evicted 检查 no-op，consumer 看到"裸"重连无 signal ② **Approval-mode change serialization** ③ **Catch-up indicator** 等
  - ✅ **followup_suggestion server-pushed SSE event for webui** [PR#4507](https://github.com/QwenLM/qwen-code/pull/4507) `feat(daemon): server-pushed followup_suggestion event for the webui` **MERGED 2026-05-27 13:19 to `daemon_mode_b_main`** (doudouOUC, +1154/-22 18 files); 新 daemon SSE 事件 `followup_suggestion`——ACP child 在 every clean assistant turn 后 push server-generated **ghost-text suggestion**（"what you might want to ask next"）给 attached client；镜像 in-process CLI `AppContainer.tsx` 集成；webui `<InputForm followupState={...}>` prop 接入；让 webui (+ future TUI/IDE daemon adapter) 无需 direct LLM access 即可渲染 followup
  - ✅ **chiga0 第 3 PR — ACP HTTP transport [RFD #721]** [PR#4472](https://github.com/QwenLM/qwen-code/pull/4472) `feat(daemon): ACP Streamable HTTP transport at /acp [RFD #721]` **MERGED 2026-05-27 08:25 to `daemon_mode_b_main`** (chiga0, 创建 2026-05-24 01:14 历时 ~3.5 天, 最终 +6098/-316 20 files, 多轮 R1-R9+ review); 落实 [§02 决策 9 dual northbound transport](./02-architectural-decisions.md#9-dual-northbound-transport--restsse--acp-http2026-05-24) —— 在 `qwen serve` 加 **official ACP Streamable HTTP transport** 作第二 northbound transport 挂 `/acp` 端点 与 REST+SSE 共存共享同一 `HttpAcpBridge` + `EventBus`；Zed / Goose / future ACP-native SDK 可直接驱动 daemon；vendor extension `_qwen/...` namespace；`QWEN_SERVE_ACP_HTTP=0` opt-out
  - ✅ **chiga0 drop dead try/catch around `model_switched` publish (BX9_p)** [PR#4557](https://github.com/QwenLM/qwen-code/pull/4557) `refactor(daemon): drop dead try/catch around model_switched publish (BX9_p)` **MERGED 2026-05-27 09:09 to `daemon_mode_b_main`** (chiga0, +11/-9 2 files); 微 cleanup —— `EventBus.publish()` 有 documented never-throws 契约 (BX9_p)，`eventBus.ts:190` 注释 "Don't add new try/catch wrappers around publish()"；删 `setSessionModel` 成功路径 `model_switched` publish 多余 try/catch 保契约 consistent
  - ✅ **ytahdn 第 2 PR — context-usage API + daemon-react-sdk subpath + dialog UX** [PR#4573](https://github.com/QwenLM/qwen-code/pull/4573) `feat(web-shell,webui,sdk): context-usage API + daemon-react-sdk refactor + dialog UX` **MERGED 2026-05-28 09:59 to `daemon_mode_b_main`** (ytahdn, 创建 2026-05-27 11:13 历时 ~22h, 最终 **+11568/-4059 119 files** review 期间 expand from +9820/-3713); **#4380 MERGED 同一天 9.5h 后开第 2 PR**，连续推进 web-shell；4 块改动：① **新 `GET /session/:id/context-usage` 端点** 全链路 (SDK `DaemonSessionContextUsageStatus` + `sessionContextUsage()` / acp-bridge `ServeSessionContextUsageStatus` + `SERVE_STATUS_EXT_METHODS.sessionContextUsage` / CLI route + `acpAgent.buildSessionContextUsageStatus()`) + 新 capability `session_context_usage: {since:'v1'}` 返 session token 使用分布 ② **webui daemon provider 模块化重构** —— `packages/webui/src/daemon/` 拆为 `session/`（DaemonSessionProvider + actions/selectors/mappers/clientLifecycle/promptContent/transcriptToMessages）+ `workspace/`（DaemonWorkspaceProvider + actions + hooks: useDaemonAgents/Auth/Mcp/...）+ 新 `daemon-react-sdk` subpath export (`@qwen-code/webui/daemon-react-sdk`)，web-shell 经 subpath 统一消费解耦直接依赖 ③ **dialog UX**：11 个弹窗 ← 返回图标移除改右侧 ESC 按钮；新 `data-keyboard-scope` 机制让弹窗 input 仍响应 Esc/Arrow 键；弹窗打开 blur Editor + 禁用全局快捷键 close 后 refocus；补全对齐 CLI 选中不 auto-submit；移除 `/stats` 子命令补全 + Model 弹窗 `c` 键自定义模型 ④ **review fix fold-in（commit 2 `f31c8ddc8`）**：**Security**：Mermaid securityLevel 'loose' → revert 'strict' + sanitizer strip foreignObject/style；**Shift+Tab 不再 silently 设 yolo mode** 只 approve 当前请求；`clientLifecycle` 用 `sessionStorage` 做 **per-tab client ID 隔离**；**Bug fix**：`cancel()` finally block session-ID guard / `lastRecapBlockCountRef` session switch reset / `collectContextData` try/catch + field stripping / `useDaemonResource` sequence counter 防 stale response overwrite / `detachDaemonClient` `keepalive: true` tab-close 时请求可靠送达 / `ResumeDialog` error state；**Perf**：`useSyncExternalStore` selector hoisted via `useCallback`；**Feature**：parallel agents merged display `ParallelAgentsGroup` 组件；**Tests**：`clientLifecycle.test.ts` +9 + `useDaemonResource.test.tsx` +5 + `Markdown.test.ts` 更新 sanitization
  - ✅ **daemon 团队第 3 作者 ytahdn — 第一个 web client 消费者** [PR#4380](https://github.com/QwenLM/qwen-code/pull/4380) `Feat/daemon react cli` **MERGED 2026-05-27 01:42 to `daemon_mode_b_main`** (ytahdn daemon 团队第 3 作者继 doudouOUC + chiga0, 创建 2026-05-21 06:07 历时 ~6 天) (ytahdn daemon 团队第 3 作者继 doudouOUC + chiga0, +12274/-25 **107 files**, target `daemon_mode_b_main`, 41 commits / 31 reviews); **新 `packages/web-shell` daemon-backed React web-shell**——把 chiga0 SDK daemon UI 层 (#4328/#4353) 真落地成可用 web client，接 daemon session + SSE + permission + slash command completion + model/approval 切换 + session resume + memory/MCP/skills/agents view + `/session/:id` URL restore；对齐 CLI/ACP 行为 (`/model --fast` / `/rename --auto` / `/new` / `/reset`)；**第一个真实 web client 验证 chiga0 SDK 设计**；wenshao 2026-05-24 incremental review (161 files +24K/-4K across 22 new commits, 9 parallel review agents) **no new high-confidence Critical** —— 方向健康但旧 thread 未消；风险: `/session/:id` SPA route 与 daemon API `/session` 重叠靠 Vite proxy 显式 bypass HTML navigation
  - ✅ **chiga0 第 4 PR — cross-client real-time sync 5 fixes** [PR#4484](https://github.com/QwenLM/qwen-code/pull/4484) `feat(acp-bridge): cross-client real-time sync completeness (5 fixes)` **MERGED 2026-05-25 09:28 to `daemon_mode_b_main`** (chiga0, 创建 2026-05-24 16:39 历时 17h, 最终 +835/-105 经 review 期间 expand) (chiga0, +195/-18 3 files); cross-client sync audit 发现 8 gap, 本 PR 修 5 个机械性 bridge-layer 的: ① `user_message_chunk` echo on interactive prompt path (之前 client B 看不到 client A 发的 prompt 直到 reload) ② `prompt_cancelled` broadcast on cancelSession (之前只 forward ACP, 不发 bus event) ③ `replay_complete` sentinel on Last-Event-ID 重连成功路径 (与失败路径 `state_resync_required` 对偶) ④ `originatorClientId` on `session_metadata_updated` envelope ⑤ `originatorClientId` on `session_closed` envelope (之前只有 `data.closedBy`); 仍 deferred 3 项需 design 讨论 (in-session setModel bus emit / approval-mode persist 与 broadcast 关系 / `permission_resolved.originatorClientId` voter-vs-originator 语义不一致); **部署协调**: 下游 gateway 自有 user-echo workaround 与 daemon-side echo 会双重帧, 建议先部署 daemon 再 flip `GATEWAY_ECHO_USER_MESSAGE=false`; `_meta.source: 'bridge-echo'` vs `'gateway-echo'` 让 SDK dedup 兜底; 291/291 vitest pass
  - 🔧 **chiga0 第 3 PR — ACP HTTP transport 接入 ACP 生态** [PR#4472](https://github.com/QwenLM/qwen-code/pull/4472) `feat(daemon): ACP Streamable HTTP transport at /acp [RFD #721]` **OPEN CHANGES_REQUESTED**（DRAFT 已转正）05-24 01:14 创建，05-25 14:04 最新更新 (chiga0, **+3475/-0 11 files**, 11 commits / 18 reviews, target `daemon_mode_b_main`); **在 `qwen serve` 加 official ACP Streamable HTTP transport ([RFD #721](https://github.com/agentclientprotocol/agent-client-protocol/pull/721)) 作第二 northbound transport** —— 挂载 `/acp` 单端点，与现有 REST+SSE API **共存**共享 `HttpAcpBridge`+`EventBus`；**让 Zed / Goose / future ACP-native SDK 可直接驱动 daemon**；3 关键决策：dual-transport additive / `_qwen/...` extension namespace / WebSocket+HTTP2 等 deferred；**R1-R9 9 轮 review** 修 wire-level concurrency 经典坑（reconnect / ownership / leaks / write-failure / permission-vote release / concurrent-prompt abort / zombies / close TOCTOU / pump lifecycle / reconnect prompt survival）；**新加 `f101aca1b3` REST parity batch + official extension scheme** —— 跟进 RFD #721 spec 演进，把 daemon REST endpoints (`/session/*` / `/workspace/*`) 同样通过 `/acp` extension namespace 暴露完成 dual-transport 对偶；最新 commit `ef59636022` 把 follow-up roadmap 入 docs；**为什么提供这个能力的 5 层 rationale**（战略 ACP-as-LSP / 客户 vendor lock-in 成本 / 竞争 open-vs-closed 差异化 / 架构 dual-transport additive 控风险 / 时机 Draft spec 早期 mover）文档化到 [§02 决策 9](./02-architectural-decisions.md#9-dual-northbound-transport--restsse--acp-http2026-05-24)
  - ✅ **#4514 capacity backlog T2.9 — prompt absolute deadline + SSE writer idle timeout 双 opt-in flag** [PR#4530](https://github.com/QwenLM/qwen-code/pull/4530) `feat(serve): prompt absolute deadline + SSE writer idle timeout (#4514 T2.9)` **MERGED 2026-05-26 17:09 to `daemon_mode_b_main`** (doudouOUC, 创建 2026-05-26 02:41 历时 ~14h，最终 +1458/-151 14 files target 改至 `daemon_mode_b_main`); **关 [#4514](https://github.com/QwenLM/qwen-code/issues/4514) Tier-2 ⭐⭐ S-sized**——15s heartbeat + AbortSignal local 足够，remote / long-running deployment 需要 explicit app-layer deadline；v0.16-alpha known-limit。两个 opt-in flag 默认 off → single-user loopback 行为 bit-for-bit 不变：① **`--prompt-deadline-ms <n>`** (env `QWEN_SERVE_PROMPT_DEADLINE_MS`) —— server-side wallclock cap on `POST /session/:id/prompt`；expiry 时 daemon abort AbortController + 返 504 with `errorKind: 'prompt_deadline_exceeded'`；per-prompt body `deadlineMs` **可 SHORTEN below cap 但不能 EXTEND**（operator 是 upper bound）；**关 `httpAcpBridge.ts` 长存的 `FIXME(stage-2)` 注释——buggy agent 忽略 AbortSignal 时握住 FIFO 不放问题** ② **`--writer-idle-timeout-ms <n>`** (env `QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS`) —— per-SSE-connection idle deadline；当 `n` ms 内无 write flush 成功（不论是 heartbeat 还是真事件），daemon emit terminal `client_evicted` 帧 with `reason: 'writer_idle_timeout'` 并 close；**关 SSE handler 的 "Stage 2 may add" gap**。**Conditional capability tags** `prompt_absolute_deadline` / `writer_idle_timeout` 仅在 flag set 时 advertise，SDK consumer 可 pre-flight 再发 `deadlineMs`（老 daemon 静默 drop 匹配 v=1 additive rule）。**SERVE_ERROR_KINDS / DAEMON_ERROR_KINDS 两端 mirror +2 个**（之前 9 / 8 → 现 11 / 10），关 taxonomy drift。**6 commits 迭代**：① 初版 +13 tests ② simplify pass `trackWriterIdle` boolean 防 chatty stream 每 write stamp timestamp / `isPositiveIntegerMs` predicate / `abortableBridgePromptImpl()` helper ③ **Copilot review race-guarantee fix** —— 原 `await bridge.sendPrompt(...) after abort.abort()` 不能 guarantee deadline（buggy agent 忽略 abort 时 504 永不 fire 反而 defeats T2.9 整个目的）；改 `Promise.race(bridge.sendPrompt, deadlinePromise)` 让 deadline timer 独立 reject race，orphaned bridge promise tail `.catch(() => undefined)` 防 unhandledRejection；同时修文档错误—— `<15s` 不是 no-op（idle timer 独立检查 elapsed-since-last-flush，无事件时 10s 设置会在第一个 15s heartbeat refresh 前 evict 健康连接）④ cosmetic + 准确性 ⑤ **wenshao review fold-in 3 of 6 [Suggestion]**: `sendDeadlineResponseIfFired` stderr breadcrumb 含 sessionId 让 operator `grep "prompt deadline fired"` triage / `parseDeadlineEnv` 不再静默对 whitespace-only env / **`MAX_TIMER_DELAY_MS = 2_147_483_647`** (2^31-1 ms ~24.8 天) 上限校验防 Node `setTimeout` overflow（>2^31-1 silently compressed to 1ms + TimeoutOverflowWarning，operator 设 30 天 cap 会立即 504 every prompt）+ 25 new tests（6 malformed env / it.each boot validation / catch-path bare AbortError / `deadlineMs` body 全 branch / active SSE writes refresh `lastWriteAt`）⑥ DRY pass: `runBudget.ts` 的 `MAX_TIMEOUT_MS` constant export 共享（之前 module-private）+ `emitPromptDeadline504(res, err, sessionId)` 抽 helper 让 deadline-race catch path 与 `sendDeadlineResponseIfFired` defense-in-depth path 共用；269/269 tests passing；docs `docs/users/qwen-serve.md` 加 2 flag + 更新 "phantom SSE connections" known-gap callout；与 PR#4516 不同 target —— 这条 T2.9 是 main 直接进，不走 `daemon_mode_b_main` integration branch
  - ❌ **#4514 backlog T1.3 + T1.4（manual compaction + per-session metadata）** [PR#4516](https://github.com/QwenLM/qwen-code/pull/4516) **CLOSED 2026-05-26 09:25** without merge（doudouOUC self-close，re-triage #4514 后撤回：compress 已可经 `POST /prompt` `/compress` slash-passthrough、`_meta` 已有 per-request ACP `_meta` passthrough，均非 must-have）。详见 §零 [撤回的两条 backlog](#撤回的两条-backlog架构-lesson)
  - ✅ **F5 release chain PR 27 — v0.16-alpha docs known-limits + SDK env fallback** [PR#4473](https://github.com/QwenLM/qwen-code/pull/4473) `docs(serve): v0.16-alpha known limits + SDK QWEN_SERVER_TOKEN env fallback (PR 27)` **MERGED 2026-05-24 15:57 to `daemon_mode_b_main`** (doudouOUC, +175/-6 4 files, merge `63803deab`; **F5 release chain 第 1 PR**——按 #4175 2026-05-24 v0.16-alpha scope freeze 4 PR 链: **27 (docs) → 28 (npm publish) → 30a (local launch templates) → 31 (cut)**；v0.16-alpha targets **text-only chat / coding with local-only deployment**；2 things bundled: ① SDK `DaemonClient` 构造函数 fall back to `QWEN_SERVER_TOKEN` env 当 `opts.token` 缺，对齐 daemon 侧已有 token env 支持 ② `docs/users/qwen-serve.md` 加 v0.16-alpha banner + "known limits" section（远端部署 / 多 workspace / multimodal / observability 等暂不在 alpha scope）
  - ✅ **F5 release chain PR 30a — local launch templates** [PR#4483](https://github.com/QwenLM/qwen-code/pull/4483) `docs(deploy): local launch templates for v0.16-alpha (PR 30a)` **MERGED 2026-05-25 03:00 to `daemon_mode_b_main`** (doudouOUC, +224/-1 3 files; F5 链第 3 PR——PR 27 加的 "Local launch via systemd/launchd/nohup/tmux (templates land in PR 30a)" 占位填实，sibling reference under `docs/deploy/` 含 systemd unit / launchd plist / nohup+tmux 三种本地启动模板)
  - ✅ **Periodic main → integration sync** [PR#4469](https://github.com/QwenLM/qwen-code/pull/4469) `chore(integration): sync main into daemon_mode_b_main (2026-05-24)` **MERGED 2026-05-24 07:42 to `daemon_mode_b_main`** (doudouOUC, **+50124/-9334 423 files**; 45 commits from main since 2026-05-19；F5 release chain 前置依赖 sync 防 PR 27/28/30a/31 每个都背 45-commit delta 作为 conflict surface；包含 v0.16.0 release + telemetry PR#4321/#4367 + 多 fix 入 integration 分支) + [PR#4500](https://github.com/QwenLM/qwen-code/pull/4500) `(2026-05-25)` **MERGED 2026-05-25 09:32** (+501/-0 7 files；mirror #4469 pattern；拉 5 main commits 含 PR#4464/#4465 weixin fix + PR#4470 text buffer race fix + 另 2)
  - ✅ **/recap route — #4175 daemon missing-feature inventory #1** [PR#4504](https://github.com/QwenLM/qwen-code/pull/4504) `feat(serve): add POST /session/:id/recap` **MERGED 2026-05-26 07:09 to `daemon_mode_b_main`** (doudouOUC, +621/-11 19 files; 暴露 `generateSessionRecap` (`packages/core/src/services/sessionRecap.ts`) 给 daemon client 经新 `POST /session/:id/recap` 路由，SDK / web UI / IDE-plugin caller 可不走 full prompt turn 拉一句"上次到哪了"summary；**关 #4175 "core features missing from daemon" inventory 第 1 项**——TUI + `useAwaySummary` 已用 `/recap`，daemon client 之前无访问路径；v1 仅 manual trigger，不带任何 cache / auto re-run；template 跟 Wave 4 PR 17 approval-mode 同形 + 加 `session_recap` capability tag)
  - ✅ **CORS allowlist T2.4 — 关 #4514 backlog 又一项** [PR#4527](https://github.com/QwenLM/qwen-code/pull/4527) `feat(serve): --allow-origin <pattern> CORS allowlist (T2.4 #4514)` **MERGED 2026-05-26 12:16 to `daemon_mode_b_main`** (doudouOUC, +860/-23 10 files; **关 [#4514](https://github.com/QwenLM/qwen-code/issues/4514) Tier-2 ⭐⭐⭐ S-sized T2.4**——按 #4514 "if we can only pull 3 things next" 推荐第 3 项；新 `--allow-origin <pattern>` flag 替代 `denyBrowserOriginCors` 无条件 403 wall + 新 `allow_origin` conditional capability tag 让 SDK / webui pre-flight；**unblock entire browser-webui surface**——之前所有 cross-origin 请求 daemon 一律 403)
  - ✅ **daemon file logger — 关 #4548** [PR#4559](https://github.com/QwenLM/qwen-code/pull/4559) `feat(serve): add daemon file logger (#4548)` **MERGED 2026-05-27 06:05 to `daemon_mode_b_main`** (doudouOUC, +3028/-217 14 files; per-process daemon file logger at `~/.qwen/debug/daemon/serve-<pid>-<workspaceHash>.log`，`QWEN_RUNTIME_DIR` 可配，`QWEN_DAEMON_LOG_FILE=0` opt-out；route `runQwenServe` lifecycle + `sendBridgeError` 路由错误 + `writeServeDebugLine` debug breadcrumb + ACP child stderr 都进 daemon log，stderr 输出保留；新 `BridgeOptions.onDiagnosticLine` + `createSpawnChannelFactory({ onDiagnosticLine })` 让 acp-bridge 包 host-agnostic)
  - ✅ **chiga0 第 6 PR — in-session model switch reaches bus (side-channel A1)** [PR#4546](https://github.com/QwenLM/qwen-code/pull/4546) `feat(daemon): in-session model switch reaches the bus (A1)` **MERGED 2026-05-26 16:06 to `daemon_mode_b_main`** (chiga0, +456/-22 5 files; **实现 [#4511](https://github.com/QwenLM/qwen-code/issues/4511) side-channel coordination design A1 项**——`/model` slash command 或 plan-mode model switch 现在到达所有 attached client；之前只 HTTP `POST /session/:id/model` 路径 publish `model_switched`，in-session switch 让 peers 的 model badge 静默 stale；transport 用新 daemon-side 事件 `current_model_update` 而非 ACP `SessionUpdate` 变体——`SessionUpdate` 是 external `@agentclientprotocol/sdk` union 不能扩 vendor 字段)
  - ✅ **chiga0 第 5 PR — voterClientId on permission_resolved (side-channel A4)** [PR#4539](https://github.com/QwenLM/qwen-code/pull/4539) `feat(daemon): add voterClientId to permission_resolved (A4)` **MERGED 2026-05-26 09:54 to `daemon_mode_b_main`** (chiga0, +128/-4 5 files; **实现 #4511 side-channel coordination design A4 项**——闭长存的 originator/voter 语义不一致：`permission_resolved.originatorClientId` 一直载 voter，而 `permission_request.originatorClientId` 载 prompt originator；mediator 现在 emit `data.voterClientId` 与 envelope 对齐——完全 additive 不动旧 wire 字段，consumer 可不再 special-case 两事件)
  - ✅ **F2 cleanup PR B — self-heal observability** [PR#4460](https://github.com/QwenLM/qwen-code/pull/4460) `fix(core): F2 cleanup PR B — self-heal observability (W133-a + W134)` **MERGED 2026-05-23 15:23 to `daemon_mode_b_main`** (doudouOUC, +405/-5 3 files; F2 #4336 post-merge cleanup bucket 第 B 弹，#4175 item 7；**2 reviewer-filed observability gap 接受**: ① W133-a `McpClient.onerror` 的 upstream error (EPIPE / OAuth 401 / server-crash) 现 thread to silent-drop `'failed'` event 的 `lastError` string，operator triage 'failed' event 能看到真实 error 不是空字串；② W134 — [details from body not captured]; 1 项 (W93) source-verified 非 repro skip)
  - ✅ **F2 cleanup PR A** [PR#4411](https://github.com/QwenLM/qwen-code/pull/4411) `perf(core): F2 cleanup PR A — R9/W11/W12/R10 (post-merge follow-ups)` **MERGED 2026-05-23 to `daemon_mode_b_main`** (doudouOUC, +823/-594 8 files, merge `c6deb58f1`; F2 #4336 post-merge cleanup bucket，**4 pure-refactor 无行为变化**: R9 `McpClientManager` constructor 7 位置参 → `(config, toolRegistry, options?)` + `mkManager(...)` test factory (-104 LOC test) / W11 `mcp-transport-pool.ts:acquire()` 抽 `attachPooledSession` + `rollbackReservationOnSpawnFailure` 私有 helper / W12 `session-mcp-view.ts` 预算 filter `Set` 让 per-tool O(1) / R10 `pid-descendants.ts` 单 `ps -A` snapshot + 内存树遍历替 per-pid `pgrep -P` BFS，BusyBox `ps` <1.28 + distroless container 保留 per-pid fallback)
  - ✅ Follow-up [PR#4321](https://github.com/QwenLM/qwen-code/pull/4321) telemetry Phase 2 — `tool.blocked_on_user` + hook spans **MERGED 2026-05-21 03:55 to `main`** (doudouOUC, 创建 2026-05-19 09:54 历时 ~42h, 最终 +3287/-99; #3731 Phase 2 built on #4126 + #4302; **结构性改 core**: tool span lifecycle 从 `executeSingleToolCall` 移到 `_schedule` validating-loop; 与 claude-code findLast-by-type 分歧; **不在 daemon Wave plan**)
  - 🔧 Follow-up [PR#4333](https://github.com/QwenLM/qwen-code/pull/4333) `atomic write rollout` **OPEN REVIEW_REQUIRED** 2026-05-19 16:16 (doudouOUC, +643/-145 31 files; **#4095 Phase 2** + closes **#3681** JSONL durability; OAuth 凭证 / memory / config / JSONL / logger / LSP 全用 `atomicWriteFile` 替换 bare write; **5 release-note 候选**: 0o644 → 0o600 forced / jsonl flush:true +几 ms / withTimeout 去除修 silent token race / LSP W_OK check; 3 Codex round 抓真 bug; **不在 daemon Wave plan**; daemon `httpAcpBridge.ts:1274` hand-rolled atomic write 留 follow-up)
  - ✅ Follow-up [PR#4367](https://github.com/QwenLM/qwen-code/pull/4367) telemetry resource attributes + metric cardinality controls **MERGED 2026-05-21 05:54 to `main`** (doudouOUC, 创建 2026-05-20 19:02 历时 ~11h, 最终 +1897/-60 13 files; closes #4365, **#3731 P3 line**; ① custom resource attributes — `OTEL_RESOURCE_ATTRIBUTES` / `OTEL_SERVICE_NAME` env var 现生效 + 新 `telemetry.resourceAttributes` setting ② metric cardinality — `session.id` 移出 OTel Resource 防 Prometheus/ARMS unbounded time-series fan-out，gated 在 opt-in `telemetry.metrics.includeSessionId` toggle 后; reserved key `service.version`/`session.id` strip + `diag.warn`; **⚠️ breaking change**: metrics 默认不再带 `session.id`，恢复需 `QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID=true`; 130 new tests; **不在 daemon Wave plan**)
  - ✅ [PR#4271](https://github.com/QwenLM/qwen-code/pull/4271) Wave 3 PR 14b MCP guardrail push events + hysteresis **MERGED 2026-05-18 17:06** (doudouOUC, 9h50m, 33 reviews; 最终 +3329/-266 review 期间 +1505 LOC; **临门同 PR#4255 widened literal type 问题再来**——`slow_client_warning` fixture 用 `satisfies DaemonEvent` 修; PR 14 snapshot 字段保持不变 v1→v2 干净 layer 验证)
  - ✅ [PR#4250](https://github.com/QwenLM/qwen-code/pull/4250) Wave 4 PR 18 FileSystemService boundary **MERGED 2026-05-18 05:14** (doudouOUC, 13h55m daemon 项目最长 lifetime; 10 rounds 70 review threads 全 resolved; TOCTOU + UTF-8 off-by-one + writeText guard + 13+ Critical 全修)
  - ✅ [PR#4255](https://github.com/QwenLM/qwen-code/pull/4255) Wave 4 PR 21 OAuth device-flow route **MERGED 2026-05-18 14:05** (doudouOUC, **20h39m daemon 项目史上最长 lifetime** 破 PR#4249 15h20m；**135 reviews 史上最多**；最终 **+6172/-51 daemon 项目史上最大** 破 PR#4249 +5318；OAuth 2.0 RFC 8628 brokered through daemon；4 route + 5 typed event + build-time grep 防 browser-spawn regression + BrandedSecret 4-way redaction + 3 pre-PR agent / 12 P0+P1 fold-in；临门一脚被 1 个 TS 类型 inference 卡住 12:51 → 13:01 doudouOUC 修 → 13:59 gpt-5.5 /review LGTM → 14:05 MERGED)
  - ✅ PR 3 follow-up [PR#4225](https://github.com/QwenLM/qwen-code/pull/4225) DaemonSessionClient hardening **MERGED 2026-05-17 07:05** (chiga0, 多模型 /review 4 轮；chiga0 让步把 eager guard 改回 lazy + cursor monotonicity + abort propagation + event.id validation)
  - ⚠️ [PR#4226](https://github.com/QwenLM/qwen-code/pull/4226) typed event schema 竞品 OPEN (doudouOUC) — 与 PR#4217 重叠，待 close 或拆 reducer 作 Wave 5 PR 25 提前
  - ✅ Bonus Stage 0 spike 全 MERGED 2026-05-18: [PR#4203](https://github.com/QwenLM/qwen-code/pull/4203) channel (02:21) + [PR#4199](https://github.com/QwenLM/qwen-code/pull/4199) IDE (02:38) + [PR#4202](https://github.com/QwenLM/qwen-code/pull/4202) TUI (03:22) (chiga0; Wave 5 PR 26 提前)
  - ⚠️ Bonus Stage 1 wire-up 调整: [PR#4260](https://github.com/QwenLM/qwen-code/pull/4260) TUI + [PR#4263](https://github.com/QwenLM/qwen-code/pull/4263) IDE **CLOSED 06:59** (Stage 2 直接覆盖); [PR#4261](https://github.com/QwenLM/qwen-code/pull/4261) channel `--daemon-url` 仍 draft (channel 无 Stage 2)
  - 🔧 Bonus Stage 2 experimental flag-gated 2 PR draft: [PR#4266](https://github.com/QwenLM/qwen-code/pull/4266) `--experimental-daemon-tui` / [PR#4267](https://github.com/QwenLM/qwen-code/pull/4267) `qwen-code.experimentalDaemonIde` (chiga0, 2026-05-18 05:06 起; channel stage 2 待开)
- ✅ [PR#4132](https://github.com/QwenLM/qwen-code/pull/4132) `/demo` debug page (jifeng) **MERGED 2026-05-18 08:31** —— 4 天 24 reviews 终于合，daemon 项目 OPEN 最长 PR；XSS 修 (daemon-emitted poisoned events 威胁模型) + rebase 过 #4247/4250/4251 冲突
- 🧭 [PR#3929](https://github.com/QwenLM/qwen-code/pull/3929) / [#3930](https://github.com/QwenLM/qwen-code/pull/3930) / [#3931](https://github.com/QwenLM/qwen-code/pull/3931) remote-control stack 仍 OPEN draft / changes requested；**优先级后置**，等 TUI / channels / web / IDE 先完成 Mode B client 适配后，再重定向为 daemon HTTP/SSE facade
- ⏳ Stage 1.5 剩余主线：P0 production must-haves + daemon-side state CRUD，P1 typed event contract / bridge primitives + client adapters behind flag，P2 remote-control / Mode A revisit（详 [§06 Roadmap](./06-roadmap.md)）

## 二、7 章总览

| # | 文档 | 核心内容 |
|---|---|---|
| **01** | [Overview](./01-overview.md) | TL;DR + 2 层术语 + 架构图 + Mode B 主线 + 资源经济性 + Stage 进展 + 阅读指南 |
| **02** | [Architectural Decisions](./02-architectural-decisions.md) | 8 决策：session 共享 P1/P2 / 1 daemon = 1 workspace × N session / MCP 生命周期 / FileReadCache / Permission flow / 多 client 并发 / Mode B mainline / server-client-runtime boundary |
| **03** | [HTTP API & Protocol](./03-http-api.md) | Route table（`/workspace/*` 单 workspace 路由）+ ACP wire 4 层兼容性矩阵 + SSE + Last-Event-ID + 双向 RPC 异步化 + Capability negotiation |
| **04** | [Deployment & Client](./04-deployment-and-client.md) | Mode B client convergence + deployment shape matrix + TUI / channels / web / IDE 适配边界 + daemon-native renderer + remote-control overlay |
| **05** | [Security & Permission](./05-permission-auth.md) | Bearer + Host allowlist + 0.0.0.0 拒绝 / PR#3723 4-mode evaluatePermissionFlow / first-responder vote + per-session 隔离 / Multi-tenant = 1 daemon 1 tenant OS 进程级隔离 |
| **06** | [Roadmap & Ecosystem](./06-roadmap.md) | Timeline + Stage 1 audit + Stage 1.5 + chiga0 10 must-haves + 6 architecture findings + Stage 2 + External Reference Architecture + vs OpenCode + vs Anthropic |
| **07** | [User Guide](./07-user-guide.md) | **用户使用文档（recipe-oriented）**：`qwen serve` 启动 flag 表 + 安全启动配方 + 3 种 deployment shape + 客户端接入（SDK / curl / `/demo`）+ 常用操作 recipes + 配置 & 持久化路径 + 诊断 & 故障排查（`errorKind` 7 值速查）+ 生产部署（systemd / Docker / K8s）+ v0.16.0 实际可用 vs 集成分支预览 + capability tag 速查 |

## 三、阅读路径

| 路径 | 时间 | 顺序 | 适合 |
|---|---|---|---|
| 🎬 **快速上手用 daemon** | ~10 min | §07 §一 + §二 + §五 recipes | 第一次配 daemon / 立刻跑起来 |
| 🚀 **快速理解架构** | ~20 min | §01 → §02 → §06 §〇/§一/§六 | 评估方案是否值得做 |
| 🔧 **MVP 实施** | ~1 h | §01 → §02 → §03 → §04 → §05 → §06 | 准备开 PR 写代码 |
| 📖 **完整设计** | ~2 h | §01 → §06 顺序 6 章读完 | 全面理解 |
| 🛠️ **生产部署** | ~40 min | §07 §三 + §六 + §七 + §八 | systemd / Docker / K8s 上线 |
| 🔒 **安全 / 多租户** | ~40 min | §05 → §06 §五 + §07 §二·二（bearer 基础）+ §二·三（安全启动配方）+ §八·五 | 企业部署评估 |
| 🌐 **远端 / 多 client** | ~30 min | §04 §三/§四 + §06 §四 + §07 §三 Shape 2 | 客户端体验设计 |
| 🩺 **故障排查** | 即查即用 | §07 §七（含 errorKind 7-值速查 + decision tree） | 已部署遇到问题 |

## 四、核心架构

### 2 层术语模型

| 层 | 数量 | 边界 | 资源 |
|---|---|---|---|
| **Daemon process** | 1（per workspace）| OS 进程 = 启动时 cwd 绑定 = 1 workspace | Express server / Bearer auth / EventBus / 内嵌单个 `qwen --acp` child |
| **Session** | N（per daemon）| `QwenAgent.sessions: Map<sessionId, Session>` 多路复用 | per-session transcript / pending tool calls / cancellation token / FileReadCache（session-private）|

详 [§02 §〇 术语](./02-architectural-decisions.md)。

### 8 个关键设计决策

| 决策 | 选择 |
|---|---|
| Session 共享语义 | 默认 P1（多 client 同 session live collaboration）+ P2（N 独立 session per daemon） |
| **状态进程模型** | **1 daemon = 1 workspace × N session multiplexed** |
| MCP 生命周期 | **当前 per-session**（`Config` / `ToolRegistry` / `McpClientManager` 随 ACP session 创建；跨 session MCP 共享需未来 pool/proxy）|
| FileReadCache | session-private（PR#3717 已实现）|
| Permission flow | 复用 PR#3723 + daemon 作为第 4 种 mode |
| 多 client 并发 | FIFO prompt 串行 + fan-out 事件 + first-responder permission vote |
| Mode A vs Mode B | **Mode B 主线**；Mode A hold，待 Mode B event/control/client contract 稳定后再评估 |
| Server/client/runtime boundary | server control plane / daemon client-protocol / adapters / runtime worker 分层；daemon-native renderer 为目标；remote-control 是 control overlay |

详 [§02](./02-architectural-decisions.md)。

### Stage 进展（at 2026-05-15）

**合入原则**：Stage 拆分必须逐步迁移。每个 PR 都要可单独合入、向后兼容、默认不破坏现有 TUI / channels / IDE / CLI 行为；新 daemon 能力通过 capability tag 暴露，client adapter 先 behind flag / 双栈测试，再单独 PR 切默认。

| Stage | 状态 | 范围 |
|---|:---:|---|
| **Stage 1 — Mode B base** | ✅ MERGED | [PR#3889](https://github.com/QwenLM/qwen-code/pull/3889)（2026-05-13）：HTTP + SSE + EventBus + prompt/cancel/model/permission 基础链路 |
| **Stage 1.5a §02** | ✅ MERGED | [PR#4113](https://github.com/QwenLM/qwen-code/pull/4113)（2026-05-15）1 daemon = 1 workspace |
| **Stage 1.5a must-haves** | ⏳ **P0** | chiga0 10 must-haves 剩 9 项 — Mode B 生产 blocker（~2 周，9 PRs 可并行）|
| **Stage 1.5c** | ⏳ **P0** | daemon-side state CRUD 8 routes — Mode B 远端 client 摆脱 thin shell（~3-5d）|
| Stage 1.5-prereq | ⏳ **P1** | chiga0 6 architecture findings — `AcpChannel` / `EventBus` / `PermissionMediator` lift（~1-2 周）|
| Stage 1.5-client adapters | 🔧 **P1 behind flag** | TUI / channels / web/debug / IDE 作为 daemon HTTP/SSE clients 试点；默认切换必须等 P0/P1 |
| **Stage 1.5b** Mode A | ⏳ **P2 推迟** | Mode A `qwen --serve` flag — [Issue #4156](https://github.com/QwenLM/qwen-code/issues/4156)；A1 [PR#4160](https://github.com/QwenLM/qwen-code/pull/4160) ✅；剩余推迟到 1.5c 后 |
| Stage 1.5-remote-control | ⏳ **P2 后置** | [#3929](https://github.com/QwenLM/qwen-code/pull/3929)/[#3930](https://github.com/QwenLM/qwen-code/pull/3930)/[#3931](https://github.com/QwenLM/qwen-code/pull/3931) 后续作为 daemon facade |
| Stage 2a-2d | ⏳ 待开 | 协议补齐（WebSocket / mDNS / OpenAPI / Prometheus / `/ext` + Reverse RPC）|
| Stage 2e | 可选 | native in-process（去 `qwen --acp` child）|

详 [§06](./06-roadmap.md)。

## 五、依赖的已合并 PR

| PR | 内容 | 对 daemon 的意义 |
|---|---|---|
| **PR#3717** ✅ | FileReadCache（session-scoped + `(dev,ino)` key）| daemon 模式下天然兼容 |
| **PR#3723** ✅ | 共享 L3→L4 permission flow | daemon 是第 4 种 ExecutionMode |
| **PR#3739** ✅ | Background agent resume + transcript-first fork resume | daemon 重启 / failover 后 session 可恢复（缺 HTTP 暴露：Stage 1.5 must-have #2）|
| **PR#3810** ✅ | FileReadCache invalidation 5 路径修复 | 长 session 正确性保障 |
| **PR#3889** ✅ | qwen serve daemon Stage 1 | 本系列设计基础 |
| **PR#4113** ✅ | 1 daemon = 1 workspace 收紧 | 移除 multi-workspace 路由，回归 ACP stdio 心智 |
| **[PR#4160](https://github.com/QwenLM/qwen-code/pull/4160)** ✅ | extract `createInMemoryChannel` helper（原 [Issue #4156](https://github.com/QwenLM/qwen-code/issues/4156) A1）| Mode A hold 后仍可作为 future in-process/native bridge primitive |

## 五-A、相关在途 PR / Issue（Mode B 视角）

| PR / Issue | 当前状态（2026-05-15）| Mode B roadmap 处理 |
|---|---|---|
| [Issue #3803](https://github.com/QwenLM/qwen-code/issues/3803) | OPEN | daemon proposal / Stage 1.5 tracker；最新 comment 将 P0/P1/P2 重排为 Mode B must-haves + state CRUD 优先，Mode A 后置 |
| [Issue #4156](https://github.com/QwenLM/qwen-code/issues/4156) | OPEN | Mode A 设计 issue，但最新结论是 **Mode A hold，核心推进 Mode B** |
| [PR#4132](https://github.com/QwenLM/qwen-code/pull/4132) | OPEN / changes requested | `/demo` debug page 可继续作为 Mode B POST+SSE client 验证面 |
| [PR#3929](https://github.com/QwenLM/qwen-code/pull/3929) | OPEN draft | remote-control foundation 后置；应等 TUI / channels / web / IDE 适配完成后改为 daemon HTTP/SSE client facade |
| [PR#3930](https://github.com/QwenLM/qwen-code/pull/3930) | OPEN draft / changes requested | worker/WebSocket 层若保留，应成为 daemon transport facade，而不是替代 HTTP/SSE + EventBus-backed event contract |
| [PR#3931](https://github.com/QwenLM/qwen-code/pull/3931) | OPEN draft / changes requested | remote-control TUI attach 后置；TUI 自身的 Mode B client adapter 更优先 |

## 六、决策与文档对应

| 上游决策点（[SDK/ACP/Daemon Deep-Dive §七](../sdk-acp-daemon-architecture-deep-dive.md#七qwen-code-引入-daemon-的工作量评估)）| 本系列章节 |
|---|---|
| Session 共享语义 | §02 §1 |
| 状态进程模型 | §02 §2 |
| MCP server 生命周期 | §02 §3 |
| FileReadCache 共享 | §02 §4 |
| Permission flow | §02 §5 + §05 |
| 多 client 并发请求 | §02 §6 + §04 §三 |
| 持久化（External Reference）| §06 §五 |
| 远端 CLI / 协作 | §04 §三/§四 |

---

> **免责声明**：本系列是 codeagents 项目的设计提案，不代表 Qwen Code 团队官方路线图。所有"工作量估算"是基于源码可见复用度的推测，实际开发可能因团队优先级、API 稳定性要求等变化。
