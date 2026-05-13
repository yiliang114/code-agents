# 03 — HTTP API & Protocol

> [← 上一篇：Design Decisions](./02-architectural-decisions.md) · [下一篇：Deployment & Client →](./04-deployment-and-client.md)

## TL;DR

PR#3889 Stage 1 ✅ MERGED daemon HTTP front 暴露 9 个 STAGE1_FEATURES routes + SSE 事件流 + Last-Event-ID 重连。**协议层 0 设计成本**——HTTP body 直接复用 ACP NDJSON 的 zod schema（不自创 OpenAPI）。SDK 客户端可用 `HttpTransport` 替代 `ProcessTransport`，业务代码 0 改动。

**Stage 1 实现状态**：9/9 STAGE1_FEATURES ✅；SSE Last-Event-ID 重连 ✅；first-responder permission vote ✅。**Stage 1.5 候选**：WebSocket bidi / `loadSession` HTTP / per-request scope override / capability negotiation / daemon-side state CRUD。

---

## 一、路由总览

```
GET    /                                   服务端版本元信息（qwen / daemon / acp 版本号）
GET    /capabilities                       完整能力清单 + 当前绑定状态
GET    /health                             浅层健康检查（仅检测 listener，无认证）
GET    /health?deep=1                      深度健康检查（含 ACP child liveness + EventBus 状态，Stage 2a）
POST   /authenticate                       HTTP-only bearer token 取换 long-lived token

# Session 生命周期（ACP RPC 直接映射）
POST   /session                            create / attach session   ← NewSessionRequest
GET    /session                            list sessions             ← ListSessionsRequest（Stage 1.5）
POST   /session/:id/load                   load existing session     ← LoadSessionRequest（Stage 1.5 must-have #2）
POST   /session/:id/resume                 resume paused session     ← Stage 1.5
DELETE /session/:id                        archive / delete

# Session 交互
POST   /session/:id/prompt                 send prompt               ← PromptRequest
POST   /session/:id/cancel                 cancel current            ← CancelNotification
POST   /session/:id/model                  set model                 ← SetSessionModelRequest
POST   /session/:id/mode                   set mode                  ← SetSessionModeRequest
GET    /session/:id/events                 SSE 事件流
POST   /session/:id/heartbeat              client-initiated 心跳（Stage 1.5 must-have #4）

# Permission 流（first-responder）
POST   /permission/:requestId              vote on permission request

# Workspace（per-bridge state）
GET    /workspace/:id                       workspace info
GET    /workspace/:id/sessions              list sessions on this workspace
GET    /workspace/:id/skills                已加载 skill
GET    /workspace/:id/mcp                   MCP server 状态
GET    /workspace/:id/lsp                   LSP 状态
GET    /workspace/:id/tasks                 background tasks（4 kinds）
GET    /workspace/:id/file                  read file
POST   /workspace/:id/file                  write file（PR#3774 prior-read 守卫）
POST   /workspace/:id/file/edit             edit file
POST   /workspace/:id/pty                   open PTY（Upgrade: websocket）

# Stage 1.5c daemon-side state CRUD（远端 client 等价 Mode A 本地 TUI）
GET    /workspace/:id/memory                read ~/.qwen/memory.json
POST   /workspace/:id/memory                update memory
POST   /workspace/:id/mcp/:server/restart   restart MCP server
GET    /workspace/:id/agents                list agents
POST   /workspace/:id/agents                add / remove agents
POST   /workspace/:id/tools/:name/enable    enable/disable tool
POST   /session/:id/approval-mode           set approval mode
POST   /workspace/:id/init                  workspace init
POST   /session/:id/_meta                   per-session context（Stage 1.5 must-have #8）

# Stage 2a — Protocol Completion
POST   /ext/:method                         ACP extMethod 桥接（给 vendor zero-fork 扩展）
WS     /session/:id                         WebSocket bidi 升级（与 SSE 并存）
```

### `:id` 校验语义（commit `6a170ef8` 后）

- `sessionId` 必须存在于 `byWorkspaceChannel` 内某 bridge 的 `sessionIds` set；不匹配 `404 session_not_found`
- `workspaceId` 必须存在于 `byWorkspaceChannel` map key；不匹配 `404 workspace_not_found`
- 保留 ID 在 URL 是 fail-fast 防御（防 client 拿错 daemon URL）

---

## 二、ACP wire 兼容性 — 4 层矩阵

> 单进程模式（`qwen --acp` stdio NDJSON）与 Daemon 模式（`qwen serve` HTTP）的协议兼容性分析。**结论：Schema 层完全兼容、Wire 层不兼容、SDK 抽象层用户代码 0 改动**。

