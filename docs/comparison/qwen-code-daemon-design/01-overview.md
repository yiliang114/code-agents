# 01 — Overview

> [← 返回 README](./README.md) · [下一篇：Design Decisions →](./02-architectural-decisions.md)

## TL;DR

**qwen serve** 是 Qwen Code 的 HTTP daemon 模式——把 ACP NDJSON 协议通过 HTTP+SSE 暴露成可被任何 client / orchestrator 消费的服务。**PR#3889 Stage 1 ✅ 已合并 2026-05-13**（merge commit `870bdf2a`，+12993/-194 / 84 commits）。

**核心架构**：
- **Default**：1 daemon process = **1 workspace** × N sessions multiplexed（与 `qwen --acp` stdio 1:1 心智 + OS 进程级隔离 + cgroup quota + K8s 云原生契合）
- **Advanced opt-in**（`qwen serve --multi-workspace`）：1 daemon process + M Workspace Bridges + N sessions per bridge（commit `6a170ef8` PR#3889 已实现，Stage 1.5a 转为 opt-in flag；本地多项目 / IM bot 跨 workspace 路由场景）

**两种部署**：
- **Mode A** `qwen --serve` — 本地 TUI + HTTP front 同进程（super-client）
- **Mode B** `qwen serve` — headless HTTP front（远端 client 是 thin shell）

**主线 scope**：daemon building block + 协议表面锁定（Stage 2 后）。多 tenant / 跨 daemon process 路由 / SaaS 部署属 **External Reference Architecture**（外部商业平台实施）。

---

## 一、术语表（commit `6a170ef8` 之后）

> ⚠️ **术语澄清**：本系列用 **Workspace Bridge** 指 per-workspace `qwen --acp` child process。代码层这一概念叫 `ChannelInfo` / `byWorkspaceChannel`（详见 `packages/cli/src/serve/httpAcpBridge.ts:371`），但与 `packages/channels/base/ChannelBase`（IM 消息渠道，钉钉/Telegram/微信）**同名不同义**。Stage 1.5-prereq finding 1 拟把两套语义收敛到共享 `AcpChannel`（详 [§06](./06-roadmap.md)），届时再统一命名。

| 术语 | 定义 | 源码 anchor |
|---|---|---|
| **Daemon process** | `qwen serve` 或 `qwen --serve` HTTP front 进程；含 Express 5 server + EventBus + `byWorkspaceChannel: Map<workspace, ChannelInfo>` | `packages/cli/src/serve/server.ts` |
| **Workspace Bridge**（≡ 代码 `ChannelInfo`）| 1 个 `qwen --acp` 子进程，绑定 1 个 workspace；持 `QwenAgent.sessions: Map<sessionId, Session>` 内 N 个 session | `packages/cli/src/serve/httpAcpBridge.ts:371` + `packages/cli/src/acp-integration/acpAgent.ts:194` |
| **Session** | ACP `Session` 实例（per-bridge `sessions: Map` 内一条）；持 transcript / FileReadCache / PermissionManager | `packages/cli/src/acp-integration/session/Session.ts` |

**核心约束**：
- **Default**：1 daemon process = 1 workspace（启动 cwd 绑定）= 1 内嵌 bridge × N sessions
- **Advanced** opt-in `--multi-workspace`：1 daemon process **可有 M Workspace Bridges**（每 workspace 1 bridge）
- 1 bridge **严格 1 workspace**（`acpAgent.ts:600` `this.settings = loadSettings(cwd)` 是 instance-wide，跨 workspace 会污染）
- 1 bridge **可持 N sessions**（同 workspace 多路复用）

> **废弃术语**："Daemon Instance" — 早期 PR#3889 设计中等同 "1 bridge = 1 session"，commit `6a170ef8` 后此等式被打破。

---

## 二、架构图

### Default 模式（推荐）：1 daemon = 1 workspace

```
qwen serve (1 Daemon process, 绑定 cwd = /work/repo-a)
├─ Express 5 HTTP server + bearer auth + Host allowlist
├─ EventBus（per-session fan-out + ring replay + Last-Event-ID 重连）
└─ qwen --acp child (workspace = /work/repo-a)
   ├─ QwenAgent.sessions: Map → {sess-1, sess-2, sess-3}
   └─ LSP + MCP + FileReadCache（per-daemon 共享）
```

多 workspace = 多 daemon 各占一 port，systemd / docker / k8s 各 1 process 直接管理。资源 quota / blast radius / observability 自然 per-workspace。

### Advanced 模式：1 daemon + M Workspace Bridges（`--multi-workspace`）

```
qwen serve --multi-workspace (1 Daemon process)
├─ Express 5 HTTP server + bearer auth + Host allowlist
├─ EventBus（per-session fan-out + ring replay + Last-Event-ID 重连）
└─ byWorkspaceChannel: Map<workspace, ChannelInfo>  ← 代码标识，本系列称之为 Workspace Bridge
   ├─ Bridge-A (workspace = /work/repo-a) — qwen --acp #1
   │  ├─ QwenAgent.sessions: Map → {sess-1, sess-2, sess-3}
   │  └─ LSP + MCP + FileReadCache (per-bridge 共享)
   ├─ Bridge-B (workspace = /work/repo-b) — qwen --acp #2
   │  ├─ QwenAgent.sessions: Map → {sess-4, sess-5}
   │  └─ LSP + MCP + FileReadCache (per-bridge 独立)
   └─ Bridge-C (workspace = /work/repo-c) — qwen --acp #3
      ├─ QwenAgent.sessions: Map → {sess-7}
      └─ ...
```

