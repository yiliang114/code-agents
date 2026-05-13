# Qwen Code Daemon 架构设计（系列文档）

> Qwen Code 引入 HTTP daemon 模式的完整设计方案。基于 [SDK / ACP / Daemon 架构 Deep-Dive](../sdk-acp-daemon-architecture-deep-dive.md) 第七章"Qwen Code 引入 daemon 的工作量评估"展开为可执行的工程蓝图。

## 一、TL;DR

```
Qwen Code 已有 ACP agent + IM Channels 多路由设施（packages/channels/）+ WebUI 包 + SDK Transport 抽象
                                  ↓
        把 ACP NDJSON 协议通过 HTTP+SSE 桥接成 daemon
                                  ↓
              ~2-3 周 MVP，~1.5-2 月对标 OpenCode
```

**核心架构**：

```
1 daemon process = 1 workspace × N sessions multiplexed
```

`qwen serve` 启动时绑定 cwd = 单 workspace，daemon 内嵌单个 `qwen --acp` child，N session 共享同一 child（`QwenAgent.sessions: Map<sessionId, Session>` 原生 multi-session）。与 `qwen --acp` stdio 1:1 心智完全对齐——daemon 把 ACP stdio 包装成 HTTP，**不引入 multi-workspace 这层抽象**。

**为什么 1 daemon = 1 workspace**：
- 跨 workspace = 跨 daemon process = **OS 进程级真隔离**（最强）
- systemd `MemoryMax=` / cgroup / docker `--memory` 直接 = per-workspace quota（**无需 daemon 内部抽象**）
- 多 tenant 真隔离：1 daemon = 1 user × 1 workspace
- **K8s 云原生天然契合**：1 pod = 1 daemon = 1 workspace
- **Blast radius 最小**：daemon crash 只影响 1 workspace
- **心智简单**：daemon ↔ workspace ↔ session 三层折叠为 daemon ↔ session 两层
- 多 workspace 部署 = 多 daemon process（systemd / docker / k8s 各 1 process）

**双部署模式**：

| 模式 | 命令 | TUI | 适用场景 |
|---|---|:---:|---|
| **Mode A: CLI + HttpServer** | `qwen --serve [--port N]` | ✅ 本地渲染 | 单用户在终端 + WebUI / IDE / IM bot 同时接入当前 workspace |
| **Mode B: Headless Daemon + HttpServer** | `qwen serve [--port N]` | ❌ | 服务器 / 容器 / 远端机器 / K8s pod |