| 层 | 单进程 | Daemon | 兼容性 |
|---|---|---|---|
| **Schema 层**（ACP zod schema）| `PromptRequest` / `NewSessionRequest` 等 | **复用同一组 ACP zod schema**（`@agentclientprotocol/sdk`）| ✅ **100%** |
| **Wire 层**（传输）| stdio NDJSON | HTTP request/response + SSE/WS 事件流 | ⚠️ 字节级不兼容 |
| **业务逻辑层**（Session.handleXxx）| `Session.handlePromptRequest()` 直接调用 | **同一函数**（daemon 内 wrapper 把 HTTP body 解为 ACP request 后调同一个函数）| ✅ **100% 同源** |
| **SDK 抽象层**（Transport）| `ProcessTransport` | `HttpTransport`（Stage 2b）| ✅ 用户代码 0 改动 |

### 关键非兼容点（4 项）+ Adapter 处理

| 不兼容点 | Adapter 责任 |
|---|---|
| HTTP body ↔ ACP request | 用 zod schema 校验 + 字段映射 |
| SSE event ↔ ACP notification | wrapper 把 `SessionNotification` → SSE `data:` 帧 |
| `permission_request` 同步→异步 | `pendingRequests Map<id, resolver>` + 60s 超时 + 60s 默认 deny |
| Client capabilities（`read_text_file` 等）| client 需注册 callback URL，agent 发 SSE 调 client，client 调 callback HTTP |

### 复用 ACP zod schema 的工程价值

```ts
// 现有 ACP request:  PromptRequest / NewSessionRequest / SetSessionModelRequest 等
// daemon HTTP body 沿用同结构，仅把传输层从 stdio NDJSON 换成 HTTP
POST /session                  body: NewSessionRequest
POST /session/:id/prompt       body: PromptRequest
POST /session/:id/model        body: SetSessionModelRequest
```

**好处**：协议层 0 设计成本（ACP 已经把 session 生命周期、permission 流、cancel、resume、fork 验证过），唯一新增的是传输层桥接。

---

## 三、SSE 事件流（PR#3889 commit `41aa95094` 已实现）

### SSE event 结构

```
event: session_update
id: 42
data: {"id":42,"v":1,"type":"session_update","data":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"…"}},"originatorClientId":"…"}
```

每帧带：
- SSE 标准 `id:` / `event:` 行（EventSource 客户端约定）
- 完整 JSON envelope（`{id?, v, type, data, originatorClientId?}`）—— raw-fetch 消费者也能拿到

### 事件类型枚举

| 类型 | 含义 |
|---|---|
| `session_update` | LLM stream / tool call / tool result / usage 等 ACP `SessionNotification` |
| `permission_request` | agent 请审批（与 wire request id 配对）|
| `permission_resolved` | first-responder 已应答 |
| `permission_already_resolved` | vote loser 收到（Stage 1.5 must-have #5）|
| `model_switched` | model 切换成功 |
| `model_switch_failed` | model 切换失败 |
| `session_died` | bridge `channel.exited` cleanup → 该 workspace 全部 session 死亡 |
| `client_evicted` | 该 subscriber queue overflow，被踢 |
| `slow_client_warning` | overflow 前 soft 警告（Stage 1.5 must-have #7）|

### Last-Event-ID 重连协议

CLI 重连时传 `Last-Event-ID` header：
1. daemon 用 PR#3739 transcript-first fork resume 重建 session 状态（如 daemon restart 过）
2. 从 `Last-Event-ID + 1` 拉 missed events
3. 客户端 UI 无缝续接

**Ring 大小**：default 1000 帧 → 增至 4000（commit `41aa95094`）；Stage 1.5 must-have #6 改为 per-session 可配置（默认 8000）。

### Ring overflow

慢消费 client 队列满 → 发 `client_evicted` event 后从 subscriber set 移除 → daemon 不再积压 memory。Stage 1.5 must-have #7 加 `slow_client_warning` soft 警告。

---

## 四、双向 RPC 的不对称（核心难点）

### ACP 协议本质：双向 RPC

stdio NDJSON 模式下，client 和 agent 双方都能发起 request：

```
Client → Agent: prompt / cancel / setSessionModel ...
Agent → Client: requestPermission / readTextFile / writeTextFile ...
```

### stdio 模式：对称

```
                    bidirectional ACP NDJSON
       Client                                     Agent
       writeLine ─────────────────────────────→
                                                   ← writeLine
       readLine  ←─────────────────────────────
                                                   ← readLine
```

### HTTP 模式：不对称（只 client→daemon）

```
HTTP request: client → daemon （单向）
SSE event:    daemon → client （单向）
HTTP response: daemon → client （同步 client→daemon 的 reply）

但 daemon 没法主动发 HTTP request 到 client！
```

**实际影响**：
- ✅ client→agent: 直接 HTTP request
- ⚠️ agent→client: 改成 SSE event + client callback URL（client 注册自己能接收的 capabilities）
- ⚠️ `permission_request`: 改成 SSE event + client `POST /permission/:requestId` 应答

