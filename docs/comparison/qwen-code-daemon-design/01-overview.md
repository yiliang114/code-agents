# 01 — 架构总览

> [← 返回 README](./README.md) · [下一篇：现有资产盘点 →](./02-existing-assets.md)

## 一、daemon 模型 vs Qwen 当前的 subprocess 模型

Qwen Code 当前的程序化访问形态：

```
┌─────────────────────┐  spawn  ┌────────────────────────┐
│ SDK 客户端           │────────▶│ qwen CLI 子进程（短生命）│
│ (TS/Python/Java)    │  stdin  │ ├─ ProcessTransport     │
│                     │  stdout │ │  NDJSON 流             │
│                     │         │ └─ core (库调用)         │
└─────────────────────┘         └────────────────────────┘

每次 SDK query() / Client 实例 = 1 个 CLI 子进程
```

引入 daemon 后（1 daemon instance = 1 session；多 session 由外部 orchestrator 管，不在 qwen-code 主线范围）：

```
                                   ┌──────────────────────────────┐
                                   │ Orchestrator（External 实施）  │
                                   │ - sessionScope routing        │
                                   │ - daemon instance discovery   │
                                   │ ⚠️ 项目范围外（参考 §20/§21）  │
                                   └──────────────┬───────────────┘
                                                  │ spawn / route
                                                  ↓
┌─────────────────────┐  HTTP/WS  ┌──────────────────────────────┐
│ SDK 客户端 1         │──────────▶│ daemon instance（绑唯一 session）│
└─────────────────────┘           │ ├─ Express 5 + express-ws     │
                                   │ ├─ EventBus（多 client fan-out）│
┌─────────────────────┐  HTTP/WS  │ ├─ core in-process（库调用）  │
│ Web UI / VSCode     │──────────▶│ │  ├─ Session（唯一）          │
└─────────────────────┘           │ │  ├─ FileReadCache（per-daemon）│
                                   │ │  ├─ Permission flow          │
┌─────────────────────┐  HTTP/WS  │ │  └─ Background tasks         │
│ Channel adapters    │──────────▶│ ├─ LSP server（per-daemon）    │
│ (IM / Telegram)     │           │ └─ MCP servers（per-daemon）   │
└─────────────────────┘           └──────────────────────────────┘
                                       qwen-code 主线 scope
                                       （Stage 1/1.5/2，~3 周 feature complete）

Mode A: daemon instance 同时含本地 TUI 客户端（qwen --serve）
Mode B: daemon instance 无 TUI 全 HTTP（qwen serve）

启动 daemon 一次 → N 个 client 共享同一 session（live collaboration）
多 session = 多 daemon instances（由 External orchestrator spawn / route）
```

## 二、本质差异（与 OpenCode 共识 + Qwen 特色）

### 2.1 与 OpenCode 共识的 4 条原则

| 原则 | OpenCode | Qwen Daemon（本设计）|
|---|---|---|
| daemon 不再 spawn CLI | core 直接 import | 同样 |
| 多 session 模型 | `Map<directory, InstanceContext>`（同进程 N session）| **1 daemon = 1 session**（多 session 由 External orchestrator spawn 多 daemon，不在 qwen-code 主线）|
| `process.cwd()` 不变 | `AsyncLocalStorage` 上下文传播 | 同样但无需 ALS Instance ctx —— daemon 进程本身就是 session ctx（详见 [05-进程模型](./05-process-model.md)）|
| 持久化关键状态 | SQLite + drizzle-orm（`session.sql.ts:SessionTable`）| 主线沿用 JSONL（PR#3739）；SQLite 用于外部 orchestrator 聚合 audit / permission decisions（详见 [§21 持久化栈](./21-orchestrator-multi-tenancy.md#八引入-sqlite-的边界external-phase-1-orchestrator-层)）|

### 2.2 Qwen 独有的 3 条特色

#### 特色 1：复用 ACP NDJSON schema 作为内部 RPC

OpenCode 自创 OpenAPI schema（13525 行 `openapi.json`），Qwen Code 已经有 838 行的 ACP agent 实现完整 NDJSON 协议（`packages/cli/src/acp-integration/acpAgent.ts`）。

**daemon HTTP 路由的请求/响应 body 直接复用 ACP 的 zod schema**：

