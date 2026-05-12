# 13 — 单 Session vs 多 Session 设计优缺点深度对比

> [下一篇：Orchestrator 多租户与配额 →](./14-orchestrator-multi-tenancy.md) · [回到 README](./README.md)

> **架构演进时间线**（2026-05-12）：
> - **早期 PR#3889 Stage 1 设计**（`8d7c03a5f` 时期）：1 daemon + N children（1 per session）= "1 daemon = 1 session"。每 session N× 内存 / N× OAuth / N× FileReadCache。
> - **commit `f29353a2`（2026-05-12 上午）**：N:1 framing 修正——维护者反馈 + LaZzyMan review 指出 `packages/cli/src/acp-integration/acpAgent.ts:194` `QwenAgent.sessions: Map<string, Session>` 已原生支持单 child 多 session（`yiliang114` 的 VSCode 插件早已生产使用）。
> - **commit `6a170ef8`（2026-05-12 下午）**：Stage 1 bridge 重构——改为 **1 daemon + M children（1 per workspace）+ N sessions multiplexed per workspace via QwenAgent.sessions: Map**。N=5 同 workspace session 内存 300-500MB → **60-100MB**。
> - **跨 workspace 仍需独立 child**（`acpAgent.ts:601 loadSettings(cwd)` 跨 workspace 复用会污染）——Stage 2e native in-process 才能解决。
>
> 故本章 22 维对比的真实题目是 "**Stage 1 channel-per-workspace + N session multiplexed**"（PR#3889 当前实现）vs **OpenCode single-process N-session 跨 workspace 共享**" 两种模式。Stage 1 在同 workspace 内已经达到 OpenCode 同款 in-process N-session 经济性；跨 workspace 资源共享是 Stage 2e 才解决的可选演进，不在主线 scope。

## 一、TL;DR

**Stage 1 (commit `6a170ef8`) 已经在同 workspace 内达到 in-process N-session 经济性**——跨 workspace 仍走 OS 进程隔离。整体是 "**Hybrid**" 模型——同 workspace 内 N session 共享应用层 ACP `sessions: Map`，跨 workspace 走进程级隔离。

| 维度 | PR#3889 Stage 1（channel per workspace + N session multiplexed） | OpenCode 单进程 N-session 跨 workspace 共享 |
|---|---|---|
| **同 workspace N session 资源共享** | ✓（OAuth × 1 / FileReadCache × 1 / CLAUDE.md parse × 1 / MCP × 1 per server）| ✓（同款）|
| **跨 workspace 资源共享** | ✗（不同 child = 进程隔离）| ✓（Map<workspace, Instance> 共享）|
| **跨 workspace 隔离** | OS process 级（免费）| 应用层 ALS（Effect-TS LocalContext）|
| **同 workspace 隔离** | 应用层（ACP `sessions: Map` per-session）| 应用层 ALS |
| **Cold start（首 session）** | ~1-3s（spawn child）| ~10ms（同进程函数调用）|
| **Cold start（同 workspace 第 N session）** | **<200ms**（attach existing channel）| ~10ms |
| **内存（N=5 同 workspace session）** | **60-100MB**（1 child + 5 session）| ~75MB（50MB baseline + 5×5MB） |
| **内存（N=50 跨 workspace 50 daemon）** | ~3-5GB（50 child × ~60-100MB）| ~300MB |
| **Crash 半径** | 同 workspace channel 全部 N session（其他 workspace 独立）| 整 daemon |
| **Subagent isolation** | 同 workspace 内应用层；跨 workspace 进程级 | 应用层 5 PR 套路 |
| **大规模 SaaS（500+ session/机）** | 需 Stage 2e native in-process（去 child + 跨 ws 共享）| 原生支持 |
| **qwen-code 当前状态** | PR#3889 Stage 1 OPEN (commit `6a170ef8`)；同 workspace N session 已 in-process | 上游 OpenCode 已上线 |

**实务建议**：Stage 1 当前模型 **同 workspace 高密度场景已完美**（共享 OAuth/Cache/parse/LSP/MCP），跨 workspace 场景在 N < 200 同样可接受；只有 cross-workspace 高密度才需要 Stage 2e native in-process 重构。

## 二、22 维对比矩阵