### `permission_request` 异步流模式

```
1. agent 调用 tool → 触发 permission check
2. PermissionManager → SSE 推 `permission_request` event 到所有订阅 client
3. HTTP request 挂起（pending）
4. 任意 client `POST /permission/:requestId` 应答（first-responder）
5. PermissionManager 收到应答 → 解锁 HTTP request → 继续 tool 执行
6. SSE 推 `permission_resolved` event 让其他 client 知道结果
```

详 [§05 Security & Permission](./05-permission-auth.md)。

---

## 五、Capability negotiation（Stage 1.5 must-have #9 + chiga0 finding 5）

**Stage 1 现状**：`/capabilities` 返回 hard-coded 9-tag 数组——`v: 2` client 接 `v: 1` daemon 时新 frame 类型只能 fall through。

**Stage 1.5+ 修订**：`/capabilities` 加 `protocol_versions` 字段：

```jsonc
GET /capabilities
{
  "v": 1,
  "mode": "http-bridge",
  "features": [/* Stage 1 9 tags + Stage 1.5c 新 tags */],
  "protocol_versions": {                              // 🆕
    "acp": "0.14.x",                                   // ACP wire 版本
    "daemon_envelope": 1                               // SSE envelope schema 版本
  },
  "modelServices": [/* ... */]
}
```

**chiga0 finding 5（Stage 1.5-prereq）**：hard-coded `STAGE1_FEATURES` 数组改为 plug-in capability registry——让 `POST /ext/:method` ACP extMethod 桥接给 vendor zero-fork 扩展（vendor 注册 capability tag → registry → `/capabilities` 自动包括）。

**Stage 1.5c daemon-side state CRUD 注册的新 tags**：

```
'workspace_memory_crud'    'workspace_mcp_management'
'workspace_agents_crud'    'workspace_tools_crud'
'session_approval_mode'    'workspace_init'
'auth_device_flow'
```

远端 client 通过 `GET /capabilities` 协商可用功能集——daemon 不支持的 tag client 优雅降级（gray-out dialog）。

---

## 六、Daemon 层 vs Orchestrator 层

> **Daemon 层** = PR#3889 已落地的主线 routes（§一 + §三 + §四 + §五）。
> **Orchestrator 层** = External Reference Architecture（[§06 §5.1](./06-roadmap.md#51-cross-daemon-orchestrator跨-daemon-process--跨机器)）—— 仅跨 daemon process / 跨机器场景需要。**单机部署完全不需要 orchestrator**。

### Orchestrator API（External，仅跨 daemon process 场景）

```
GET    /coordinator/sessions                       列出所有 active daemon processes
POST   /coordinator/sessions/:id/route             解析 sessionId → daemonUrl
GET    /coordinator/aggregate                      跨 daemon "我所有 task" 聚合
POST   /coordinator/sessions                       create session（orchestrator 路由到 daemon）
```

SDK 加 `coordinatorUrl` 配置项区分两种部署：
- 单机部署（Mode A 或单 daemon Mode B）：跳过 orchestrator 直连 daemon URL
- 跨 daemon process 部署：通过 orchestrator 路由 sessionId → daemonUrl

---

## 七、SDK 用户代码 0 改动

```ts
// 旧（单进程 stdio）
const q = query({ transport: new ProcessTransport(...) })

// 新（daemon HTTP，Stage 2b 落地后）
const q = query({ transport: new HttpTransport({
  baseUrl: 'http://localhost:5096',
  bearerToken: process.env.QWEN_SERVER_TOKEN,
}) })
```

`Transport` 接口不变；业务代码一行不改。

---

## 八、Stage 演进的兼容性

| Stage | 实现方式 | 与 stdio 兼容性 |
|---|---|---|
| **Stage 1**（✅ MERGED 2026-05-13）| daemon 内 `qwen --acp` child + HTTP↔stdio 桥接 | **业务逻辑 100% 同源**——同一个 ACP agent，仅外面包了层 HTTP 翻译 |
| **Stage 1.5b**（Mode A）| TUI + HTTP server 同进程 + in-process EventBus | **业务逻辑同源**——TUI 是 super-client，远端 client 看到的是 strict subset |
| **Stage 1.5c**（daemon-side state CRUD）| 加 6-8 HTTP routes，远端 client 拿 daemon state 读写能力 | 协议扩展，向后兼容（new capabilities via tag）|
| **Stage 2a**（Protocol completion）| WebSocket bidi + /health?deep + /ext/:method | 协议扩展，向后兼容 |
| **Stage 2e**（可选 native in-process）| 去 `qwen --acp` child，daemon 直接 import `QwenAgent` | wire 协议不变，业务逻辑同源 |

---

下一篇：[04 — Deployment & Client →](./04-deployment-and-client.md)