```ts
// 现有 ACP request:  PromptRequest / NewSessionRequest / SetSessionModelRequest 等
// daemon HTTP body 沿用同结构，仅把传输层从 stdio NDJSON 换成 HTTP

POST /session                  body: NewSessionRequest
POST /session/:id/prompt       body: PromptRequest
POST /session/:id/model        body: SetSessionModelRequest
```

详见 [04-HTTP API 设计](./04-http-api.md)。

**好处**：协议层 0 设计成本（ACP 已经把 session 生命周期、permission 流、cancel、resume、fork 验证过），唯一新增的是传输层桥接。

#### 特色 2：Channels SessionRouter 天然适配多 client

OpenCode 是 daemon 的"单租户"——只有 SDK 客户端连。Qwen Code 的 `packages/channels/base/src/SessionRouter.ts` 已经为多用户 / 多 IM 平台设计：

```ts
// SessionRouter.ts 现有能力
private toSession: Map<string, string>    // routing key → session ID
private toTarget: Map<string, SessionTarget>
private channelScopes: Map<string, SessionScope>  // 'thread' | 'single' | 'user'
```

daemon 模式下，**HTTP/WS 客户端就是另一种 channel**——直接复用 SessionRouter 的多路由能力，IM / WebUI / IDE / SDK 都走同一个路由层。

#### 特色 3：双轨认证（bearer token + 复用 PR#3723 权限流）

OpenCode 用单一 `OPENCODE_SERVER_PASSWORD`（粗粒度访问控制）。Qwen 设计采用**两层权限**：

| 层 | 作用 | 复用 |
|---|---|---|
| **传输层 bearer token** | 阻止未授权访问 daemon | env var + middleware（参考 OpenCode）|
| **应用层 permission flow** | 工具调用是否需要审批 / domain allowlist | **直接复用 PR#3723 的 `evaluatePermissionFlow()`** —— Interactive / Non-Interactive / ACP 三模式已合并，daemon 是第 4 种 |

详见 [07-权限/认证](./07-permission-auth.md)。

## 三、整体架构图