> 表头"单 Session" = 原 PR#3889 Stage 1 early child-process-per-session 框架（已被 commit `6a170ef8` 重构淘汰）；"多 Session" = OpenCode single-process N-session / Qwen Stage 1 channel-per-workspace（commit `6a170ef8` 后）/ Qwen Stage 2e native in-process。**本表保留两侧对比是为了显示工程演进 tradeoff——实际 PR#3889 已经从左列演进到右列**。

| # | 维度 | 单 Session（Stage 1）| 多 Session（OpenCode / Stage 2）|
|---|---|---|---|
| 1 | **实现复杂度** | ✅ 低（不需要 ALS / Effect-TS / cross-session managers）| ❌ 高（Map<workspaceId, Instance> + 路由 + per-session resource managers）|
| 2 | **隔离强度** | ✅ **OS process 级**（V8 isolate + fd + memory）| ⚠️ 应用层（AsyncLocalStorage / LocalContext）|
| 3 | **Crash 半径** | ✅ 仅 affected session（1 个）| ❌ 整 daemon（所有 session）|
| 4 | **Cold start** | ❌ ~1-3s/session（V8 + module load）| ✅ ~10ms/session（同进程函数调用）|
| 5 | **内存 baseline** | ❌ ~30-50MB × N | ✅ ~50MB（共享）+ ~5MB/session |
| 6 | **LSP/MCP 跨 session 复用** | ❌ 不能（每 daemon 自己一份）| ✅ 同 workspace 多 session 共享 |
| 7 | **FileReadCache 命中率** | ⚠️ per-daemon（同 workspace 多 session 失去命中）| ✅ per-workspace 共享 |
| 8 | **OS 资源**（fd / 进程表项）| ❌ N daemon = N 倍 | ✅ 单 daemon |
| 9 | **Subagent isolation** | ✅ **自动成立**（process boundary）| ❌ 需要 5 PR 套路（Config wrapper / agent-local resources）|
| 10 | **Permission decision cache** | ✅ per-daemon 自然隔离 | ⚠️ 需加 sessionId 维度 |
| 11 | **Multi-tenant ACL** | ✅ orchestrator spawn 时绑 tenant，daemon 内不感知 | ❌ daemon 内 ACL middleware + 路径 traversal 防护 |
| 12 | **HPE 攻击面**（） | ✅ 17 个攻击向量 vanish 8 个 | ❌ 17 个全部需防御 |
| 13 | **Cross-session race condition** | ✅ 不存在 | ❌ 共享状态需要 lock / 原子操作 |
| 14 | **OOM 隔离** | ✅ 单 session 跑爆只杀自己 | ❌ 整 daemon OOM |
| 15 | **Long-run 稳定性**（） | ✅ 10 个泄漏点 vanish 5 个 | ❌ 全部需 TTL/quota/circuit breaker |
| 16 | **Cross-session 聚合 UI**（"我所有 task"）| ❌ 需 orchestrator 聚合 API | ✅ daemon 内一个 query |
| 17 | **同 session 多 client live collaboration** | ✅ 同 daemon EventBus fan-out | ✅ 同 daemon 内 fan-out |
| 18 | **持久化模型** | ✅ 每 daemon 自己 transcript JSONL | ⚠️ 跨 session 共享 SQLite（写入并发管理）|
| 19 | **HA / failover** | ✅ daemon-pool + orchestrator 重启单 daemon | ⚠️ pod-level sticky session 路由 + 大爆炸半径 |
| 20 | **调试** | ✅ 单 daemon 单 session，状态简单 | ❌ 多 session 共享调试器（Variable name conflict / state coupling）|
| 21 | **Scale 上限**（单机）| ❌ ~50-100 session（V8 启动 + 内存）| ✅ ~500-1000 session |
| 22 | **运维复杂度** | ⚠️ 需管理 N daemon 进程的生命周期 | ✅ 单 daemon 进程 |

## 三、关键 tradeoff 深度分析

### 3.1 隔离的"昂贵性"取舍

**单 session 模式把隔离交给 OS**——免费但代价是每 session 一份 V8 + module。  
**多 session 模式自己实现隔离**——便宜但代价是每个隔离点都是潜在 bug 源。

