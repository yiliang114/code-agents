# 21 — 单 Session vs 多 Session 设计优缺点深度对比

> [下一篇：Orchestrator 多租户与配额 →](./22-orchestrator-multi-tenancy.md) · [回到 README](./README.md)

> 系统对比"1 Daemon Instance = 1 Session"（当前架构）与"单 daemon 多 session"（OpenCode 模式）两种设计的 tradeoff。**本章回答"为什么选这个"——为选型决策提供数据**；扩展到多 session 不在 qwen-code 主线设计目标（决策已定，本章解释为什么选 1 daemon = 1 session）。

## 一、TL;DR

**复杂度守恒**——单 session 把隔离卖给 OS（实现简单 + cold start/内存代价），多 session 自己实现隔离（资源经济 + 5 PR isolation 套路 + 17 HPE 攻击向量代价）。

| 哲学 | 单 Session（当前架构）| 多 Session（OpenCode 模式）|
|---|---|---|
| **隔离** | OS process 级（免费）| 应用层 ALS（自己实现）|
| **代价主战场** | Orchestrator 层 + 资源池化 | Daemon 内部 + 长跑稳定性 + multi-tenant 安全 |
| **Cold start** | ~1-3s/session | ~10ms/session |
| **内存（N=50）** | ~2GB | ~300MB |
| **Crash 半径** | 1 session | 整 daemon |
| **Subagent isolation** | 自动成立 | 5 PR 套路 |
| **大规模 SaaS（100+ session/机）** | 需资源池化 | 原生支持 |
| **当前默认** | ✅ | ❌ 仅大规模 SaaS 必需时投（External Reference Architecture）|

**实务建议**：单 session 模式覆盖 95% 真实场景；多 session 模式仅在大客户压测必需时投。

## 二、22 维对比矩阵

| # | 维度 | 单 Session | 多 Session |
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
| 12 | **HPE 攻击面**（[§12](./12-horizontal-privilege-defense.md)） | ✅ 17 个攻击向量 vanish 8 个 | ❌ 17 个全部需防御 |
| 13 | **Cross-session race condition** | ✅ 不存在 | ❌ 共享状态需要 lock / 原子操作 |
| 14 | **OOM 隔离** | ✅ 单 session 跑爆只杀自己 | ❌ 整 daemon OOM |
| 15 | **Long-run 稳定性**（[§19](./19-stability-and-longevity.md)） | ✅ 10 个泄漏点 vanish 5 个 | ❌ 全部需 TTL/quota/circuit breaker |
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

**缓解**：External SaaS 资源池化路径 的 daemon warm pool —— orchestrator 预热 N 个 idle daemon，按需绑 session，cold start ~1-3s → ~50-200ms。

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

**多 session 模式的"single point of failure"是它最大的运营负担**——所有 9 项稳定性模式（[§19 §五](./19-stability-and-longevity.md)）都是为了缓解此问题：TTL / bounded / quota / circuit breaker / memory threshold restart / heap dump / liveness / native supervisor / worker isolation。

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

**PR#3889 已实现 child-process-per-session**（+8883/-4 / 32 commits，~95% 设计落地 + 文档 100% 补全）—— 这是单 session 模型的事实标准。

| 选择 | PR#3889 改造 | 与 PR#3889 一致性 |
|---|---|---|
| 单 session 模式（当前架构）| ~0 行 | ✅ 100%（PR#3889 child-process = 当前 daemon instance）|
| 多 session 模式 | retrofit ~8800+ 行（拆分 child-process 为 in-process router）| ❌ 大改 |

**OpenCode 已实现多 session daemon ~半年**——经验和坑都踩过，但他们的 codebase 是 Effect-first，不能直接拷代码。

**结论**：单 session 模式 = 与 PR#3889 0 改造成本对齐。多 session 模式不在主线。

## 四、何时选哪个：决策树

### 4.1 选单 Session 的强信号

至少满足 3 项即倾向单 session：