**核心原则**：
- 每个 daemon 进程**只承载唯一一个 session**——daemon 内无 multi-session 路由
- **Mode A（CLI + HttpServer）/ Mode B（Headless Daemon）双部署模式**（[§03 §7](./03-architectural-decisions.md#7-daemon-部署模式clihttpserver-vs-headlesshttpserver)）—— 区别仅在 daemon 进程是否同时承载本地 TUI
- **多 session 由 External orchestrator spawn 多 daemon 实例**（`qwen-coordinator` 角色）—— **不在 qwen-code 主线路线图**，由商业平台 / k8s operator / 云厂商基于 daemon building block 实现，参考 [§20 设计对比](./20-single-vs-multi-session-design.md) / [§21 多租户配额](./21-orchestrator-multi-tenancy.md) / [§04 §8.2 orchestrator API](./04-http-api.md#82-orchestrator-层-apiexternal-reference-architecture)

### 3.1 单 Daemon Instance 内部架构（Mode A / Mode B 共用）

```
┌─────────────────────────────────────────────────────────────────┐
│  qwen daemon instance 进程（1 个 session 绑定）                   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ HTTP / WebSocket 入口（Express 5 + express-ws）            │  │
│  │ ├─ Auth middleware（Mode A 默认 loopback / Mode B bearer） │  │
│  │ ├─ /session/:id/prompt /cancel /events /permission ...    │  │
│  │ └─ SSE / WebSocket 流式事件 + Last-Event-ID 重连            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          ↓                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ HTTP → ACP Adapter（HttpAcpBridge）                       │  │
│  │ - HTTP body ↔ ACP NDJSON 双向桥接                         │  │
│  │ - SessionNotification stream → SSE/WS fan-out             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          ↓                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ EventBus（多 client 协作）                                 │  │
│  │ ├─ in-process subscriber（Mode A 本地 TUI = client #0）    │  │
│  │ ├─ HTTP/SSE subscriber（远端 client：CLI / WebUI / IDE）   │  │
│  │ └─ first-responder permission vote（任何 client 可应答）   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          ↓                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ core（in-process 库调用 · 直接绑唯一 session）              │  │
│  │ - SessionService（PR#3739 transcript-first resume）        │  │
│  │ - FileReadCache（per-daemon · PR#3717+3810 invalidation）  │  │
│  │ - Permission flow（PR#3723 + daemon 第 4 mode）            │  │
│  │ - MCP client manager（PR#3818 coalesce + 30s health check）│  │
│  │ - Background tasks（PR#3471/3488/3642/3791/3836 4 kinds）  │  │
│  │   注：无需 AsyncLocalStorage Instance ctx                │  │
│  │      —— daemon 进程本身就是 session ctx                    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          ↓                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 子进程层（per-daemon · 不再跨 session 共享）                │  │
│  │ - LSP server（1 个 · 此 daemon 的 workspace）              │  │
│  │ - MCP servers（per-daemon · 不与其他 daemon 共享）          │  │
│  │ - PTY / Bash 工具调用（按工具调用粒度）                     │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 多 session 场景：External Orchestrator + 多 Daemon Instances

> **⚠️ 此节描述的 Orchestrator 不在 qwen-code 主线路线图**——是给外部集成方（商业平台 / k8s operator / 云厂商）的设计参考蓝图。qwen-code 主线（Stage 1/1.5/2）只交付 daemon building block；下面的多 session 拓扑由外部基于 [§04 §8.2 Orchestrator API](./04-http-api.md#82-orchestrator-层-apiexternal-reference-architecture) 实现。详见 [§20 设计对比](./20-single-vs-multi-session-design.md) + [§21 多租户配额](./21-orchestrator-multi-tenancy.md) + [§08 External Reference Architecture](./08-roadmap.md#external-reference-architecture参考实现非项目路线图)。

```
┌────────────────────────────────────────────────────────────────────┐
│  External Orchestrator (qwen-coordinator) ⚠️ 项目范围外             │
│  - sessionScope routing: single / user / thread                    │
│  - daemon instance discovery / spawn / cleanup                     │
│  - cross-daemon aggregate API（Web UI 跨 session 聚合视图）         │
│  - daemon pool / warm pool（External SaaS 资源池化优化）        │
└────────────────────┬───────────────────────────────────────────────┘
                     │ spawn / route
       ┌─────────────┼─────────────┬──────────────┐
       ↓             ↓             ↓              ↓
   ┌────────┐    ┌────────┐    ┌────────┐    ┌────────┐
   │daemon-1│    │daemon-2│    │daemon-3│    │daemon-N│  ← qwen-code
   │sess-A  │    │sess-B  │    │sess-C  │    │  ...   │     主线 scope
   │        │    │        │    │        │    │        │
   │ Mode A │    │ Mode B │    │ Mode B │    │        │
   │ (含TUI)│    │(headl) │    │(headl) │    │        │
   │        │    │        │    │        │    │        │
   │ + LSP  │    │ + LSP  │    │ + LSP  │    │ + LSP  │
   │ + MCP  │    │ + MCP  │    │ + MCP  │    │ + MCP  │
   │ + cache│    │ + cache│    │ + cache│    │ + cache│
   └───┬────┘    └───┬────┘    └───┬────┘    └───┬────┘
       │             │             │              │
   ┌───┴─────────────┴─────────────┴──────────────┴───┐
   │  client 层（CLI / WebUI / IDE / IM bot）           │
   │  - client 通过 External orchestrator discovery 找目标 daemon│
   │  - 之后直连 daemon instance HTTP 端口（少一跳）      │
   │  - 同 session 多 client 共享同一 daemon 的 EventBus  │
   └──────────────────────────────────────────────────┘
```

**关键性质**：
- **Daemon instance 内 0 cross-session 复杂度**（qwen-code 主线 scope）——AsyncLocalStorage Instance ctx / Map<workspaceId, Instance> / per-session resource managers 全部不需要
- **进程级隔离免费**——一 daemon crash 只影响其 session，由外部 orchestrator（或 systemd / k8s 等进程管理器）重启
- **资源池化在 External 层做**（External SaaS 资源池化：用户级 LSP daemon / 共享 MCP / 共享 cache）—— N ≥ 50 时再投，单 session 模型 N < 50 已够用

## 四、关键设计决策预告

| # | 决策 | 选择 | 详细 |
|---|---|---|---|
| 1 | session 是否跨 client 共享 | **默认共享同一 daemon instance**；scope 由 External orchestrator 路由 | [03 §1](./03-architectural-decisions.md#1-session-是否跨-client-共享) |
| 2 | 状态进程模型 | **1 Daemon Instance = 1 Session**（与 PR#3889 child-process-per-session 模型一致） | [03 §2](./03-architectural-decisions.md#2-状态进程模型) |
| 3 | MCP server 生命周期 | **per-daemon MCP state** + PR#3818 in-flight coalesce + 30s 健康检查 | [06](./06-mcp-resources.md) |
| 4 | FileReadCache 共享 | **per-daemon** + PR#3717 实现 + PR#3774 prior-read 守卫 + PR#3810 5 路径 invalidation | [06 §2](./06-mcp-resources.md#2-filereadcache-共享策略) |
| 5 | Permission flow | **复用 PR#3723，daemon 是第 4 种 mode + 任何 client 都能应答** | [07](./07-permission-auth.md) |
| 6 | 多 client 并发请求 | **同 session prompt 串行 + 事件 fan-out 多 client 协作观察** | [03 §6](./03-architectural-decisions.md#6-多-client-并发请求) |
| 7 | 部署模式 | **Mode A（CLI + HttpServer）+ Mode B（Headless Daemon + HttpServer）双模式** | [03 §7](./03-architectural-decisions.md#7-daemon-部署模式clihttpserver-vs-headlesshttpserver) |

## 五、最终用户体验

启动 daemon：

```bash
qwen serve                                # 默认 127.0.0.1:5096，无认证（开发场景）
QWEN_SERVER_TOKEN=xxx qwen serve --port 8080 --hostname 0.0.0.0  # 远程访问
```

SDK 用法（无需修改现有 ProcessTransport，新加 HttpTransport）：

```ts
// 现有 SDK Transport 抽象（packages/sdk-typescript/src/transport/Transport.ts）
// 注释已经预告: "HttpTransport: Remote CLI via HTTP (future)"

import { query, HttpTransport } from '@qwen-code/sdk'

const q = query({
  transport: new HttpTransport({
    baseUrl: 'http://localhost:5096',
    bearerToken: process.env.QWEN_SERVER_TOKEN,
    workspaceId: 'my-project',
    cwd: '/path/to/project',
  }),
  prompt: '请帮我重构这个文件',
})

for await (const msg of q) { ... }
```

WebUI 用法：

```ts
// packages/webui 已有 ACPAdapter（packages/webui/src/adapters/ACPAdapter.ts）
// 把传输层从 stdio 切到 HTTP/WS 即可
const adapter = new HttpAcpAdapter({ baseUrl: 'http://localhost:5096', ... })
```

VSCode 用法（替代当前的 ide-server 模式）：

```ts
// 现状：vscode-ide-companion 自己起 ide-server (express)
// 新：vscode-ide-companion 直接连 qwen daemon (HTTP)，省去自起 server
```

Channels（IM / Telegram / 微信）用法：保持不变（ChannelAdapter → AcpBridge → daemon HTTP route，与 stdio 等价）。

## 六、与 OpenCode 设计的核心差异

| 维度 | OpenCode | Qwen Daemon（本设计）|
|---|---|---|
| **HTTP 框架** | Hono | **Express 5（复用 vscode-ide-companion 已有栈）**——不强行对齐；Hono 是 External SaaS 高并发场景的可选项 |
| **Schema 来源** | 自创 OpenAPI（13525 行 codegen）| **复用 ACP NDJSON zod schema** |
| **多 channel 支持** | 仅 SDK / TUI / Web | **SDK / TUI / Web / IM / IDE 全走 SessionRouter** |
| **认证** | 单密码 `OPENCODE_SERVER_PASSWORD` | **bearer token + 应用层 PR#3723 权限流** |
| **mDNS 发现** | ✓ 默认开启 | 🟡 Stage 2 可选（默认关）|
| **session 跨 client 共享** | 否（每 SDK call 独立 session）| **是（默认 single + 事件 fan-out + 跨 client审批）**——live collaboration 模型 |
| **WebSocket** | Bun 原生 | 同款 + SSE 兜底 |

详见 [09-与 OpenCode 详细对比](./09-comparison-with-opencode.md)。

---

下一篇：[02-现有资产盘点 →](./02-existing-assets.md)