历史伤疤：Qwen 团队为单 session 内 subagent 隔离做的 5 PR 套路（PR#3735 / 3873 / 3887 / 3892 / 3707）—— 几个月反复发现 race / leak 才稳定（详见 [subagent-display-deep-dive §六.9](../subagent-display-deep-dive.md)）。这些 PR 不是"代码问题"，是"在共享内存模型下保证 subagent 资源不泄漏"的工程难题。

**判断**：如果团队有充足 Effect-TS / ALS 经验：多 session 可控。如果团队倾向"让 OS 帮忙"：单 session 是默认。

### 3.2 Cold start vs 进程数量的平方根问题

```
N 个 cold session 启动总成本：
  单 session: N × ~3s（每个独立 V8 + module load）
  多 session: ~3s（共摊一次启动）
```

但**真实场景中 session 大多是长连**——cold start 摊销到 session 整个生命周期占比小：

| 典型场景 | session 时长 | Cold start 占比 | 是否 bottleneck |
|---|---|---|---|
| 工程师交互式 coding | ~30 min | 0.1% | ❌ 忽略 |
| 长跑 background research | ~2 h | 0.04% | ❌ 忽略 |
| IDE 自动补全 | ~5s | 60% | ✅ Killer |
| IM bot 单 turn 回复 | ~10s | 30% | ✅ 显著 |
| CI per-PR session | ~10 min | 0.5% | ❌ 忽略 |

**结论**：Cold start 在 **稳定长 session 工作流下不是 bottleneck**，在 **高频短 session 工作流下是 killer**。

**缓解**：Stage 1 commit `6a170ef8` 已经把同 workspace 第 N session cold start 降到 <200ms（attach existing channel）；跨 workspace 仍 ~1-3s/session 可走 External SaaS warm pool（orchestrator 预热 N 个 idle daemon）。Stage 2e native in-process 后跨 workspace cold start 也降到 ~10ms（无 child spawn），是更彻底的修法。

### 3.3 内存 baseline 在多大 N 时变得致命

```
单 session 模式：N × 40MB
多 session 模式：50MB + N × 5MB
```

| N | 单 session | 多 session | 多省比例 |
|---|---|---|---|
| 1 | 40MB | 55MB | 单 session 反而省 |
| 10 | 400MB | 100MB | 75% |
| 50 | 2GB | 300MB | 85% |
| 100 | 4GB | 550MB | 86% |
| 500 | 20GB | 2.5GB | 87% |
| 1000 | 40GB | 5GB | 87.5% |

**关键 break-even**：
- N < 5 时**单 session 反而省**（启动 1 个 daemon 总开销 ~40MB ≤ 多 session daemon 50MB baseline）
- N = 10-50 时多 session 优势显现
- N ≥ 50 时多 session 优势**非常显著**——是大规模 SaaS 选多 session 的核心理由

**默认假设**：N < 50（个人 / 团队 / 中等 SaaS）—— 单 session 经济性可接受；触发条件出现后再投 External SaaS 资源池化路径。

### 3.4 隔离失败的代价对比

| 失败类型 | 单 Session | 多 Session |
|---|---|---|
| 单 session OOM | ✅ 杀自己 | ❌ 整 daemon OOM（其他 N-1 session 全死）|
| 单 session 跑死循环耗 CPU | ✅ 自己进程跑满 | ❌ 整 daemon event loop 卡住（其他 session block）|
| native module crash（segfault）| ✅ 自己进程死 | ❌ 整 daemon segfault |
| Promise 链丢失 await | ✅ 自己 daemon 报错 | ❌ 整 daemon top-level uncaughtException |
| LLM 流式响应卡住 | ✅ 自己 SSE 卡 | ⚠️ 多 session 都受影响（如果共享 stream coordinator）|
| Memory leak 累积 | ✅ daemon 退出释放 | ❌ daemon 24h+ 长跑累积成 OOM |
| File descriptor 泄漏 | ✅ daemon 退出释放 | ❌ 累积到系统 ulimit |
| Listener 累积（EventEmitter）| ✅ daemon 退出释放 | ❌ 长跑泄漏 |

