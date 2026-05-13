# 01 — Overview

> [← 返回 README](./README.md) · [下一篇：Design Decisions →](./02-architectural-decisions.md)

## TL;DR

**qwen serve** 是 Qwen Code 的 HTTP daemon 模式——把 ACP NDJSON 协议通过 HTTP+SSE 暴露成可被任何 client / orchestrator 消费的服务。

**核心架构（设计 only 模式）**：

```
1 daemon process = 1 workspace × N sessions multiplexed
```

与 `qwen --acp` stdio **1:1 心智完全对齐**——daemon 把 ACP stdio 包装成 HTTP，不引入 multi-workspace 这层抽象。多 workspace 部署 = 多 daemon process（systemd / docker / k8s 各 1 process 自然管理）。

**关键设计依据**：
- **OS 进程级隔离**：跨 workspace = 跨 daemon process = 跨 OS process（最强隔离）
- **资源 quota 直接对应**：systemd `MemoryMax=` / cgroup / docker `--memory` 直接 = per-workspace quota
- **多 tenant 真隔离**：1 daemon = 1 user × 1 workspace = OS 进程级 1:1 隔离
- **K8s 云原生天然契合**：1 pod = 1 daemon = 1 workspace
- **Blast radius 最小**：daemon crash 只影响 1 workspace
- **心智简单**：不需要 daemon ↔ workspace 两层概念抽象
- **Observability 直接**：`htop` / `ps` 列表 1 OS process = 1 workspace

**两种部署**：
- **Mode A** `qwen --serve` — 本地 TUI + HTTP front 同进程（super-client）
- **Mode B** `qwen serve` — headless HTTP front（远端 client 是 thin shell）

**主线 scope**：daemon building block + 协议表面锁定（Stage 2 后）。多 tenant / 跨 daemon process 路由 / SaaS 部署属 **External Reference Architecture**（外部商业平台实施）。

---

## 一、术语表

> ⚠️ **PR#3889 当前实现状态**（2026-05-13 MERGED）：commit `6a170ef8` 引入了 `byWorkspaceChannel: Map<workspace, ChannelInfo>` multi-workspace 路由，但根据简化原则将通过 follow-up PR 移除——daemon 启动时直接 spawn 单 `qwen --acp` child（绑定启动时 cwd）+ N session multiplexed。

| 术语 | 定义 | 源码 anchor |
|---|---|---|
| **Daemon process** | `qwen serve` 或 `qwen --serve` HTTP front 进程；绑定启动时 cwd = 单 workspace；持 Express 5 server + EventBus + 1 个内嵌 `qwen --acp` child | `packages/cli/src/serve/server.ts` |
| **Session** | ACP `Session` 实例（`QwenAgent.sessions: Map<sessionId, Session>` 内一条）；持 transcript / FileReadCache / PermissionManager | `packages/cli/src/acp-integration/session/Session.ts` |

**核心约束**：
- 1 daemon process **严格 1 workspace**（启动 cwd 绑定）
- 1 daemon process **可持 N sessions**（`QwenAgent.sessions: Map` 多路复用）
- 同 workspace N session 共享 OAuth / FileReadCache / CLAUDE.md / MCP children

> **废弃术语**：
> - "Daemon Instance"（早期 PR#3889 设计中等同 "1 daemon = 1 session"）
> - "Workspace Bridge / ChannelInfo / byWorkspaceChannel"（PR#3889 commit `6a170ef8` 引入的 multi-workspace 路由抽象，将通过 follow-up PR 移除）

---

## 二、架构图

