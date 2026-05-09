# Qwen Code Daemon 架构设计（系列文档）

> Qwen Code 引入 HTTP daemon 模式的完整设计方案。基于 [SDK / ACP / Daemon 架构 Deep-Dive](../sdk-acp-daemon-architecture-deep-dive.md) 第七章"Qwen Code 引入 daemon 的工作量评估"展开为可执行的工程蓝图。

## 核心架构

**1 Daemon Instance = 1 Session**——每个 daemon 进程承载唯一一个 session；多 session 通过 orchestrator spawn 多个 daemon 实例实现。

**双部署模式**：

| 模式 | 命令 | TUI | 适用场景 |
|---|---|:---:|---|
| **Mode A: CLI + HttpServer** | `qwen --serve [--port N]` | ✅ 本地渲染 | 单用户在终端 + WebUI / IDE / IM bot 同时接入 |
| **Mode B: Headless Daemon + HttpServer** | `qwen serve [--port N]` | ❌ | 服务器 / 容器 / 远端机器 |

两种模式都遵循"1 daemon instance = 1 session"，区别仅在 daemon instance 是否同时承载本地 TUI 客户端。TUI 是 client #0（in-process EventBus），与 HTTP 远端 client 共享同一份事件流（[§03 §6](./03-architectural-decisions.md#6-多-client-并发请求) fan-out）。

