# Qwen Code Daemon 架构设计（系列文档）

> Qwen Code 引入 HTTP daemon 模式的完整设计方案。基于 [SDK / ACP / Daemon 架构 Deep-Dive](../sdk-acp-daemon-architecture-deep-dive.md) 第七章"Qwen Code 引入 daemon 的工作量评估"展开为可执行的工程蓝图。

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
  - 🔧 **daemon 团队第 3 作者 ytahdn — 第一个 web client 消费者** [PR#4380](https://github.com/QwenLM/qwen-code/pull/4380) `Feat/daemon react cli` **OPEN CHANGES_REQUESTED** 2026-05-21 06:07 (ytahdn daemon 团队第 3 作者继 doudouOUC + chiga0, +12274/-25 **107 files**, target `daemon_mode_b_main`, 41 commits / 31 reviews); **新 `packages/web-shell` daemon-backed React web-shell**——把 chiga0 SDK daemon UI 层 (#4328/#4353) 真落地成可用 web client，接 daemon session + SSE + permission + slash command completion + model/approval 切换 + session resume + memory/MCP/skills/agents view + `/session/:id` URL restore；对齐 CLI/ACP 行为 (`/model --fast` / `/rename --auto` / `/new` / `/reset`)；**第一个真实 web client 验证 chiga0 SDK 设计**；wenshao 2026-05-24 incremental review (161 files +24K/-4K across 22 new commits, 9 parallel review agents) **no new high-confidence Critical** —— 方向健康但旧 thread 未消；风险: `/session/:id` SPA route 与 daemon API `/session` 重叠靠 Vite proxy 显式 bypass HTML navigation
  - 🔧 **chiga0 第 4 PR — cross-client real-time sync 5 fixes** [PR#4484](https://github.com/QwenLM/qwen-code/pull/4484) `feat(acp-bridge): cross-client real-time sync completeness (5 fixes)` **OPEN REVIEW_REQUIRED** 2026-05-24 16:39 (chiga0, +195/-18 3 files); cross-client sync audit 发现 8 gap, 本 PR 修 5 个机械性 bridge-layer 的: ① `user_message_chunk` echo on interactive prompt path (之前 client B 看不到 client A 发的 prompt 直到 reload) ② `prompt_cancelled` broadcast on cancelSession (之前只 forward ACP, 不发 bus event) ③ `replay_complete` sentinel on Last-Event-ID 重连成功路径 (与失败路径 `state_resync_required` 对偶) ④ `originatorClientId` on `session_metadata_updated` envelope ⑤ `originatorClientId` on `session_closed` envelope (之前只有 `data.closedBy`); 仍 deferred 3 项需 design 讨论 (in-session setModel bus emit / approval-mode persist 与 broadcast 关系 / `permission_resolved.originatorClientId` voter-vs-originator 语义不一致); **部署协调**: 下游 gateway 自有 user-echo workaround 与 daemon-side echo 会双重帧, 建议先部署 daemon 再 flip `GATEWAY_ECHO_USER_MESSAGE=false`; `_meta.source: 'bridge-echo'` vs `'gateway-echo'` 让 SDK dedup 兜底; 291/291 vitest pass
  - 🔧 **chiga0 第 3 PR — ACP HTTP transport 接入 ACP 生态** [PR#4472](https://github.com/QwenLM/qwen-code/pull/4472) `feat(daemon): ACP Streamable HTTP transport at /acp [RFD #721]` **OPEN CHANGES_REQUESTED**（DRAFT 已转正）05-24 01:14 创建，05-25 14:04 最新更新 (chiga0, **+3475/-0 11 files**, 11 commits / 18 reviews, target `daemon_mode_b_main`); **在 `qwen serve` 加 official ACP Streamable HTTP transport ([RFD #721](https://github.com/agentclientprotocol/agent-client-protocol/pull/721)) 作第二 northbound transport** —— 挂载 `/acp` 单端点，与现有 REST+SSE API **共存**共享 `HttpAcpBridge`+`EventBus`；**让 Zed / Goose / future ACP-native SDK 可直接驱动 daemon**；3 关键决策：dual-transport additive / `_qwen/...` extension namespace / WebSocket+HTTP2 等 deferred；**R1-R9 9 轮 review** 修 wire-level concurrency 经典坑（reconnect / ownership / leaks / write-failure / permission-vote release / concurrent-prompt abort / zombies / close TOCTOU / pump lifecycle / reconnect prompt survival）；**新加 `f101aca1b3` REST parity batch + official extension scheme** —— 跟进 RFD #721 spec 演进，把 daemon REST endpoints (`/session/*` / `/workspace/*`) 同样通过 `/acp` extension namespace 暴露完成 dual-transport 对偶；最新 commit `ef59636022` 把 follow-up roadmap 入 docs；**为什么提供这个能力的 5 层 rationale**（战略 ACP-as-LSP / 客户 vendor lock-in 成本 / 竞争 open-vs-closed 差异化 / 架构 dual-transport additive 控风险 / 时机 Draft spec 早期 mover）文档化到 [§02 决策 9](./02-architectural-decisions.md#9-dual-northbound-transport--restsse--acp-http2026-05-24)
  - 🔧 **#4514 capacity backlog T2.9 — prompt absolute deadline + SSE writer idle timeout 双 opt-in flag** [PR#4530](https://github.com/QwenLM/qwen-code/pull/4530) `feat(serve): prompt absolute deadline + SSE writer idle timeout (#4514 T2.9)` **OPEN REVIEW_REQUIRED** 2026-05-26 02:41 (doudouOUC, +1348/-31 14 files, 6 commits, target `main` —— **不走 `daemon_mode_b_main`，直接进 main**); **关 [#4514](https://github.com/QwenLM/qwen-code/issues/4514) Tier-2 ⭐⭐ S-sized**——15s heartbeat + AbortSignal local 足够，remote / long-running deployment 需要 explicit app-layer deadline；v0.16-alpha known-limit。两个 opt-in flag 默认 off → single-user loopback 行为 bit-for-bit 不变：① **`--prompt-deadline-ms <n>`** (env `QWEN_SERVE_PROMPT_DEADLINE_MS`) —— server-side wallclock cap on `POST /session/:id/prompt`；expiry 时 daemon abort AbortController + 返 504 with `errorKind: 'prompt_deadline_exceeded'`；per-prompt body `deadlineMs` **可 SHORTEN below cap 但不能 EXTEND**（operator 是 upper bound）；**关 `httpAcpBridge.ts` 长存的 `FIXME(stage-2)` 注释——buggy agent 忽略 AbortSignal 时握住 FIFO 不放问题** ② **`--writer-idle-timeout-ms <n>`** (env `QWEN_SERVE_WRITER_IDLE_TIMEOUT_MS`) —— per-SSE-connection idle deadline；当 `n` ms 内无 write flush 成功（不论是 heartbeat 还是真事件），daemon emit terminal `client_evicted` 帧 with `reason: 'writer_idle_timeout'` 并 close；**关 SSE handler 的 "Stage 2 may add" gap**。**Conditional capability tags** `prompt_absolute_deadline` / `writer_idle_timeout` 仅在 flag set 时 advertise，SDK consumer 可 pre-flight 再发 `deadlineMs`（老 daemon 静默 drop 匹配 v=1 additive rule）。**SERVE_ERROR_KINDS / DAEMON_ERROR_KINDS 两端 mirror +2 个**（之前 9 / 8 → 现 11 / 10），关 taxonomy drift。**6 commits 迭代**：① 初版 +13 tests ② simplify pass `trackWriterIdle` boolean 防 chatty stream 每 write stamp timestamp / `isPositiveIntegerMs` predicate / `abortableBridgePromptImpl()` helper ③ **Copilot review race-guarantee fix** —— 原 `await bridge.sendPrompt(...) after abort.abort()` 不能 guarantee deadline（buggy agent 忽略 abort 时 504 永不 fire 反而 defeats T2.9 整个目的）；改 `Promise.race(bridge.sendPrompt, deadlinePromise)` 让 deadline timer 独立 reject race，orphaned bridge promise tail `.catch(() => undefined)` 防 unhandledRejection；同时修文档错误—— `<15s` 不是 no-op（idle timer 独立检查 elapsed-since-last-flush，无事件时 10s 设置会在第一个 15s heartbeat refresh 前 evict 健康连接）④ cosmetic + 准确性 ⑤ **wenshao review fold-in 3 of 6 [Suggestion]**: `sendDeadlineResponseIfFired` stderr breadcrumb 含 sessionId 让 operator `grep "prompt deadline fired"` triage / `parseDeadlineEnv` 不再静默对 whitespace-only env / **`MAX_TIMER_DELAY_MS = 2_147_483_647`** (2^31-1 ms ~24.8 天) 上限校验防 Node `setTimeout` overflow（>2^31-1 silently compressed to 1ms + TimeoutOverflowWarning，operator 设 30 天 cap 会立即 504 every prompt）+ 25 new tests（6 malformed env / it.each boot validation / catch-path bare AbortError / `deadlineMs` body 全 branch / active SSE writes refresh `lastWriteAt`）⑥ DRY pass: `runBudget.ts` 的 `MAX_TIMEOUT_MS` constant export 共享（之前 module-private）+ `emitPromptDeadline504(res, err, sessionId)` 抽 helper 让 deadline-race catch path 与 `sendDeadlineResponseIfFired` defense-in-depth path 共用；269/269 tests passing；docs `docs/users/qwen-serve.md` 加 2 flag + 更新 "phantom SSE connections" known-gap callout；与 PR#4516 不同 target —— 这条 T2.9 是 main 直接进，不走 `daemon_mode_b_main` integration branch
  - 🔧 **#4514 capacity backlog T1.3 + T1.4 — manual compaction + per-session metadata 双 S-sized 路由打包** [PR#4516](https://github.com/QwenLM/qwen-code/pull/4516) `feat(serve): POST /session/:id/compress + POST /session/:id/_meta (T1.3 + T1.4 from #4514)` **OPEN REVIEW_REQUIRED** 2026-05-25 17:58 (doudouOUC, +2320/-6 22 files, 1 commit `a26d6888`, target `daemon_mode_b_main`); **关 [#4514](https://github.com/QwenLM/qwen-code/issues/4514) daemon capability backlog Tier-1 唯二两条仍 No PR 的 ⭐⭐⭐⭐ S-sized gap**——按推荐 "if we can only pull 3 things next" 第 1 项打包推；template 跟 Wave 4 PR 17 (`POST /session/:id/approval-mode`) 同形；bundle 一起因为都是 S 大小 session-mutation 路由共用 mutation-gate plumbing（status / bridgeTypes / bridge / server / capabilities / events / SDK / barrels / tests / docs）。**T1.3 `POST /session/:id/compress`** 等价 TUI `/compress` 走 HTTP——经新 `qwen/control/session/compress` ACP extMethod 进 agent `GeminiClient.tryCompressChat(force=true)`（server 端总 `force=true` 匹配 TUI，body 不收 `force`），返 `{sessionId, originalTokenCount, newTokenCount, compressionStatus, durationMs}`，`compressionStatus` 是 core `CompressionStatus` enum 字符串名（`'COMPRESSED'` / `'NOOP'` / `'COMPRESSION_FAILED_*'`）；**SSE `session_compacted` 仅在 `compressionStatus !== 'NOOP'` 时发** —— NOOP=below-threshold history 未动，若发会假涨 reducer 的 `sessionCompactedCount`；**两层 concurrency guard**: `CompactionInFlightError` → 409 `compaction_in_flight`（已有 compress 在 LLM 调用中）/ `PromptInFlightError` → 409 `prompt_in_flight`（`entry.activePromptOriginatorClientId` 已 set，防 daemon 调和 agent `sendMessageStream` 内置 pre-send `tryCompress` race 同一 chat 对象）；non-strict mutation gate 与 `/prompt` parity；180s timeout (`SESSION_COMPRESS_TIMEOUT_MS`)；AbortSignal propagation **deferred** v1 用 placeholder signal（operator 等或 `killSession`）。**T1.4 `POST/GET /session/:id/_meta`** 是 daemon 端 per-session KV 包 for IM / channel adapter（chat_id / sender_id / thread_id）—— **纯 daemon 端无 ACP roundtrip**，`SessionEntry` 上 in-memory map，close/kill 时随 `byId.delete(sessionId)` 自动驱逐；**v1 不注入 LLM prompt**，通过 GET 取 + `GET /session/:id/context` 的 `state.meta`（capability tag 发后 always present 即便 `{}`，避免 old-daemon-vs-empty-bag 歧义）+ 每次写发 `session_meta_changed` SSE 事件三个表面暴露；**事件载 FULL new bag 不是 diff** —— 不管 Last-Event-ID gap subscribers 总收敛；validation: key regex `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$` (400 `invalid_meta_key`) / reserved `qwen.` 前缀 (400 `reserved_meta_key`) / serialized 8 KB 上限 (413 `meta_too_large`) / `merge:true` 下 `null` value 设 key 为 null（JSON 语义，per-key DELETE deferred）；**daemon restart 不持久** v1，load/resume 恢复 session `meta: {}` 起手。**wire surface**: +2 cap tag `session_compress`/`session_meta` / +1 ACP extMethod `qwen/control/session/compress` / +2 SSE event type / +6 SDK type 出 export / +3 `DaemonClient` 方法 (`compressSession`/`setSessionMeta`/`getSessionMeta`) + 3 `DaemonSessionClient` wrapper (`compress`/`setMeta`/`getMeta`)；测试 706 通过（198 acp-bridge + 270 server + 238 SDK，含 44 new）；**6 parked follow-up**: auto-inject `_meta` 入 prompt context (等 pilot) / `_meta` daemon restart 持久 (随 T2.1 graduate `unstable_session_resume`) / per-key `DELETE /_meta/:key` / compress AbortSignal propagation / 硬 prompt-side serialization vs in-flight compress / `_meta` ETag optimistic concurrency
  - ✅ **F2 cleanup PR A** [PR#4411](https://github.com/QwenLM/qwen-code/pull/4411) `perf(core): F2 cleanup PR A — R9/W11/W12/R10 (post-merge follow-ups)` **MERGED 2026-05-23 to `daemon_mode_b_main`** (doudouOUC, +823/-594 8 files, merge `c6deb58f1`; F2 #4336 post-merge cleanup bucket，**4 pure-refactor 无行为变化**: R9 `McpClientManager` constructor 7 位置参 → `(config, toolRegistry, options?)` + `mkManager(...)` test factory (-104 LOC test) / W11 `mcp-transport-pool.ts:acquire()` 抽 `attachPooledSession` + `rollbackReservationOnSpawnFailure` 私有 helper / W12 `session-mcp-view.ts` 预算 filter `Set` 让 per-tool O(1) / R10 `pid-descendants.ts` 单 `ps -A` snapshot + 内存树遍历替 per-pid `pgrep -P` BFS，BusyBox `ps` <1.28 + distroless container 保留 per-pid fallback)
  - 🔧 Follow-up [PR#4321](https://github.com/QwenLM/qwen-code/pull/4321) telemetry Phase 2 — `tool.blocked_on_user` + hook spans **OPEN CHANGES_REQUESTED** 2026-05-19 09:54 (doudouOUC, +1431/-51 6 files; #3731 Phase 2 built on #4126 + #4302; **结构性改 core**: tool span lifecycle 从 `executeSingleToolCall` 移到 `_schedule` validating-loop; 与 claude-code findLast-by-type 分歧; 187/187 tests; **不在 daemon Wave plan**)
  - 🔧 Follow-up [PR#4333](https://github.com/QwenLM/qwen-code/pull/4333) `atomic write rollout` **OPEN REVIEW_REQUIRED** 2026-05-19 16:16 (doudouOUC, +643/-145 31 files; **#4095 Phase 2** + closes **#3681** JSONL durability; OAuth 凭证 / memory / config / JSONL / logger / LSP 全用 `atomicWriteFile` 替换 bare write; **5 release-note 候选**: 0o644 → 0o600 forced / jsonl flush:true +几 ms / withTimeout 去除修 silent token race / LSP W_OK check; 3 Codex round 抓真 bug; **不在 daemon Wave plan**; daemon `httpAcpBridge.ts:1274` hand-rolled atomic write 留 follow-up)
  - 🔧 Follow-up [PR#4367](https://github.com/QwenLM/qwen-code/pull/4367) telemetry resource attributes + metric cardinality controls **OPEN REVIEW_REQUIRED** 2026-05-20 19:02 (doudouOUC, +1597/-60 13 files; closes #4365, **#3731 P3 line**; ① custom resource attributes — `OTEL_RESOURCE_ATTRIBUTES` / `OTEL_SERVICE_NAME` env var 现生效 + 新 `telemetry.resourceAttributes` setting ② metric cardinality — `session.id` 移出 OTel Resource 防 Prometheus/ARMS unbounded time-series fan-out，gated 在 opt-in `telemetry.metrics.includeSessionId` toggle 后; reserved key `service.version`/`session.id` strip + `diag.warn`; **⚠️ breaking change**: metrics 默认不再带 `session.id`，恢复需 `QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID=true`; 130 new tests; **不在 daemon Wave plan**)
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