- [ ] **单用户 / 团队 / 中等 SaaS**（< 50 并发 session/机）
- [ ] **长 session 工作流为主**（cold start 摊销到 session 生命周期可忽略）
- [ ] **强隔离 / 强安全需求**（多租户 / 合规场景）
- [ ] **Crash 容忍度低**（单 session crash 不影响其他用户）
- [ ] **团队不熟 ALS / Effect-TS**
- [ ] **PR#3889 child-process 模型已落地**（→ 改回多 session 成本高）
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
│   └─ 是 → ✅ 单 session（多 session 反而 baseline 更费）
├── N ≤ 50 且长 session 工作流？
│   └─ 是 → ✅ 单 session（当前默认）
├── N ≤ 100 但 cold start 敏感？
│   └─ 是 → ✅ 单 session + External SaaS 资源池化（warm pool）~2-3w
├── N ≤ 500 且同 workspace 高密度？
│   └─ 是 → ⚠️ 单 session + External SaaS Worker threads hybrid ~3-4w
└── N ≥ 500 大规模 SaaS？
    └─ 是 → ❌ 多 session 模式（External 重写）~2-3 月
```

## 五、与 PR#3889 / OpenCode 现状的具体对齐

### 5.1 PR#3889 child-process model（单 session 事实标准）

```
qwen serve（HTTP front）
└─ spawn `qwen --acp` child per session
   ├─ child 1：sess-A 的 ACP NDJSON stdio agent
   ├─ child 2：sess-B 的 ACP NDJSON stdio agent
   └─ child N：...
```

**命名约定**：
- `qwen serve` HTTP front = **Orchestrator**（多 daemon spawn / route / cleanup，External Reference Architecture）
- `qwen --acp` child = **Daemon Instance**（绑唯一 session，主线 building block）

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

**与 Qwen 当前架构的差异**：

| 维度 | OpenCode | Qwen 当前架构 |
|---|---|---|
| 隔离机制 | Effect-TS LocalContext | OS process |
| 资源管理 | per-workspace Map | per-daemon |
| 持久化 | 跨 session SQLite | per-daemon JSONL |
| Cold start | ~10ms | ~1-3s |
| Crash 半径 | 整 daemon | 1 session |

详见 [§09 与 OpenCode 详细对比](./09-comparison-with-opencode.md)。


## 七、与各章节协同

| 章节 | 协同点 |
|---|---|
| [§03 §2 状态进程模型](./03-architectural-decisions.md#2-状态进程模型) | 单 session 决策的来源 |
| [§09 与 OpenCode 详细对比](./09-comparison-with-opencode.md) | 多 session 模式的现实参考 |
| [§12 多租户水平越权防御](./12-horizontal-privilege-defense.md) | 多 session 的 17 攻击向量证据 |
| [§19 长跑稳定性](./19-stability-and-longevity.md) | 多 session 的 9 稳定性模式负担 |
| [§20 vs Anthropic Managed Agents](./20-vs-anthropic-managed-agents.md) | Anthropic 的 per-session container 与 Qwen 单 session 模型架构相似 |

## 八、一句话总结

**复杂度守恒**——选单 session 还是多 session 不是"哪个简单"的问题，是"复杂度放在哪"的问题：

- **单 session：复杂度在 orchestrator 层 + 资源池化层**——新模块，问题域清晰，可独立演进
- **多 session：复杂度散在 daemon 内部**——与 core 业务交织，每次新加 feature 都要考虑 isolation

**默认单 session**：因为（1）N < 50 时经济性可接受；（2）PR#3889 已落地；（3）OS 进程边界免费提供隔离；（4）触发条件多数项目永远不出现。

**多 session 仅在大规模 SaaS 必需时投**——届时按 External SaaS 资源池化路径演进，已实现代码不会白做。

---

[下一篇：Orchestrator 多租户与配额 →](./22-orchestrator-multi-tenancy.md) · [回到 README](./README.md)