```
qwen serve (1 Daemon process, 绑定 cwd = /work/repo-a)
├─ Express 5 HTTP server + bearer auth + Host allowlist
├─ EventBus（per-session fan-out + ring replay + Last-Event-ID 重连）
└─ qwen --acp child (workspace = /work/repo-a)
   ├─ QwenAgent.sessions: Map → {sess-1, sess-2, sess-3}
   └─ LSP + MCP + FileReadCache（同 workspace N session 共享）
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

跨 workspace 协调（IM bot 多项目 / WebUI 多 workspace 概览 / Mode A 本地 TUI 切项目）由 **client 侧 / orchestrator 侧**做（多 daemon endpoint 发现 + 路由）——daemon 自身只管"当前 workspace"。

External Reference Architecture 提供 orchestrator 层（详 [§06 §五 External Reference Architecture](./06-roadmap.md)）。

---

## 三、双部署模式

| 模式 | 启动命令 | TUI | 适用场景 |
|---|---|---|---|
| **Mode A: CLI + HttpServer** | `qwen --serve [--port N]` | ✅ 本地（super-client）| 单用户终端 + WebUI / IDE / IM bot 同时接入当前 workspace |
| **Mode B: Headless + HttpServer** | `qwen serve [--port N]` | ❌ | 服务器 / 容器 / 远端机器 / K8s pod |

**Mode A 本地 TUI 是 "super-client"**——保留完整 local interaction layer（~15 Ink dialogs + local-jsx slash commands）；wire 只承载 agent↔user conversation axis。

**Mode B 远端 client 是 "thin shell"**（Stage 1）——只能渲染 wire 流，daemon-side state dialogs（`/memory` / `/mcp` / `/agents` 等）不可用。Stage 1.5c daemon-side state CRUD（~3-5d）补齐后远端 client 与 Mode A 本地 TUI 功能对齐。详 [§04 §三 TUI 体验](./04-deployment-and-client.md)。

---

## 四、资源经济性

**同 workspace N session 经济性**（继承 ACP `QwenAgent.sessions: Map` 原生 multi-session）：

| N 同 workspace session | 早期（1 child per session）| 当前（N session 共 1 child）|
|---|---|---|
| 1 | ~60-100 MB RSS | ~60-100 MB RSS（相同）|
| 5 | 300-500 MB RSS | **60-100 MB RSS**（节省 ~5x）|
| 10 | 600-1000 MB RSS | **80-150 MB RSS**（节省 ~6-7x）|
| OAuth refresh | N× 独立 | 1× per daemon |
| FileReadCache | N× 独立 | shared per daemon |
| CLAUDE.md parse | N× | parse 一次 per daemon |
| Cold start（同 daemon 第 N session）| ~1-3s | **<200ms**（attach existing child）|

**多 workspace 部署成本**（M=5 workspace × N=5 session 同机）：

| 维度 | 同机 5 daemon × 1 workspace | 对比：advanced multi（被拒）|
|---|---|---|
| Daemon baseline | 5 × ~30-50MB = **~150-250 MB** | 1 × ~30-50MB = ~30-50 MB |
| 5 workspace × 5 session child | 5 × ~60-100MB = **~300-500 MB** | 5 × ~60-100MB = ~300-500 MB |
| **总内存** | **~450-750 MB** | ~330-550 MB |
| 多花成本 | baseline | ~120-200 MB |
| Blast radius | **单 workspace** | 全部 workspace |
| Quota / observability | OS 进程级直接套 cgroup | 需 daemon 内部抽象 |
| 心智复杂度 | 简单（1 daemon = 1 workspace）| 复杂（daemon ↔ workspace 两层）|
| 路由代码 | 0（启动 cwd 绑定）| ~200+ LOC（`byWorkspaceChannel: Map` 等）|

**Trade-off**：多 daemon 多 ~120-200 MB baseline，换得 OS 进程级隔离 + 直接 cgroup quota + blast radius 最小 + 心智简单——**值得**。

---

## 五、Stage 演进

| Stage | 范围 | 状态 |
|---|---|---|
| **Stage 1** | Mode B headless `qwen serve` + N session multiplexed + EventBus + first-responder permission + 9 STAGE1_FEATURES | ✅ **MERGED 2026-05-13** (PR#3889) — 但当前包含 multi-workspace 路由代码（待 follow-up PR 移除）|
| **Stage 1.5a** | chiga0 10 must-haves + **follow-up PR: 移除 multi-workspace 路由代码**（删 `byWorkspaceChannel: Map` / `getOrCreateChannel` / `ChannelInfo` ~500-700 LOC）| ~2-3 周 |
| **Stage 1.5b** | Mode A `qwen --serve` flag | ~4d |
| **Stage 1.5c** | daemon-side state CRUD（远端 client 功能等价 Mode A）| ~3-5d |
| **Stage 1.5-prereq** | chiga0 6 architecture findings（lift `AcpChannel` / `EventBus` / `PermissionMediator` 到 `@qwen-code/acp-bridge`）| ~1-2 周 |
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
