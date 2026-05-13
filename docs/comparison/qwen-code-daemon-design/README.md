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

**PR#3889 Stage 1（commit `6a170ef8`, MERGED 2026-05-13）：1 daemon process + M `qwen --acp` children (1 per workspace) + N sessions multiplexed per workspace**——同 workspace 内 N session 共 `QwenAgent.sessions: Map<sessionId, Session>`（OAuth × 1 / FileReadCache × 1 / CLAUDE.md parse × 1 / cold start <200ms after first），与 OpenCode 同款 in-process N-session 经济性；**跨 workspace** 走独立 child 进程级隔离（`acpAgent.ts:600 loadSettings(cwd)` 边界）。

**双部署模式**：

| 模式 | 命令 | TUI | 适用场景 |
|---|---|:---:|---|
| **Mode A: CLI + HttpServer** | `qwen --serve [--port N]` | ✅ 本地渲染 | 单用户在终端 + WebUI / IDE / IM bot 同时接入 |
| **Mode B: Headless Daemon + HttpServer** | `qwen serve [--port N]` | ❌ | 服务器 / 容器 / 远端机器 |

> ✅ **Stage 1 已合并**（2026-05-13 06:47 UTC）：[**PR#3889**](https://github.com/QwenLM/qwen-code/pull/3889) `feat(cli,sdk): qwen serve daemon (Stage 1)`，merge commit `870bdf2a`，**+12993/-194 / 84 commits**。Express 5 server / ACP NDJSON over HTTP+SSE / Bearer + Host allowlist + 0.0.0.0 拒绝默认 / SHA-256 timing-safe / EventBus + ring replay + Last-Event-ID 重连 / first-responder permission vote / DaemonClient SDK / capabilities envelope 9 tags / bridge-per-workspace + N session multiplexed 全部已实现。

> ⏳ **Stage 1.5 / 2 后续**：chiga0 10 must-haves（pair tokens / unsubscribe API / lifecycle audit）+ 6 architecture findings（PermissionMediator / EventBus / FileSystemService / capability registry / AcpChannel lift / dualOutput-remoteInput convergence）+ Mode A 本地 TUI super-client wire 平权 + Mode B 远端 client option B daemon-side state CRUD（详见 [§06 Roadmap](./06-roadmap.md)）。

> 平行推进的 [PR#3929/3930/3931](https://github.com/QwenLM/qwen-code/pull/3929) `qwen remote-control` 3-stack（不同作者，独立开发）走 stream-json + dual-output + mobile UI 路线，**不引用 issue #3803**——是 daemon-design **平行参照而非实现**，未来或在 Stage 1.5/2 与 PR#3889 协调融合。

## 二、6 章总览

简化前 14 章 7441 行 → 简化后 6 章 ~1540 行（-79%）。文件序号与 Stage 编号无关，章节命名按主题。

| # | 文档 | 核心内容 | 行数 |
|---|---|---|---:|
| **01** | [Overview](./01-overview.md) | TL;DR + 3 层术语（daemon process / Workspace Bridge / session）+ 架构图 + 双 mode 对照 + Stage 进展 + 阅读指南 | 135 |
| **02** | [Architectural Decisions](./02-architectural-decisions.md) | 7 个核心决策：session 共享语义 P1/P2 / 进程模型 / MCP 生命周期 / FileReadCache / Permission flow / 多 client 并发 / Mode A vs Mode B（含老 §04 进程模型 + §13 单 vs 多 session 决策树）| 286 |
| **03** | [HTTP API & Protocol](./03-http-api.md) | Route table（含 Stage 1.5c daemon-side state CRUD）+ ACP wire 4 层兼容性矩阵 + SSE + Last-Event-ID + 双向 RPC 异步化 + Capability negotiation（含老 §08 协议兼容性）| 289 |
| **04** | [Deployment & Client](./04-deployment-and-client.md) | Mode A/B 对照 + TUI super-client vs thin shell 9 dialogs 分析 + P1 多 client 协调（subscriber protocol）+ Remote CLI 3 拓扑 + Client Capability 反向 RPC（含老 §09 TUI / §10 远端 CLI / §11 多 client 协调）| 295 |
| **05** | [Security & Permission](./05-permission-auth.md) | Bearer token + Host allowlist + 0.0.0.0 拒绝 / PR#3723 4-mode evaluatePermissionFlow / first-responder vote + per-session 隔离 / Multi-tenant 关键约束 | 214 |
| **06** | [Roadmap & Ecosystem](./06-roadmap.md) | Timeline + Stage 1 audit + Stage 1.5（chiga0 10 must-haves + Mode A + daemon-side state CRUD + 6 architecture findings）+ Stage 2（2a-2d + 2e native）+ External Reference Architecture（含老 §07 vs OpenCode / §12 vs Anthropic / §14 orchestrator 多租户）| 324 |

**总计** ~1543 行（含 README 169 行）。

## 三、阅读路径

| 路径 | 时间 | 顺序 | 适合 |
|---|---|---|---|
| 🚀 **快速理解** | ~20 min | §01 → §02 → §06 §〇/§一/§六 | 评估方案是否值得做 |
| 🔧 **MVP 实施** | ~1 h | §01 → §02 → §03 → §04 → §05 → §06 | 准备开 PR 写代码 |
| 📖 **完整设计** | ~2 h | §01 → §06 顺序 6 章读完 | 全面理解 |
| 🔒 **安全 / 多租户** | ~40 min | §05 → §06 §五 | 企业部署评估 |
| 🌐 **远端 / 多 client** | ~30 min | §04 §三/§四 + §06 §四 | 客户端体验设计 |

## 四、核心架构关键概念

### 4.1 3 层术语模型

| 层 | 数量 | 边界 | 共享资源 |
|---|---|---|---|
| **Daemon process** | 1 | OS 进程 | TLS / Bearer token / Express server / HTTP transport |
| **Workspace Bridge**（≡ 代码 `ChannelInfo`）| M（per workspace）| 独立 `qwen --acp` child process | settings / OAuth / FileReadCache / CLAUDE.md / MCP children |
| **Session** | N（per bridge）| `QwenAgent.sessions: Map<sessionId, Session>` | per-session transcript / pending tool calls / cancellation token |

详见 [§01](./01-overview.md) + [§02 §〇 术语](./02-architectural-decisions.md)。

### 4.2 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| Session 共享语义 | 默认 P1（多 client 同 session live collaboration）+ P2（N 独立 session per bridge）| P1 = OpenCode "watch-from-anywhere"；P2 = SDK "N parallel jobs" |
| 进程模型 | Stage 1 bridge-per-workspace + N session multiplexed | `acpAgent.ts:600 loadSettings(cwd)` 跨 workspace 污染前 N session per workspace 已足够省 |
| MCP 生命周期 | per-`qwen --acp` child | 同 workspace N session 共享 MCP children，跨 workspace 隔离 |
| FileReadCache | session-private（PR#3717 已实现）| daemon 不破坏 cache 语义 |
| Permission flow | 复用 PR#3723 + daemon 作为第 4 种 mode | bug 修一处全 mode 受益 |
| 多 client 并发 | FIFO prompt 串行 + fan-out 事件 + first-responder permission vote | OpenCode 同款模型 |
| Mode A vs Mode B | Mode A 本地 TUI super-client（保留 ~15 Ink dialogs）/ Mode B 远端 client 默认 thin shell（Stage 1.5c 可切 option B daemon-side state CRUD）| Mode A 简化 Stage 1 scope；Mode B 远端补齐留到 Stage 1.5+ |

详 [§02](./02-architectural-decisions.md)。

### 4.3 Stage 进展（at 2026-05-13）

| Stage | 状态 | 范围 |
|---|:---:|---|
| **Stage 1** | ✅ MERGED | PR#3889 - bridge-per-workspace + N session multiplexed |
| Stage 1.5a | ⏳ 待开 | chiga0 10 must-haves（Blockers / Reliability / Ergonomics）|
| Stage 1.5b | ⏳ 待开 | Mode A TUI super-client wire 平权 |
| Stage 1.5c | ⏳ 待开 | Mode B daemon-side state CRUD 切 option B（~3-5d，6-8 wire 路由）|
| Stage 1.5-prereq | ⏳ 待开 | chiga0 6 architecture findings（PermissionMediator / EventBus / FileSystemService / capability registry / AcpChannel lift / dualOutput-remoteInput）|
| Stage 2a-2d | ⏳ 待开 | session 共享 P1/P2 / multi-region orchestrator / observability / pluggable storage |
| Stage 2e | 可选 | native in-process（跨 workspace 高密度 N ≥ 500 场景）|

详 [§06](./06-roadmap.md)。

## 五、与已合并 PR 的关系

| PR | 内容 | 对 daemon 的意义 |
|---|---|---|
| **PR#3717** ✅ | FileReadCache（session-scoped + `(dev,ino)` key）| daemon 模式下天然支持跨 client 共享 |
| **PR#3723** ✅ | 共享 L3→L4 permission flow | Interactive / Non-Interactive / ACP 三模式权限决策合一，daemon 是第 4 种 |
| **PR#3739** ✅ | Background agent resume + transcript-first fork resume | daemon 重启 / failover 后 session 可恢复（SSE 重连协议的隐藏基础设施）|
| **PR#3810** ✅ | FileReadCache invalidation 5 路径修复 | 长 session 正确性保障 |
| **PR#3889** ✅ | qwen serve daemon Stage 1 | 本系列设计落地 |

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