适用：本地多项目（开发者日常）/ Mode A 本地 TUI 多 workspace / IM bot 跨 workspace 路由。

### 跨 daemon process 部署（External Reference Architecture）

```
                ┌──────────────────────────────────────────┐
                │ External Orchestrator (qwen-coordinator) │
                │   - tenant → daemon-process 1:1 绑定      │
                │   - cross-daemon routing                 │
                │   - sticky cookie failover               │
                └────────────────────┬─────────────────────┘
                                     │ spawn / route
       ┌─────────────────┬───────────┴────────────┬──────────────┐
       ↓                 ↓                        ↓              ↓
 ┌───────────┐     ┌───────────┐            ┌───────────┐  ┌───────────┐
 │ daemon-1  │     │ daemon-2  │            │ daemon-N  │  │   ...     │
 │ (tenant A)│     │ (tenant B)│            │ (tenant C)│  │           │
 └───────────┘     └───────────┘            └───────────┘  └───────────┘
```

详 [§06 Roadmap & Ecosystem](./06-roadmap.md)。

---

## 三、双部署模式

| 模式 | 启动命令 | TUI | 适用场景 |
|---|---|---|---|
| **Mode A: CLI + HttpServer** | `qwen --serve [--port N]` | ✅ 本地（super-client）| 单用户终端 + WebUI / IDE / IM bot 同时接入 |
| **Mode B: Headless + HttpServer** | `qwen serve [--port N]` | ❌ | 服务器 / 容器 / 远端机器 |

**Mode A 本地 TUI 是 "super-client"**——保留完整 local interaction layer（~15 Ink dialogs + local-jsx slash commands）；wire 只承载 agent↔user conversation axis。

**Mode B 远端 client 是 "thin shell"**（Stage 1）——只能渲染 wire 流，daemon-side state dialogs（`/memory` / `/mcp` / `/agents` 等）不可用。Stage 1.5c daemon-side state CRUD（~3-5d）补齐后远端 client 与 Mode A 本地 TUI 功能对齐。详 [§04 §三 TUI 体验](./04-deployment-and-client.md)。

---

## 四、资源经济性（commit `6a170ef8` 实测）

**同 workspace N session 经济性（default + advanced 共享）**：

| N 同 workspace session | 早期（1 child per session）| 当前（N session 共 1 bridge）|
|---|---|---|
| 1 | ~60-100 MB RSS | ~60-100 MB RSS（相同）|
| 5 | 300-500 MB RSS | **60-100 MB RSS**（节省 ~5x）|
| 10 | 600-1000 MB RSS | **80-150 MB RSS**（节省 ~6-7x）|
| OAuth refresh | N× 独立 | 1× per bridge |
| FileReadCache | N× 独立 | shared per bridge |
| CLAUDE.md parse | N× | parse 一次 per bridge |
| Cold start（同 workspace 第 N session）| ~1-3s | **<200ms**（attach existing bridge）|

**Default vs Advanced 多 workspace 内存对比**（M=5 workspace × N=5 session 同机）：

| 维度 | Default（5 daemon × 1 workspace）| Advanced（1 daemon × 5 workspace）|
|---|---|---|
| Daemon baseline | 5 × ~30-50MB = **~150-250 MB** | 1 × ~30-50MB = **~30-50 MB** |
| 同 workspace N session 共享 bridge | ✓ | ✓ |
| 5 workspace × 5 session bridge | 5 × ~60-100MB | 5 × ~60-100MB |
| **总内存** | ~450-750 MB | ~330-550 MB |
| 节省 | baseline | ~120-200 MB |
| Blast radius | 单 workspace | 全部 workspace |
| Quota / observability | OS 进程级直接套 cgroup | 需 daemon 内部抽象 |

**Default 适用**：服务器 / 容器 / K8s 部署 / 多 tenant SaaS / blast radius 关键场景  
**Advanced 适用**：单机本地多项目 / IM bot 跨 workspace 路由 / 资源紧张的本地 dev

---

## 五、Stage 演进

| Stage | 范围 | 状态 |
|---|---|---|
| **Stage 1** | Mode B headless `qwen serve` + multi-workspace 路由（默认开）+ N session multiplexed + EventBus + first-responder permission + 9 STAGE1_FEATURES | ✅ **MERGED 2026-05-13** (PR#3889) — 注意当前 default 是 advanced multi-workspace，Stage 1.5a 改为 opt-in flag |
| **Stage 1.5a** | chiga0 10 must-haves + **default → single-workspace + `--multi-workspace` opt-in**（与 `qwen --acp` stdio 1:1 心智对齐）| ~2-3 周 |
| **Stage 1.5b** | Mode A `qwen --serve` flag | ~4d |
| **Stage 1.5c** | daemon-side state CRUD（远端 client 功能等价 Mode A）| ~3-5d |
| **Stage 1.5-prereq** | chiga0 6 architecture findings（lift `AcpChannel` / `EventBus` / `PermissionMediator` 到 `@qwen-code/acp-bridge`）—— 顺便收敛代码 `ChannelInfo` ↔ 文档 Workspace Bridge 命名 | ~1-2 周 |
| **Stage 2** | 协议补齐（WebSocket / mDNS / OpenAPI / Prometheus / `/ext`）| ~3-4 周（拆 2a-2d）|
| **Stage 2e** | 可选 native in-process（去 `qwen --acp` child）| ~1-2 周 |

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