> ✅ **Stage 1 已合并**（2026-05-13 06:47 UTC）：[**PR#3889**](https://github.com/QwenLM/qwen-code/pull/3889) `feat(cli,sdk): qwen serve daemon (Stage 1)`，merge commit `870bdf2a`，**+12993/-194 / 84 commits**。Express 5 server / ACP NDJSON over HTTP+SSE / Bearer + Host allowlist + 0.0.0.0 拒绝默认 / SHA-256 timing-safe / EventBus + ring replay + Last-Event-ID 重连 / first-responder permission vote / DaemonClient SDK / capabilities envelope 9 tags 全部已实现。

> 🔧 **Follow-up PR（Stage 1.5a #11-#16）**：PR#3889 commit `6a170ef8` 引入的 multi-workspace 路由（`byWorkspaceChannel: Map<string, ChannelInfo>` / `getOrCreateChannel` / `inFlightChannelSpawns` 等 ~500-700 LOC）将通过 follow-up PR 移除，简化为 "1 daemon = 1 workspace × N session"。设计依据详 [§02 §2 状态进程模型](./02-architectural-decisions.md#2-状态进程模型核心决策)。

> ⏳ **Stage 1.5 / 2 后续**：chiga0 10 must-haves（pair tokens / unsubscribe API / lifecycle audit）+ 6 architecture findings + Mode A 本地 TUI super-client + Mode B 远端 client option B daemon-side state CRUD（详见 [§06 Roadmap](./06-roadmap.md)）。

## 二、6 章总览

简化前 14 章 7441 行 → 简化后 6 章 ~1660 行（-78%）。文件序号与 Stage 编号无关，章节命名按主题。

| # | 文档 | 核心内容 |
|---|---|---|
| **01** | [Overview](./01-overview.md) | TL;DR + 2 层术语（daemon process / session）+ 架构图 + 双 mode 对照 + 资源经济性 + Stage 进展 + 阅读指南 |
| **02** | [Architectural Decisions](./02-architectural-decisions.md) | 7 决策：session 共享 P1/P2 / **1 daemon = 1 workspace × N session 核心决策**（含 9 项收益 + 5 项移除 multi-workspace 路由理由 + vs OpenCode 设计哲学差异）/ MCP 生命周期 / FileReadCache / Permission flow / 多 client 并发 / Mode A vs Mode B |
| **03** | [HTTP API & Protocol](./03-http-api.md) | Route table（`/workspace/*` 单 workspace 路由）+ ACP wire 4 层兼容性矩阵 + SSE + Last-Event-ID + 双向 RPC 异步化 + Capability negotiation |
| **04** | [Deployment & Client](./04-deployment-and-client.md) | Mode A/B 对照 + TUI super-client vs thin shell 9 dialogs 分析 + 多 client 协调（subscriber protocol）+ Remote CLI 3 拓扑 + Client Capability 反向 RPC |
| **05** | [Security & Permission](./05-permission-auth.md) | Bearer token + Host allowlist + 0.0.0.0 拒绝 / PR#3723 4-mode evaluatePermissionFlow / first-responder vote + per-session 隔离 / Multi-tenant = 1 daemon 1 tenant OS 进程级隔离 |
| **06** | [Roadmap & Ecosystem](./06-roadmap.md) | Timeline + Stage 1 audit + **Stage 1.5a multi-workspace 路由移除 follow-up PR** + chiga0 10 must-haves + Mode A + daemon-side state CRUD + 6 architecture findings + Stage 2 + External Reference Architecture + vs OpenCode + vs Anthropic |

## 三、阅读路径

| 路径 | 时间 | 顺序 | 适合 |
|---|---|---|---|
| 🚀 **快速理解** | ~20 min | §01 → §02 → §06 §〇/§一/§六 | 评估方案是否值得做 |
| 🔧 **MVP 实施** | ~1 h | §01 → §02 → §03 → §04 → §05 → §06 | 准备开 PR 写代码 |
| 📖 **完整设计** | ~2 h | §01 → §06 顺序 6 章读完 | 全面理解 |
| 🔒 **安全 / 多租户** | ~40 min | §05 → §06 §五 | 企业部署评估 |
| 🌐 **远端 / 多 client** | ~30 min | §04 §三/§四 + §06 §四 | 客户端体验设计 |

## 四、核心架构关键概念

### 4.1 2 层术语模型

| 层 | 数量 | 边界 | 资源 |
|---|---|---|---|
| **Daemon process** | 1（per workspace）| OS 进程 = 启动时 cwd 绑定 = 1 workspace | TLS / Bearer token / Express server / HTTP transport / 内嵌单个 `qwen --acp` child |
| **Session** | N（per daemon）| `QwenAgent.sessions: Map<sessionId, Session>` 多路复用 | per-session transcript / pending tool calls / cancellation token / FileReadCache（session-private）|

**多 workspace 部署 = 多 daemon process**（不在 daemon 内部做 multi-workspace 路由）。详 [§01 §一](./01-overview.md#一术语表) + [§02 §〇 术语](./02-architectural-decisions.md)。

### 4.2 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| Session 共享语义 | 默认 P1（多 client 同 session live collaboration）+ P2（N 独立 session per daemon）| P1 = OpenCode "watch-from-anywhere"；P2 = SDK "N parallel jobs" |
| **状态进程模型** | **1 daemon = 1 workspace × N session multiplexed** | 与 `qwen --acp` stdio 1:1 心智 + OS 进程级隔离 + cgroup quota + K8s 云原生契合 + blast radius 最小 |
| MCP 生命周期 | per-daemon | 同 daemon N session 共享 MCP children，跨 daemon = 跨 workspace OS 进程级隔离 |
| FileReadCache | session-private（PR#3717 已实现）| daemon 不破坏 cache 语义 |
| Permission flow | 复用 PR#3723 + daemon 作为第 4 种 mode | bug 修一处全 mode 受益 |
| 多 client 并发 | FIFO prompt 串行 + fan-out 事件 + first-responder permission vote | OpenCode 同款模型 |
| Mode A vs Mode B | Mode A 本地 TUI super-client（保留 ~15 Ink dialogs）/ Mode B 远端 client 默认 thin shell | Mode A 简化 Stage 1 scope；Mode B 远端补齐留到 Stage 1.5c |

详 [§02](./02-architectural-decisions.md)。

### 4.3 Stage 进展（at 2026-05-13）

| Stage | 状态 | 范围 |
|---|:---:|---|
| **Stage 1** | ✅ MERGED | PR#3889 - 含 multi-workspace 路由（待 Stage 1.5a follow-up 移除）|
| **Stage 1.5a** | ⏳ 待开 | chiga0 10 must-haves + **multi-workspace 路由移除 follow-up PR**（删 ~500-700 LOC，回归 1 daemon = 1 workspace × N session 心智）|
| Stage 1.5b | ⏳ 待开 | Mode A `qwen --serve` flag |
| Stage 1.5c | ⏳ 待开 | Mode B daemon-side state CRUD（~3-5d，6-8 wire 路由）|
| Stage 1.5-prereq | ⏳ 待开 | chiga0 6 architecture findings（PermissionMediator / EventBus / FileSystemService / capability registry / `AcpChannel` lift / dualOutput-remoteInput）|
| Stage 2a-2d | ⏳ 待开 | session 共享 P1/P2 / multi-region orchestrator / observability / pluggable storage |
| Stage 2e | 可选 | native in-process（去 `qwen --acp` child） |

详 [§06](./06-roadmap.md)。

## 五、与已合并 PR 的关系

| PR | 内容 | 对 daemon 的意义 |
|---|---|---|
| **PR#3717** ✅ | FileReadCache（session-scoped + `(dev,ino)` key）| daemon 模式下天然支持跨 client 共享 |
| **PR#3723** ✅ | 共享 L3→L4 permission flow | Interactive / Non-Interactive / ACP 三模式权限决策合一，daemon 是第 4 种 |
| **PR#3739** ✅ | Background agent resume + transcript-first fork resume | daemon 重启 / failover 后 session 可恢复（SSE 重连协议的隐藏基础设施）|
| **PR#3810** ✅ | FileReadCache invalidation 5 路径修复 | 长 session 正确性保障 |
| **PR#3889** ✅ | qwen serve daemon Stage 1 | 本系列设计落地（multi-workspace 路由待 follow-up PR 移除）|

## 六、决策与文档对应

| 上游决策点（[SDK/ACP/Daemon Deep-Dive §七](../sdk-acp-daemon-architecture-deep-dive.md#七qwen-code-引入-daemon-的工作量评估)）| 本系列章节 |
|---|---|
| Session 共享语义 | §02 §1 |
| 状态进程模型 | §02 §2（1 daemon = 1 workspace × N session）|
| MCP server 生命周期 | §02 §3 |
| FileReadCache 共享 | §02 §4 |
| Permission flow | §02 §5 + §05 |
| 多 client 并发请求 | §02 §6 + §04 §三 |
| 持久化（External Reference）| §06 §五 |
| 远端 CLI / 协作 | §04 §三/§四 |

---

> **免责声明**：本系列是 codeagents 项目的设计提案，不代表 Qwen Code 团队官方路线图。所有"工作量估算"是基于源码可见复用度的推测，实际开发可能因团队优先级、API 稳定性要求等变化。