**多 session 模式的"single point of failure"是它最大的运营负担**——所有 9 项稳定性模式（）都是为了缓解此问题：TTL / bounded / quota / circuit breaker / memory threshold restart / heap dump / liveness / native supervisor / worker isolation。

**单 session 模式天然规避**——9 项稳定性模式中至少 5 项变成 "kill daemon 即清理"，无需主动管理。

### 3.5 复杂度守恒原理

**复杂度不会消失，只会在不同位置出现**——这是设计选择的核心。

| 复杂度位置 | 单 Session | 多 Session |
|---|---|---|
| **Daemon 内部** | ✅ 几乎为 0（直接绑唯一 session）| ❌ ALS / Effect-TS / Map<...> / per-session managers |
| **Orchestrator 层** | ❌ daemon spawn / discovery / cleanup / cross-daemon aggregate API | ✅ 单 daemon 不需要 |
| **资源池化层**（External SaaS 资源池化路径）| ❌ 用户级 LSP daemon / 共享 MCP / 共享 cache | ✅ daemon 内自动共享 |
| **Long-run 稳定性** | ✅ daemon 退出即清理 | ❌ 9 项稳定性模式 + 22 项 Prometheus 指标 + Chaos test |
| **Multi-tenant 安全** | ✅ 进程级隔离 + orchestrator ACL | ❌ daemon 内 5 层防御 + 17 攻击向量 |
| **跨 session 聚合 UI** | ❌ orchestrator API + cache | ✅ daemon 内 query |
| **HA failover** | ✅ orchestrator 重启单 daemon | ❌ pod 级 sticky + 跨 pod 状态同步 |
| **调试** | ✅ 单 daemon 单 session | ❌ 多 session 状态耦合 |

**判断标准**：哪个位置的复杂度更容易管理？

- **单 session 复杂度集中在 orchestrator 层**——是新模块，可独立设计，问题域清晰（路由 / 调度 / pool 管理）
- **多 session 复杂度散在 daemon 内部各处**——与 core 业务逻辑交织，每次新加 feature 都要考虑 isolation

→ **单 session 模式的复杂度更"可见"且"可管理"**。

### 3.6 与现实约束的对齐

**PR#3889 当前状态**（+12393/-194 / **78 commits** / OPEN / CHANGES_REQUESTED）：Stage 1 bridge **已重构为 channel-per-workspace + N session multiplexed**（commit `6a170ef8`，2026-05-12）—— 这是 Stage 1 真正的事实标准。

| 选择 | 改造范围 | 状态 |
|---|---|---|
| Stage 1 channel-per-workspace（当前 PR#3889 实现）| `byWorkspaceChannel: Map<workspace, ChannelInfo>` + `getOrCreateChannel` coalesce + `connection.newSession()` 多路复用 + `killSession` 引用计数（commit `6a170ef8` 新增 ~500 行）| ✅ 100% Stage 1 内实现 |
| Stage 2e native in-process（去 `qwen --acp` child）| 修 `acpAgent.ts:601 loadSettings(cwd)` 跨 workspace 污染；HTTP daemon 直接 import `QwenAgent` 而非 spawn | ⚠️ 中等（~1-2 周，需 settings 重载层重构）|
| OpenCode-style 全应用层 ALS | + Effect-TS LocalContext + Map<workspace, Instance> + 跨 workspace ALS 路由 | ❌ 大改写（~2-3 月，且违反 Qwen "不引 Effect" 原则）|

**关键里程碑**：commit `6a170ef8` 直接把"原计划 Stage 2 native in-process"的核心收益（同 workspace N session 资源共享）在 Stage 1 内实现了。Stage 2e 剩下的工作量较小（跨 workspace 共享），且收益有限（除非 cross-workspace 高密度场景）。

**OpenCode 仍是 cross-workspace 高密度场景的成熟参考**；qwen-code Stage 1 已覆盖单 workspace 高密度场景；Stage 2e 是可选演进。

## 四、何时选哪个：决策树

### 4.1 选单 Session 的强信号

至少满足 3 项即倾向单 session：