**为什么选这个架构**：进程级隔离免费、crash 半径小、subagent isolation 自动成立、与 [PR#3889](https://github.com/QwenLM/qwen-code/pull/3889) child-process-per-session 实现一致。代价是 cold start ~1-3s/session、内存 ~30-50MB × N session——单机 N < 50 场景可接受。详见 [§22 单 vs 多 Session 设计深度对比](./22-single-vs-multi-session-design.md)。

> **🚀 Stage 1 实现**（2026-05-07）：[**PR#3889**](https://github.com/QwenLM/qwen-code/pull/3889) `feat(cli,sdk): qwen serve daemon (Stage 1)` —— OPEN，**+7698/-46 / 23 commits**（多轮 self-audit + reviewer rounds）。明确引用 [issue #3803](https://github.com/QwenLM/qwen-code/issues/3803)（本系列对应 issue），**~95% 设计决策 1:1 落地**——Express 5 server / ACP NDJSON over HTTP+SSE / Bearer + Host allowlist + 0.0.0.0 拒绝默认 / SHA-256 timing-safe compare / EventBus + ring replay + Last-Event-ID 重连 / first-responder permission vote / DaemonClient SDK / capabilities envelope 9 tags 全部已实现。详见 [§08 路线图 Stage 1 实现 audit](./08-roadmap.md#stage-1-pr3889-实现-audit2026-05-07)。
>
> 平行推进的 [PR#3929/3930/3931](https://github.com/QwenLM/qwen-code/pull/3929) `qwen remote-control` 3-stack（不同作者，独立开发）走 stream-json + dual-output + mobile UI 路线，不引用 issue #3803——是 daemon-design **平行参照而非实现**，未来或在 Stage 1.5/2 与 PR#3889 协调融合（mobile UI / pairing token / LAN URL 移植到 daemon）。

## 阅读路径

| 路径 | 时间 | 文档 | 适合 |
|---|---|---|---|
| 🚀 **快速理解** | ~30 min | §01 → §03 → §08 → §09 | 评估方案是否值得做 |
| 🔧 **MVP 实施** | ~2 h | §01 → §03 → §04 → §05 → §06 → §07 → §08 | 准备开 PR 写代码 |
| 📖 **完整设计** | ~6 h | Part I → II → III → IV → V → VI 顺序 | 全面理解 |
| 🔒 **安全 / 多租户专题** | ~2 h | §11 → §23 → §12 → §16 → §18 | 企业部署评估 |
| 🌐 **远端 / 协作专题** | ~2 h | §13 → §17 → §18 | 客户端体验设计 |
| 💾 **数据架构专题** | ~1 h | §14 → §15 → §16 §三-§九 | 持久化 / HA 设计 |

## 文档结构

文档按主题分 6 组（文件序号保持不变以避免链接 churn；推荐按 Part 顺序阅读）：

### Part I — 基础（必读）

理解整个系列前需要掌握的核心概念。

| # | 文档 | 一句话 |
|---|---|---|
| 01 | [架构总览](./01-overview.md) | daemon 模型本质 + 与 subprocess 模型对比 + 与 OpenCode 设计差异概述 |
| 02 | [现有资产盘点](./02-existing-assets.md) | Qwen Code 中 7 项可复用基础设施（ACP agent 838 行 / Channels / WebUI / SDK Transport 等）+ 复用度评估 |
| 03 | [6 个架构决策](./03-architectural-decisions.md) | session 共享语义 / 状态进程模型 / MCP 生命周期 / FileReadCache / Permission flow / 多 client 并发——所有后续设计的基石 |

### Part II — 协议与运行时

daemon 与外部世界对话的协议层、daemon 进程内部的运行时机制。

| # | 文档 | 一句话 |
|---|---|---|
| 04 | [HTTP API 设计](./04-http-api.md) | 路由结构、请求/响应 schema（复用 ACP zod schema）、WebSocket / SSE 事件 |
| 05 | [进程模型与工作目录隔离](./05-process-model.md) | AsyncLocalStorage 上下文传播、子进程 spawn 边界、`process.cwd()` 不变性 |
| 06 | [MCP / FileReadCache / LSP 资源共享](./06-mcp-resources.md) | 跨 session 资源共享策略、生命周期管理 |
| 07 | [权限流与认证](./07-permission-auth.md) | bearer token 鉴权 + user permission flow（PR#3723 共享 L3→L4 复用）+ 跨 client 审批 UX |
| 10 | [SDK / ACP 协议兼容性](./10-protocol-compatibility.md) | 单进程 vs Daemon 4 层兼容性矩阵 + 双向 RPC 同步→异步处理 + 用户代码 0 改动证明 |

### Part III — 客户端形态

不同 client（TUI / 远端 / 多端）如何与 daemon 协同工作。

| # | 文档 | 一句话 |
|---|---|---|
| 13 | [TUI 单进程 vs Daemon 兼容性](./13-tui-compatibility.md) | 4 层兼容性矩阵（显示层 100% / 状态层 100% / 数据源层替换 / 本地依赖 5 类 fallback）+ 多 TUI 共 session + 同 host fast path vs 跨 host RPC + 12 项兼容性测试 |
| 17 | [远端 CLI 模式与 Client Capability 协议](./17-remote-cli-mode.md) | 3 类拓扑（Local-Local / Local-Remote 不推荐 / **Remote-Remote 推荐**）+ Client Capability 反向 RPC 协议 + 5 类 capability + TLS/mTLS auth + NAT 穿透 + Local echo + VSCode Remote-SSH 对比 |
| 18 | [多端协调策略](./18-client-coordination.md) | 不限同类型 client 数量（保 collaboration 哲学）+ 6 类 client kind 分桶上限 + liveness（30s heartbeat / 90s 超时 / TCP RST 即时剔除）+ active typer 协调 + 显式 takeover + 可选 exclusive_per_type 模式 + IM bot 一对多用户 |

### Part IV — 数据与状态

实体之间的关系、在哪里持久化、如何演进。

| # | 文档 | 一句话 |
|---|---|---|
| 14 | [实体模型与层级关系](./14-entity-model.md) | **5 层 hierarchy**（Tenant → Workspace → Session → Background Task → Tool Execution）+ 横切层（Client subscription）+ 认证侧 sidebar（External User / Token：不算 hierarchy）+ 关系矩阵 + 资源所有权层级表 + 生命周期表 + ER 图 |
| 15 | [持久层与外部存储](./15-persistence-and-storage.md) | **当前 Qwen Code 是纯 JSON+JSONL（无 SQLite / 无 ORM）** → Stage 1-2 沿用现状 → **Stage 3 首次引入 SQLite**（4 类痛点驱动）→ Storage Adapter 抽象 → **Stage 6 切 Postgres + S3**。drizzle-orm 选型 + 8 张核心表 schema + 替代方案对比 |

### Part V — 多租户、安全与高可用（生产级能力）

从单用户工具走向企业 SaaS 必须解决的能力。

| # | 文档 | 一句话 |
|---|---|---|
| 11 | [Shell 沙箱与远程执行](./11-multi-tenancy-and-sandbox.md) | `ShellSandbox` interface + 4 种本地沙箱（NoSandbox / OS user / Linux namespace / Container）+ **远程 sandbox**（SSH / gRPC / k8s Job / containerd over TCP 4 种实现 + 工作流同步 / stdout 流式 / 取消 / 网络容错 / 延迟 5 大挑战）+ Monitor tool 走相同接口 + 与 Claude Code v2.1.98 SCRIPT_CAPS 对齐 |
| 23 | [Orchestrator 多租户与配额](./23-orchestrator-multi-tenancy.md) | **multi-tenancy 在 orchestrator 层** —— Tenant 抽象 / AuthN 4 模式（Bearer / OIDC / mTLS / cookie）/ AuthZ workspace 映射 / Quota engine（Redis 原子 + reservation 模式）/ Audit log 4 通道（jsonl / syslog / OpenTelemetry / Kafka）/ Stage 4-6 SaaS 路线图 |
| 12 | [多租户水平越权防御](./12-horizontal-privilege-defense.md) | **5 层防御纵深 + 17 个攻击向量 + 24+ 测试用例** —— Auth/ACL / Filesystem / Cache/State / Sandbox / Side-channel & DoS 五层 + OWASP Top 10 映射 |
| 16 | [HA 高可用与故障恢复](./16-high-availability.md) | **5 层 HA 架构**（Edge DNS → Ingress sticky → StatefulSet pod N≥3 → Postgres Patroni + Redis Sentinel + S3 多 AZ）+ SSE Last-Event-ID 重连协议 + LLM streaming 中断 7 类场景 + 90s graceful drain + 15 项 Chaos 测试 + 99.9% SLO |
| 19 | [长跑稳定性与可观测性](./19-stability-and-longevity.md) | **接受"重启不可避免"** —— Node.js 长跑 7 类风险（heap / GC / fd / zombie / exception / native crash / ALS 链表）+ 多租户加剧 5 类 + qwen daemon 10 个具体泄漏点（含修复代码）+ **9 项稳定性模式**（TTL / bounded / quota / circuit breaker / memory threshold restart / heap dump / liveness / native supervisor / worker isolation）+ 6 类 native module 风险 + 22 项 Prometheus 指标 + 30 天 Soak/Chaos 测试矩阵 + Bun vs Node.js 长跑实测 |

### Part VI — 路线图与外部对比

实施时间线和与同类产品的对照。

| # | 文档 | 一句话 |
|---|---|---|
| 08 | [路线图](./08-roadmap.md) | Stage 1（~1 周，✅ PR#3889 ~95% 实现 Mode B headless）/ Stage 1.5（~4d 增量 Mode A CLI+HttpServer）/ Stage 2（~1-2 周 orchestrator 雏形）/ Stage 3（~1 月）+ Stage 4-6（多租户 → 沙箱 → SaaS）|
| 09 | [与 OpenCode 详细对比](./09-comparison-with-opencode.md) | 路由 / 技术栈 / 设计哲学逐项对照 |
| 20 | [与 Anthropic Managed Agents 对比](./20-vs-anthropic-managed-agents.md) | **5 层架构对照**（client / agent runtime / tool / sandbox / persistence）+ **内置工具映射** + **协议层差异**（Anthropic 私有 vs ACP 标准）+ **双向 migration path**（Anthropic→Qwen / Qwen→Anthropic 兼容 API）+ **6 类客户场景推荐** + **决策树 6 问选型** + **3 种混合部署模式** + **"Managed Qwen Agents" 产品蓝图**（基于 Stage 6 包装，6 月可建）|
| 21 | [扩展到 multi-session daemon 的演进路径](./21-future-multi-session-migration.md) | 单 session 模型上限触发后的演进选项 —— 路径 A 资源池化（~2-3w 拿 ~80% OpenCode 经济性）/ 路径 B Worker threads hybrid（~3-4w）/ 路径 C 纯迁移到 OpenCode 模式（~2-3 月）+ YAGNI 触发条件清单 + 推荐演进路径 + 关键不变量（现有代码不会白做）|
| 22 | [单 vs 多 Session 设计深度对比](./22-single-vs-multi-session-design.md) | **22 维对比矩阵 + 6 项关键 tradeoff 深度分析**（隔离昂贵性 / cold start 平方根 / 内存 baseline 建模 / 隔离失败代价 / 复杂度守恒原理 / PR#3889 现实约束）+ **决策树 N≤5/50/100/500/500+** + 与 §21 互补（§22 决策入口 / §21 演进退路）|

## 一句话 TL;DR

```
Qwen Code 已有 ACP agent 838 行 + Channels 多路由设施 + WebUI 包 + SDK Transport 抽象
                                  ↓
        把 ACP NDJSON 协议通过 HTTP+WebSocket 桥接成 daemon
                                  ↓
              ~2-3 周 MVP，~1.5-2 月对标 OpenCode
```

**核心设计哲学**（与 OpenCode 一致）：
- daemon 内部不再 spawn CLI 子进程；core 通过 import 加载到 daemon 进程内
- 多 session 共享 daemon 进程；用 `AsyncLocalStorage` 做 cwd / context 隔离
- LSP / MCP server / PTY 才是真正的子进程
- 持久化分层：Stage 1-2 沿用 JSON / JSONL（与现状一致），Stage 3 引入 SQLite，Stage 6 SaaS 切 Postgres + S3

**与 OpenCode 不同的地方**：
- **复用 ACP NDJSON schema 作为内部 RPC**（OpenCode 用自定义 OpenAPI schema codegen）
- **Channels 多路由复用**（IM / WebUI / IDE 都走 SessionRouter）—— OpenCode 没有等价物
- **bearer token + PR#3723 共享 L3→L4 权限流**（OpenCode 用单密码）
- **默认跨 client 共享 session（live collaboration 模型）**：CLI + IDE + WebUI + 手机微信同时观察同一会话；任何 client 都可代为审批权限请求；prompt 串行 / 事件 fan-out / 任意 client 取消（OpenCode 是每 SDK call 独立 session）

## 决策与文档的对应

| 上游决策点（[SDK/ACP/Daemon Deep-Dive §七](../sdk-acp-daemon-architecture-deep-dive.md#七qwen-code-引入-daemon-的工作量评估)）| 本系列对应 |
|---|---|
| Session 共享语义 | [§03 决策](./03-architectural-decisions.md) §1 默认 'single' scope |
| 状态进程模型 | [§03 决策](./03-architectural-decisions.md) §2 + [§05 进程模型](./05-process-model.md) |
| MCP server 生命周期 | [§03 决策](./03-architectural-decisions.md) §3 per-workspace + [§06 资源共享](./06-mcp-resources.md) §1 |
| FileReadCache 共享 | [§03 决策](./03-architectural-decisions.md) §4 session-private + [§06 资源共享](./06-mcp-resources.md) §2 |
| Permission flow | [§03 决策](./03-architectural-decisions.md) §5 + [§07 权限/认证](./07-permission-auth.md) |
| 多 client 并发请求 | [§03 决策](./03-architectural-decisions.md) §6 FIFO + fan-out + first responder + [§18 多端协调](./18-client-coordination.md) |
| 实体层级 | [§14 实体模型](./14-entity-model.md) 5 层 hierarchy + 认证侧 |
| 持久化 | [§15 持久层](./15-persistence-and-storage.md) JSON → SQLite → Postgres 演进 |
| 多租户 / 沙箱 | [§11 Shell 沙箱](./11-multi-tenancy-and-sandbox.md) + [§23 Orchestrator 多租户](./23-orchestrator-multi-tenancy.md) + [§12 越权防御](./12-horizontal-privilege-defense.md) |
| HA / SaaS 部署 | [§16 高可用](./16-high-availability.md) |
| 远端 CLI / 协作 | [§17 远端 CLI](./17-remote-cli-mode.md) + [§18 多端协调](./18-client-coordination.md) |

## 与已合并 PR 的关系

5 月份的几个关键 PR**正在为 daemon 化扫清障碍**——本设计假设它们都已合并：

| PR | 内容 | 对 daemon 化的意义 |
|---|---|---|
| **PR#3717** ✓ | FileReadCache（session-scoped + `(dev,ino)` key）| daemon 模式下天然支持跨 client 共享 |
| **PR#3739** ✓ | Background agent resume + transcript-first fork resume | daemon 重启 / failover 后 session 可恢复（[§16 §五](./16-high-availability.md) SSE 重连协议的隐藏基础设施）|
| **PR#3723** ✓ | 共享 L3→L4 permission flow | Interactive / Non-Interactive / ACP 三模式权限决策合一，daemon 是第 4 种（[§07](./07-permission-auth.md)）|
| **PR#3642** ✓ | `/tasks` + managed background shell pool | 跨 session 任务调度框架（[§subagent-display](../subagent-display-deep-dive.md)）|
| **PR#3810** ✓ | FileReadCache invalidation 5 路径修复 | 长 session 正确性保障 |

加上 PR#3739 / PR#3717 提供的 session resume + cache 基础，daemon 化在 5 月初已经具备**全部前置条件**。

## 系列演化简史

| 阶段 | 文档 | 主题 |
|---|---|---|
| 第一轮 | §01-§09 | 基础架构 + 协议 + 路线图 + OpenCode 对比 |
| 第二轮 | §10 | 协议兼容性补强（SDK/ACP 单进程 vs Daemon）|
| 第三轮 | §11-§13 | 多租户 + 沙箱 + 越权防御 + TUI 兼容性 |
| 第四轮 | §14-§16 | 实体模型 + 持久层 + HA |
| 第五轮 | §17-§18 | 远端 CLI + 多端协调（client capability 协议）|

> **免责声明**：本系列是 codeagents 项目的设计提案，不代表 Qwen Code 团队官方路线图。所有"工作量估算"是基于源码可见复用度的推测，实际开发可能因团队优先级、API 稳定性要求等变化。