- [ ] **单用户 / 团队 / 中等 SaaS**（< 50 并发 session/机）
- [ ] **长 session 工作流为主**（cold start 摊销到 session 生命周期可忽略）
- [ ] **强隔离 / 强安全需求**（多租户 / 合规场景）
- [ ] **Crash 容忍度低**（单 session crash 不影响其他用户）
- [ ] **团队不熟 ALS / Effect-TS**
- [ ] **PR#3889 Stage 1 child-process 模型已落地**（→ 短期改回多 session 成本高；Stage 2 in-process 重构可控范围内）
- [ ] **运维成熟度低**（多 daemon 进程管理负担小于多 session 内部管理）

→ **大多数 Qwen Code 真实用户场景命中此组**。

### 4.2 选多 Session 的强信号

至少满足 3 项才考虑多 session：

- [ ] **大规模 SaaS**（100+ 并发 session/机）
- [ ] **同 workspace 多 session 高密度**（团队协作 IDE / CI matrix）
- [ ] **高频短 session**（IDE 自动补全 / IM bot / serverless agent）
- [ ] **资源敏感**（VM 受限内存 / 容器配额）
- [ ] **跨 session 强一致性**（如批量 permission decision）
- [ ] **团队有 Effect-TS / ALS 深度经验**
- [ ] **运维成熟度高**（能 24h+ 监控单 daemon 长跑健康）

→ **大型企业 SaaS / 边缘机器学习 inference 场景命中此组**。

### 4.3 决策树

```
开始
├── N（并发 session/机）≤ 5？
│   └─ 是 → ✅ Stage 1 channel-per-workspace（同 workspace N session 共享 OAuth/cache/MCP）
├── 主要是同 workspace 内多 client / 多 session 协作？
│   └─ 是 → ✅ Stage 1（commit `6a170ef8` 后同 workspace N session ~60-100MB total，cold start <200ms after first）
├── N ≤ 50 跨 workspace（每 ws 少 session）+ 长 session 工作流？
│   └─ 是 → ✅ Stage 1（每 workspace ~60-100MB × 50 ws = ~3-5GB，可接受）
├── N ≤ 200 跨 workspace 中等密度？
│   └─ 是 → ✅ Stage 1 + External SaaS 资源池化（warm pool）~2-3w
├── N ≤ 500 跨 workspace 高密度 + cold start 敏感？
│   └─ 是 → ⚠️ Stage 2e native in-process（去 child 桥接 + 跨 ws 资源共享）~1-2w
└── N ≥ 500 大规模 SaaS（跨 workspace 高密度长跑）？
    └─ 是 → 🟡 Stage 2e + External orchestrator pool（daemon-per-tenant）
```

**注**：单 workspace 内多 session（含 Mode A TUI + 多个 HTTP client）已被 Stage 1 commit `6a170ef8` 完美覆盖。决策树主要区分 **跨 workspace 多少**——这是 Stage 1 / Stage 2e 的真正分界。

## 五、与 PR#3889 / OpenCode / qwen-code 自身现状的具体对齐

### 5.1 PR#3889 Stage 1 channel-per-workspace model（HTTP daemon 当前架构，commit `6a170ef8`）

```
qwen serve（HTTP front）
├─ byWorkspaceChannel: Map<workspace, ChannelInfo>
└─ HttpAcpBridge: spawn `qwen --acp` child per workspace
   ├─ child 1 (workspace=A)：QwenAgent.sessions Map → {sess-1, sess-2, sess-3}（multiplex）
   ├─ child 2 (workspace=B)：QwenAgent.sessions Map → {sess-4, sess-5}
   └─ child M (workspace=C)：QwenAgent.sessions Map → {sess-N}
```

**关键操作**：
- `getOrCreateChannel(workspaceKey)`：reuse existing channel 或 spawn 新 child（concurrent calls coalesced via `inFlightChannelSpawns`）
- `connection.newSession({cwd, mcpServers})`：在 existing channel 上加新 session
- `killSession`：从 `channelInfo.sessionIds` 移除；sessionIds 空时才 kill child
- `channel.exited` cleanup：tear down all sessions on channel + 每 session fan-out `session_died` event

### 5.2 OpenCode multi-session model

```
OpenCode daemon 进程
├─ Express HTTP server
├─ Effect-TS LocalContext（per-request session ctx）
├─ Map<directory, Promise<InstanceContext>>
│   ├─ ws-A: Instance{ session 1, session 2, LSP, MCP, cache }
│   ├─ ws-B: Instance{ session 1, session 2, LSP, MCP, cache }
│   └─ ws-C: ...
└─ SQLite + drizzle-orm（跨 session 共享）
```

### 5.3 qwen-code 自身的 multi-session 现状（已在 main 分支）

```
qwen --acp 进程（stdio NDJSON）
├─ class QwenAgent
│   └─ private sessions: Map<sessionId, Session>  ← 已支持单进程 N session
└─ ACP RPC：newSession / loadSession / unstable_listSessions / unstable_forkSession / session/resume

VSCode 插件实际使用：
└─ AcpConnection（1 child + N session + switchToSession()）
```

**这是 qwen-code 自身已验证的能力，不是新设计**——commit `6a170ef8` 在 HttpAcpBridge 层从 spawn-per-session 改成 spawn-per-workspace + multiplex N session 即是基于此能力。Stage 2e native in-process 进一步去 child 桥接，直接在 daemon HTTP front 进程内 import `QwenAgent`。

### 5.4 三种模型差异对照

| 维度 | OpenCode | **PR#3889 Stage 1 channel-per-workspace（commit `6a170ef8`）** | Stage 2e native in-process（可选，去 child）|
|---|---|---|---|
| 同 workspace N session 隔离 | 应用层 ALS | 应用层 ACP `sessions: Map` per-session | 应用层 `AsyncLocalStorage`（Node 内建）|
| 跨 workspace 资源共享 | ✓ Map<workspace, Instance> | ✗（不同 child）| ⚠️ 需先解 `loadSettings(cwd)` 污染 |
| 跨 workspace 隔离 | 应用层 LocalContext | OS process | 应用层 ALS（如解决污染）|
| 资源管理范围 | per-workspace Map | per-`qwen --acp` child（= per-workspace）| 同 Stage 1 + 跨 workspace 可选共享 |
| 持久化 | 跨 session SQLite | per-`qwen --acp` child JSONL（同 workspace N session 各自一份）| 同 Stage 1 |
| Cold start（首 session）| ~10ms | ~1-3s（spawn child）| ~10ms |
| Cold start（同 workspace 第 N session）| ~10ms | **<200ms**（attach existing channel）| ~10ms |
| Crash 半径 | 整 daemon | 同 workspace channel 全部 N session | 整 daemon |

详见 [§07 与 OpenCode 详细对比](./07-comparison-with-opencode.md)。


## 六、与各章节协同

| 章节 | 协同点 |
|---|---|
| [§02 §2 状态进程模型](./02-architectural-decisions.md#2-状态进程模型) | PR#3889 Stage 1 channel-per-workspace（commit `6a170ef8`）+ Stage 2e native in-process 可选演进的决策来源 |
| [§07 与 OpenCode 详细对比](./07-comparison-with-opencode.md) | OpenCode multi-session 模式 + Stage 2 in-process 演进对照 |
| [§12 vs Anthropic Managed Agents](./12-vs-anthropic-managed-agents.md) | Anthropic 的 per-session container 与 Stage 1 child-process model 架构相似 |

## 七、一句话总结

**PR#3889 Stage 1 commit `6a170ef8` 已实现 "channel-per-workspace + N session multiplexed"** ——这是 hybrid 模型：

- **同 workspace 内**：完全应用层多 session 共享（OAuth × 1 / cache × 1 / MCP × 1 / cold start <200ms），与 OpenCode 同款经济性
- **跨 workspace**：仍走 OS 进程隔离（`acpAgent.ts:601 loadSettings(cwd)` 是边界），未达 OpenCode 跨 workspace 资源共享

**90% 真实场景在此模型下已是最佳**——大多数用户单 workspace 1-10 session，已享受全部 in-process 经济性。

**Stage 2e native in-process（可选）**：只在 cross-workspace 高密度场景必需时推进——技术路径已具备（解决 `loadSettings(cwd)` 跨 ws 污染即可），届时直接 import `QwenAgent` 去掉 bridge child，省 ~50MB/workspace + IPC 延迟。

---

[下一篇：Orchestrator 多租户与配额 →](./14-orchestrator-multi-tenancy.md) · [回到 README](./README.md)
