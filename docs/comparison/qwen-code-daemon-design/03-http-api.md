# 03 — HTTP API 设计

> **🚀 Stage 1 实现状态**（2026-05-07）：本章 daemon 层核心路由全部由 [PR#3889](https://github.com/QwenLM/qwen-code/pull/3889) 实现（commits `61f2f59a1` scaffold + `ca996ecb5` prompt/cancel + `41aa95094` SSE EventBus + `6ee655f0a` permission + `a8ce5e08d` workspace/model）。详见 [§06 Stage 1 实现 audit](./06-roadmap.md#stage-1-pr3889-实现-audit2026-05-07)。

> **API 模型要点**（[§02 §2](./02-architectural-decisions.md#2-状态进程模型) **PR#3889 Stage 1 commit `6a170ef8` channel-per-workspace + N session multiplexed** 架构）：
>
> - **`POST /session`**：默认 `sessionScope: 'single'` 下同 workspace 已有 session 时返回 `attached: true`；concurrent calls 通过 `inFlightChannelSpawns` coalesce 到唯一 channel + 唯一 session（commit `6a170ef8`）。Stage 1.5 must-have #1 落地后支持 body 字段 `{ scope: 'thread' }` 显式新建 session（同 workspace channel 上 multiplex 多 session）
> - **多 daemon 跨 workspace 操作在 orchestrator 层**：`POST /coordinator/sessions/:id/route` 等聚合 API 由 orchestrator 提供；详见本章 §八
> - **Mode A vs Mode B**（[§02 §7](./02-architectural-decisions.md#7-daemon-部署模式clihttpserver-vs-headlesshttpserver)）：两种部署模式的 HTTP API **完全一致**（Mode A 多挂个 in-process TUI subscriber 不影响 wire）
> - **Stage 2e native in-process 路径**：daemon 不再 spawn `qwen --acp` child，直接 import `QwenAgent`；多 client 通过 sessionId path 路由到 daemon 内不同 session（Stage 1 已经如此，只是 wire 进入 child）

> [← 上一篇：6 个架构决策](./02-architectural-decisions.md) · [下一篇：进程模型 →](./04-process-model.md)

> daemon HTTP 路由的核心创新：**复用 ACP NDJSON 的 zod schema** —— body 结构与 `PromptRequest` / `NewSessionRequest` 等 ACP 类型 1:1 对应。

## 一、根路由总览

> **`:id` 校验语义**（PR#3889 Stage 1 commit `6a170ef8` channel-per-workspace 架构）：所有路径中的 `sessionId` 必须存在于 `byWorkspaceChannel` 内某个 channel 的 `sessionIds` set；`workspaceId` 必须存在于 `byWorkspaceChannel` map key。不匹配返回 `404 session_not_found` / `404 workspace_not_found`。保留 ID 在 URL 是为了 fail-fast 防御（防止 client 拿错 daemon URL 时静默写到错误目标）+ 显式 multi-session 路由。

```
GET    /                                   服务端版本元信息（qwen / daemon / acp 版本号）
GET    /capabilities                       完整能力清单 + 当前绑定状态（详见 §七 / §八.3）
GET    /health                             浅层健康检查（仅检测 listener，无认证）
GET    /health?deep=1                      深度健康检查（含 ACP child liveness + EventBus 状态，Stage 2+）
POST   /authenticate                       (HTTP-only) bearer token 取换 long-lived token

# ACP 扩展协议桥接（Stage 2+ · 给 vendor zero-fork 扩展点）
POST   /ext/:method                        ACP extMethod 桥接  ← ExtMethodRequest
GET    /session/:id/events?include=ext     SSE 加 extNotification channel

# Session 生命周期（直接映射 ACP RPC；Stage 1 下幂等返回 bound，Stage 2 in-process 下真正 create new）
POST   /session                            get-or-create bound session   ← NewSessionRequest
GET    /session/:id                        session info（id 必须 = bound session）
POST   /session/:id/load                   load session（仅 daemon 未绑定时可用）  ← LoadSessionRequest
DELETE /session/:id                        archive / delete（等价 daemon shutdown）

# 与 session 交互
POST   /session/:id/prompt                 send prompt       ← PromptRequest
POST   /session/:id/cancel                 cancel current    ← CancelNotification
POST   /session/:id/model                  set model         ← SetSessionModelRequest
POST   /session/:id/mode                   set mode          ← SetSessionModeRequest
POST   /session/:id/config                 set config option ← SetSessionConfigOptionRequest

# 流式事件（核心 — daemon 与 stdio ACP 的唯一传输层差异）
GET    /session/:id/events                 SSE / WebSocket   ← SessionNotification[]
                                            (Upgrade: websocket 走 WS，否则 SSE)

# 权限审批（HTTP 异步流模式 · session-scoped）
POST   /session/:id/permission/:requestId  respond to permission_request

# Workspace 管理（daemon 启动时绑定 1 个 workspace；多 workspace 由 External orchestrator spawn 多 daemon）
POST   /workspace                          注册 workspace  body: { directory }（仅 daemon 未绑定时；已绑定幂等返回）
GET    /workspace/:id                      workspace info（id 必须 = bound workspace）
DELETE /workspace/:id                      dispose（等价于 daemon shutdown）

# 工具能力查询（id 必须 = bound workspace）
GET    /workspace/:id/skills               已加载 skill 列表
GET    /workspace/:id/mcp                  已连接 MCP server 列表
GET    /workspace/:id/lsp                  LSP server 状态

# 后台任务（PR#3471/3488/3642/3791/3836 4 kinds 暴露）
GET    /workspace/:id/tasks                list background tasks（agent / shell / monitor / dream）
POST   /workspace/:id/tasks/:taskId/cancel cancel task     ← task_stop tool 的 HTTP 入口

# 文件操作
GET    /workspace/:id/file?path=...        read file
POST   /workspace/:id/file                 write file (受 PR#3774 prior-read 守卫，需先 read)
POST   /workspace/:id/file/edit            edit file (同上)

# 终端 / Bash（PTY）
POST   /workspace/:id/pty                  open PTY (Upgrade: websocket)

# Skill 管理
POST   /workspace/:id/skills/reload        reload skill registry（与 GET /skills 同 plural namespace）
```

## 二、请求 / 响应 schema 设计

### 核心原则：**复用 ACP zod schema**

Qwen Code 的 ACP agent（`packages/cli/src/acp-integration/acpAgent.ts`）已经导入 `@agentclientprotocol/sdk` 的所有 RequestType。**daemon 路由直接用同一组 zod schema 作为请求 body 校验**：

```ts
// daemon HTTP route handler（默认 Express 5，复用 vscode-ide-companion 已有的栈）
import {
  PromptRequest,         // 已有
  NewSessionRequest,     // 已有
  CancelNotification,    // 已有
  SetSessionModelRequest,// 已有
  ...
} from '@agentclientprotocol/sdk'
import { z } from 'zod'

// zod 校验中间件（小工具函数，~10 行）
const validate = (schema: z.ZodSchema) => (req, res, next) => {
  const result = schema.safeParse(req.body)
  if (!result.success) return res.status(400).json({ error: result.error })
  req.validated = result.data
  next()
}

app.post('/session/:id/prompt',
  validate(PromptRequest),
  async (req, res) => {
    const session = getSession(req.params.id)
    const response = await session.handlePrompt(req.validated)  // 复用现有 ACP 逻辑
    res.json(response)            // PromptResponse
  }
)
```

> **HTTP 框架选择**：默认推荐 **Express 5**（复用 vscode-ide-companion 已有依赖，0 新包）。Hono 是 External SaaS 高并发场景的可选项（与 OpenCode 对齐 + Bun.serve 一线支持），但 MVP 不必要——Express 5 + zod 校验 ~10 行包装即可。详见决策评估部分。

**意义**：协议 schema 0 设计成本——与 ACP agent 共用一份 zod schema，daemon route handler 与 ACP `Session.handleXxx()` 共用同一组业务函数。

### Daemon 特有的扩展字段

少数 HTTP 特有字段需要新增 schema：

```ts
// 新增 schema（daemon 特有）
const DaemonSessionMeta = z.object({
  workspaceId: z.string(),                 // daemon 绑定的 workspace 标识（fail-fast 校验，详见 §一）
  cwd: z.string().optional(),              // 显式 cwd（覆盖 workspace 默认）
  clientId: z.string().optional(),         // 多 client 标识
  // 注：scope（'thread' / 'single' / 'user'）在 orchestrator 层（coordinator.sessionScope，§02 §1），不在 daemon body
})

const DaemonNewSessionRequest = NewSessionRequest.extend({
  meta: DaemonSessionMeta,
})
```

## 三、SSE / WebSocket 事件流（核心）

> **Stage 划分**：SSE 是 **Stage 1（PR#3889 已实现）** 的默认事件传输；WebSocket bidi 升级是 [Stage 2 工作](./06-roadmap.md#stage-2daemon-完善拆分-2a-2d3-4-周总计)（与 mDNS / OpenAPI / 多 token / Prometheus 同批），Stage 1 不含。

### 选择：默认 SSE，Stage 2 升级 WebSocket

```
GET /session/:id/events
Accept: text/event-stream         → 用 SSE
Upgrade: websocket                 → 用 WebSocket
```

**SSE 优势**：HTTP/2 友好、自动重连（client 用 EventSource API）、防火墙透明。
**WebSocket 优势**：双向通信（permission response / interrupt 可同 channel 发回，免单独 POST 路由）。

### WebSocket 库选型（Express 5 + `express-ws` 默认）

Express 5 不内置 WebSocket，需挂第三方库。两种方案：

| 维度 | **`express-ws`（默认推荐）** | `ws` 直挂 `http.Server` |
|---|---|---|
| 包装方式 | wraps Express app，`app.ws('/path', handler)` 风格 | `new WebSocketServer({ server: httpServer })` |
| 路由集成 | ✓ 与 Express 路由统一 | ✗ 路径匹配自己写 |
| **Middleware 复用** | ✓ Express middleware（Bearer / CORS / Origin lock）自动跑 | ✗ upgrade 请求需手动校验 |
| Upgrade handshake 控制 | 黑盒 | 完全可控 |
| 包大小 | +~50KB（含底层 `ws`）| +~50KB（仅 `ws`）|
| 生态 / 维护 | 中（社区）| 高（核心库，几乎所有 Node WS 实现底层都是 `ws`）|

**默认推荐 `express-ws`**——理由：
- vscode-ide-companion 已有的 Bearer + Origin lock middleware（`ide-server.ts:185-200`）直接复用到 ws 路由，0 额外代码
- 语法 `app.ws('/session/:id/events', handler)` 与 `app.get` 同款，降低团队学习成本
- middleware 自动校验 → 不会出现"忘了在 upgrade handler 里校验 Bearer"的安全 bug

**例外用 `ws` 直挂**：
- 需要严格控制 upgrade handshake（如 protocol negotiation / subprotocols）
- 需要在升级前做 expensive 校验（rate limit / 大 body 校验）
- External SaaS 切到 Hono 时（Hono 用 Bun.serve 原生 createBunWebSocket，不再需 express-ws）

代码样例：

```ts
// Express 5 + express-ws (默认)
import express from 'express'
import expressWs from 'express-ws'

const { app } = expressWs(express())
app.use(authMiddleware)         // Bearer / Origin lock 自动跑
app.use(corsMiddleware)

app.ws('/session/:id/events', (ws, req) => {
  const session = getSession(req.params.id)
  const unsubscribe = session.subscribe((event) => ws.send(JSON.stringify(event)))
  ws.on('close', unsubscribe)
})
```

### 事件 schema 复用 ACP `SessionNotification`

```ts
// SessionNotification 是 ACP 的现成类型
export interface SessionNotification {
  type: 'message_part' | 'tool_call' | 'tool_result' | 'permission_request' |
        'task_progress' | 'subagent_event' | ...
  ...
}

// SSE 帧
data: {"type":"message_part","content":"..."}\n\n
data: {"type":"tool_call","name":"Bash","args":{...}}\n\n
data: {"type":"permission_request","requestId":"abc","tool":"Bash","args":{...}}\n\n
```

### Permission request 的双向交互

```
client → daemon: POST /session/:id/prompt
daemon → client: SSE { type: 'tool_call', name: 'Bash', ... }
                 SSE { type: 'permission_request', requestId: 'r1', ... }
                 (HTTP request 挂起等 client 响应)

client → daemon: POST /session/:id/permission/r1  body: { allow: true, alwaysAllow: false }
daemon → client: SSE { type: 'tool_result', ... }
                 SSE { type: 'message_part', content: '...' }
                 (response body 是 PromptResponse)
```

### SSE Last-Event-ID 重连协议

PR#3889 已实现 [HTML5 EventSource](https://html.spec.whatwg.org/multipage/server-sent-events.html) `Last-Event-ID` 标准——每帧带单调递增 `id`，客户端断线后用 `Last-Event-ID` header 重连，daemon 重放 missed events：

```
id: 12345
event: message_part
data: {"type":"text","content":"..."}

id: 12346
event: tool_call_request
data: {"tool":"Bash","args":{"cmd":"ls"}}
```

> Event id 格式：**纯十进制数字**（PR#3889 commit `ad0e6ec06` `parseLastEventId to pure decimal digits` audit 收紧），与 transcript 行号 1:1 对应。

```http
GET /session/:id/events HTTP/1.1
Last-Event-ID: 12345
```

```ts
// daemon 端：用 transcript 行号当 event id（复用 PR#3739 持久化，无需额外 event store）
app.get('/session/:id/events', async (req, res) => {
  const lastEventId = req.header('Last-Event-ID')
  if (lastEventId) {
    const transcript = await loadTranscript(sessionId)
    const startIdx = transcript.findIndex(e => e.id === lastEventId) + 1
    for (const evt of transcript.slice(startIdx)) sendSse(res, evt)
  }
  session.subscribe(evt => sendSse(res, evt))   // EventBus 实时 fan-out
})
```

| 关键点 | 说明 |
|---|---|
| event id = transcript 行号 | 复用 PR#3739 transcript 持久化，无需额外 event store |
| TTL 重放窗口 | 仅保留最近 24h（旧 session 不无限 replay）|
| Back-pressure | client 慢消费 → daemon buffer 满 → 主动断连 + 让 client 重连 |
| 跨 daemon 重连 | 不支持——sessionId 绑定 daemon instance；orchestrator 路由保证 client 连回原 daemon |

## 四、典型请求/响应示例

### 4.1 创建 session + 发 prompt

```http
POST /workspace HTTP/1.1
Authorization: Bearer xxx
Content-Type: application/json

{ "directory": "/work/my-project" }

→ 200 OK
{ "workspaceId": "ws-abc123" }
```

```http
POST /session HTTP/1.1
Authorization: Bearer xxx
Content-Type: application/json

{
  "meta": { "workspaceId": "ws-abc123" },
  "clientCapabilities": { "fs": { "readTextFile": true } },
  "mcpServers": [...]
}

→ 200 OK (NewSessionResponse)
{ "sessionId": "sess-xyz" }
```

```http
POST /session/sess-xyz/prompt HTTP/1.1
Authorization: Bearer xxx
Content-Type: application/json

{ "prompt": [{ "type": "text", "text": "请重构这个函数" }] }

(同时 client 打开 GET /session/sess-xyz/events SSE 长连接监听)

# /prompt HTTP request 长挂起；SSE 通道持续推送事件:
← SSE event_stream:
data: {"type":"message_part","content":"我来帮..."}

data: {"type":"tool_call","name":"ReadFile","args":{"path":"src/foo.ts"}}

data: {"type":"tool_result","name":"ReadFile","output":"..."}

...

# /prompt request 在 turn 结束后返回 PromptResponse:
→ 200 OK PromptResponse
{ "stopReason": "end_turn", "tokenUsage": {...} }
```

### 4.2 加载历史 session

> **前置**：仅适用于 daemon 启动后**未绑定 session** 时（典型场景：orchestrator 决定新 daemon 复用历史 sessionId 时调用）。已绑定 session 的 daemon 调用此接口返回 `409 already_bound`（§5）。

```http
POST /session/sess-yesterday/load HTTP/1.1

(无 body，或带 maxMessages 等过滤)

→ 200 OK (LoadSessionResponse)
{
  "messages": [...],          // transcript replay
  "currentMode": "edit",
  "currentModel": "qwen3-max",
  "tasks": [...]              // 4 kinds (agent/shell/monitor/dream) running
}
```

### 4.3 多 client 同 daemon live collaboration

**Stage 1 (commit `6a170ef8`)**：默认 `sessionScope: 'single'` 下同 workspace 多 client `POST /session` 自动 attach 到同一 channel 的同一 session——daemon 通过 `byWorkspaceChannel` 找到 existing channel + ACP `sessions: Map` 找到 existing session，返回 `attached: true`。Stage 1.5 must-have #1 落地后 client 可显式传 `{ scope: 'thread' }` 在同 channel 上新建 session（仍多路复用同 `qwen --acp` child）。

`GET /session/:id/events` 通过 sessionId path 显式选择 session；同 sessionId 多个 client 通过 EventBus fan-out 共享 live collaboration 流（语义不变，只是 session 路由通过 URL 显式）。

```
[CLI]: 启动 daemon（绑定 cwd=/work/repo-a）
       qwen → POST /session { meta: { workspaceId: 'ws-a' } }
       → 200 OK { sessionId: 'sess-foo', attached: false }   ← 首次创建
       开始 prompt: "请重构 src/foo.ts"

[VSCode 同时连同一 daemon URL]:
       POST /session { meta: { workspaceId: 'ws-a' } }
       → 200 OK { sessionId: 'sess-foo', attached: true }    ← 幂等返回 bound
       
       GET /session/sess-foo/events（SSE 接入）
       VSCode 实时看到 CLI 触发的 message_part / tool_call / tool_result
       
[Web UI 同时连同一 daemon URL]: 同上 → 也看到 sess-foo 实时事件流

→ Agent 决定调 Bash 跑 npm test，触发 permission_request
  CLI / VSCode / Web UI 三个 client 都通过 SSE 收到事件
  用户在 Web UI 上点 "Allow"
  → POST /session/sess-foo/permission/r1 { allow: true }
  → daemon SSE 广播 "permission_resolved by client-webui-1" 给所有 client
  → CLI / VSCode 自动关闭弹窗
  → Bash 工具继续执行
```

### 4.4 跨 daemon 续行（多 session 场景）

不同 daemon instance 之间互相不可见——跨 channel / 跨设备续行属于 **orchestrator 层**职责（`coordinator.sessionScope: 'single' / 'user' / 'thread'` 决定如何把 sessionId 路由到对应 daemon）。详见 [§02 §1](./02-architectural-decisions.md#1-session-是否跨-client-共享) + [§14 Orchestrator 多租户与配额](./14-orchestrator-multi-tenancy.md)。

主要场景：
- **同 user 跨设备**（手机 → 电脑）：orchestrator `scope: 'user'` 路由到同一 daemon instance（按 userId）
- **跨 channel**（IM bot → CLI）：client 显式拿 sessionId → `POST /coordinator/sessions/:id/route` 解析 daemonUrl → 直连
- **冷续行**（daemon 已 idle 退出）：`POST /session/:id/load` 在新 daemon 中从 transcript JSONL 重建

## 五、错误码与状态码

| HTTP code | 含义 | 对应 ACP error code |
|---|---|---|
| 401 | bearer token 缺失/错误 | — |
| 403 | workspace 越权 / permission denied | — |
| 404 | sessionId / workspaceId 不匹配 daemon 当前绑定 | `session_not_bound` / `workspace_not_bound` |
| 409 | `POST /session/:id/load` 但 daemon 已绑 session（不能 swap）| `already_bound` |
| 409 | daemon 已绑 session，不能再 `POST /session/:id/load` | `already_bound` |
| 422 | request body schema 校验失败 | — |
| 429 | rate limit | — |
| 500 | core internal error | `errorCodes.INTERNAL_ERROR` |
| 504 | LLM upstream timeout | `errorCodes.UPSTREAM_TIMEOUT` |

`packages/cli/src/acp-integration/errorCodes.ts` 已定义 ACP 错误码，daemon 加 HTTP code 映射即可。

## 六、OpenAPI 自动生成（Stage 2）

从 zod schema 自动生成 OpenAPI 3.0 spec：

```ts
// Express + zod-to-openapi
import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi'

const registry = new OpenAPIRegistry()
registry.registerPath({
  method: 'post',
  path: '/session/:id/prompt',
  request: { body: { content: { 'application/json': { schema: PromptRequest } } } },
  responses: { 200: { description: 'OK', content: { 'application/json': { schema: PromptResponse } } } },
})

const generator = new OpenApiGeneratorV3(registry.definitions)
const spec = generator.generateDocument({ openapi: '3.0.0', info: { title: 'Qwen daemon', version: '1.0' } })

app.get('/openapi.json', (req, res) => res.json(spec))
```

> 如果切到 Hono（External SaaS 高并发场景），可改用 `hono-openapi`，更紧凑但功能等价。

SDK 客户端可以从 `/openapi.json` codegen 出 typed HTTP client（参考 OpenCode `@opencode-ai/sdk` 的做法）——但 Qwen 也可以选**手写 SDK 客户端**（更精准控制，复用 ACP zod 类型），不强制 codegen。

## 七、版本与向后兼容

`GET /` 返回最小版本元信息（用于 client 快速 probe）：

```
GET / HTTP/1.1
→ 200 OK
{
  "qwen": "0.16.0",              // qwen-code package version
  "daemon": "1",                  // daemon API major version
  "acp": "0.14"                   // ACP protocol version (ACP_PROTOCOL_VERSION)
}
```

完整能力清单（含当前绑定状态、tags、orchestrator URL 等）由 `GET /capabilities` 返回——schema 详见 [§八.3 Capability envelope](#83-capability-envelope)。

- **daemon API 版本独立于 qwen 包版本** —— 允许 qwen 包升级时不破坏 SDK 客户端
- **ACP 协议版本透传** —— 与底层 ACP 库版本一致（当前 0.14）

---

## 七·五、`/health` 深度探测协议（Stage 2+）

> chiga0 [PR#3889 external review](https://github.com/QwenLM/qwen-code/pull/3889) 指出：Stage 1 `/health` 仅返回 200 判断 listener 在线，**不探测 ACP child liveness**——k8s rolling deploy / Docker health checks 会把 zombie daemon（child 已挂）看成 healthy。Stage 2+ 加 `/health?deep=1` 解决。

### 7.5.1 浅层 vs 深度对比

| 维度 | `GET /health`（Stage 1）| `GET /health?deep=1`（Stage 2+）|
|---|---|---|
| 检测层级 | listener 在线 | listener + ACP child + EventBus |
| 延迟 | < 1ms | ~10-50ms（含 child IPC ping）|
| 调用频率 | 高频（k8s liveness probe / Docker healthcheck）| 低频（外部监控 / 告警）|
| 认证 | 无 | 无（避免依赖 auth 路径）|

### 7.5.2 深度响应 schema

```jsonc
GET /health?deep=1 HTTP/1.1
→ 200 OK
{
  "status": "healthy",                    // healthy / degraded / unhealthy
  "listener": {
    "uptime_ms": 12345,
    "bound": "127.0.0.1:7776"
  },
  "acp_child": {                           // 仅 deep=1 时返回
    "pid": 23456,
    "alive": true,                         // ping ACP NDJSON stdio
    "last_ping_ms": 5,                     // child ack 时延
    "session_bound": "sess-abc",
    "init_ts": "2026-05-12T08:00:00Z"
  },
  "eventbus": {
    "active_subscribers": 3,
    "ring_buffer_size": 1000,
    "ring_buffer_used": 47,
    "evicted_count": 0                     // bounded queue 累计 evict
  }
}

→ 503 Service Unavailable（child crashed / EventBus broken）
{ "status": "unhealthy", "reason": "acp_child_dead", "acp_child": { "alive": false, ... } }
```

### 7.5.3 与 k8s liveness 协议对齐

```yaml
# k8s pod spec
livenessProbe:
  httpGet:
    path: /health             # Stage 1 浅层 — 高频
    port: 7776
  periodSeconds: 5
  failureThreshold: 3
readinessProbe:
  httpGet:
    path: /health?deep=1      # 深度 — 低频确认 child healthy
    port: 7776
  periodSeconds: 30
  failureThreshold: 2
```

---

## 七·六、ACP `extMethod` / `extNotification` HTTP 桥接（Stage 2+）

> chiga0 [PR#3889 external review](https://github.com/QwenLM/qwen-code/pull/3889) 指出 Stage 1 daemon **不桥接 ACP `extMethod`**——任何 daemon 不原生支持的能力 vendor 必须 fork qwen-code。Stage 2+ 加 `POST /ext/:method` 给 vendor 零 fork 扩展点。

### 7.6.1 ACP extMethod 简介

ACP 协议规定 `extMethod` 是 RPC-style 扩展点，`extNotification` 是 push-style 扩展点。两者由 ACP SDK 通过 NDJSON channel 透明转发。daemon 化时这两个 channel 之前没有 HTTP 暴露。

### 7.6.2 `POST /ext/:method` 桥接

```http
POST /ext/dashscope.queryQuota HTTP/1.1
Authorization: Bearer ...
Content-Type: application/json

{
  "params": { "month": "2026-05" }
}

→ 200 OK
{
  "result": { "quota": 1000000, "used": 234567 },
  "error": null
}
```

daemon route handler 把 `:method` + body 包装为 `ExtMethodRequest` 发给 ACP child，等 response 返回 HTTP。**完全透传**——daemon 不感知具体 method 语义。

### 7.6.3 SSE 加 ext notification channel

```
GET /session/:id/events?include=ext HTTP/1.1
Accept: text/event-stream

event: ext_notification
id: 12345
data: {"method":"dashscope.quotaWarning","params":{"remaining":50000}}
```

`?include=ext` query 参数显式 opt-in（默认 SSE 流不含 ext channel，避免 client 处理未知 event 类型）。

### 7.6.4 与 Stage 1 capability 协议的区分

| 维度 | `POST /session/:id/permission/:reqId`（Stage 1）| `POST /ext/:method`（Stage 2+）|
|---|---|---|
| 用途 | 工具调用授权（first-responder 应答）| 任意 ACP 扩展方法 |
| 方向 | daemon → client request；client → daemon response | client → daemon request；daemon → child 透传 |
| schema 范围 | 固定（permission_request schema）| 开放（`extMethod` 由 vendor 定义）|
| daemon 实现复杂度 | 内置 | 仅透传 + ts 化签名 |

---

## 八、API 总览：Daemon 层 vs Orchestrator 层

> **PR#3889 Stage 1 commit `6a170ef8` channel-per-workspace + N session multiplexed** 模型下（[§02 §2](./02-architectural-decisions.md#2-状态进程模型) + [§13 设计对比](./13-single-vs-multi-session-design.md)），HTTP API 分两层：**daemon 层**（PR#3889 OPEN，主线）+ **orchestrator 层**（External Reference Architecture，由外部实施）。
>
> **Stage 2e native in-process** 下两层结构不变，只是 daemon 层去除 `qwen --acp` child 桥接（直接 import `QwenAgent`），orchestrator 层职责保持（仍需跨 daemon process / 跨 workspace 聚合）。

### 8.1 Daemon 层路由（主线）

PR#3889 已实现的全部 daemon 层路由保留 wire 格式 / body schema 不变。单 session 模型下的语义概要（详细路由清单见 [§一 根路由总览](#一根路由总览)）：

| 路由分组 | 单 session 模型下语义 |
|---|---|
| `POST /session` | 幂等返回 daemon 启动时绑定的 sessionId |
| `POST /session/:id/{prompt,cancel,model,mode,config}` | id 必须 = bound session，否则 `404 session_not_bound` |
| `GET /session/:id/events` | SSE / WebSocket 事件流（id 同上校验）|
| `POST /session/:id/permission/:requestId` | session-scoped permission 应答（id 同上校验）|
| `POST /session/:id/load`（resume）| 仅 daemon 未绑 session 时可用，否则 `409 already_bound` |
| `POST /workspace`（注册）| 幂等返回 daemon 启动时绑定的 workspaceId |
| `GET /workspace/:id/{skills,mcp,lsp,tasks,file,pty,...}` | id 必须 = bound workspace |
| `GET /` | 最小版本元信息（qwen / daemon / acp 版本）|
| `GET /capabilities` | 完整 capability envelope（含 `mode` / `boundSessionId` / `deploymentMode` / tags）|
| `GET /health` | 含 `boundSession` / `idleSince` 字段 |

**关键设计决策：保留 sessionId / workspaceId 在 URL**——做 client-side fail-fast 校验，防止 client 拿错 daemon URL 时静默写到错误目标。**不要**改成 ID 隐式（看似清爽但失去防御）。

### 8.2 Orchestrator 层 API（External Reference Architecture）

> 以下 API **不在 qwen-code 主线路线图**中（[§06](./06-roadmap.md#external-reference-architecture参考实现非项目路线图)）——是给外部集成方（商业平台 / k8s operator）的设计参考蓝图。多 session 场景下 client 需要"先找到哪个 daemon、再连过去"，由 orchestrator 实现。

| 路由 | 用途 | 优先级（外部实施） |
|---|---|---|
| `POST /coordinator/sessions` | 创建 session（隐含 spawn 新 daemon）+ 返回 `{ sessionId, daemonUrl, token }` | 必需 |
| `GET /coordinator/sessions` | 列出所有 active daemon instances | 必需 |
| `GET /coordinator/sessions/:id` | 查 session metadata + 当前 daemonUrl | 必需 |
| `DELETE /coordinator/sessions/:id` | 终止 session（kill daemon）| 必需 |
| `POST /coordinator/sessions/:id/route` | discovery：sessionId → daemonUrl | 必需 |
| `GET /coordinator/sessions/:id/aggregate` | cross-daemon 聚合（如"我所有 background tasks"）| 推荐 |
| `GET /coordinator/health` | 全部 daemon pool 健康状态 | 推荐 |
| `POST /coordinator/sessions/scope` | 路由策略 `single` / `user` / `thread` | 推荐 |

**Orchestrator API base URL** 由 `coordinator.baseUrl` 配置（独立于 daemon URL）。Mode A（CLI + HttpServer）单用户场景 **不需要 orchestrator**——直接连 daemon URL（`qwen --serve` 启动时打印的端口）。Orchestrator 仅在多 session 部署（多 daemon 实例）时启用——单 daemon Mode B 部署 client 直连即可。

#### `POST /coordinator/sessions` 示例

```http
POST /coordinator/sessions HTTP/1.1
Authorization: Bearer <coordinator-token>
Content-Type: application/json

{
  "workspaceUri": "file:///work/repo-a",
  "scope": "single",                  // orchestrator 路由策略（§02 §1 coordinator.sessionScope）
  "preserveTranscript": true,         // orchestrator-side hint：spawn 新 daemon 时是否复用旧 transcript（speculative，由 orchestrator 实施方决定）
  "meta": { "userId": "u-123", "channel": "cli" }
}

→ 201 Created
{
  "sessionId": "sess-abc123",
  "daemonUrl": "http://127.0.0.1:7776",
  "daemonToken": "bearer-xyz789",      // 给 client 直连 daemon 用
  "spawned": true,                     // 是新 spawn 还是复用现有 daemon
  "deploymentMode": "mode-b-headless"   // 部署形态（与 §8.3 capability envelope 同名字段对齐；架构标识用 capabilities.mode = 'single-session-daemon'）
}
```

Client 拿到后 **不再走 orchestrator**——直接用 `daemonUrl + daemonToken` 接入 daemon HTTP API。

#### `POST /coordinator/sessions/:id/route` 示例

```http
POST /coordinator/sessions/sess-abc123/route HTTP/1.1
Authorization: Bearer <coordinator-token>

→ 200 OK
{
  "sessionId": "sess-abc123",
  "daemonUrl": "http://127.0.0.1:7776",
  "daemonToken": "bearer-xyz789",
  "boundSince": "2026-05-09T10:23:45Z"
}
```

用于 SDK 重连（拿现有 sessionId → 解析当前 daemonUrl）；orchestrator 维护 `sessionId → daemonUrl` 映射。

### 8.3 Capability envelope

`GET /capabilities` 完整响应 schema（向后兼容字段加法策略，老 client 忽略未知字段）：

```jsonc
{
  "qwen": "0.16.0",                          // qwen-code package version（与 GET / 一致）
  "daemon": "1",                              // daemon API major version（与 GET / 一致）
  "acp": "0.14",                              // ACP protocol version
  "mode": "single-session-daemon",            // daemon 架构模式（区别于 multi-session OpenCode）
  "deploymentMode": "mode-a-cli",             // 部署形态：mode-a-cli / mode-b-headless
  "boundSessionId": "sess-abc123",            // daemon 当前绑定 session（启动后绑定）
  "boundWorkspace": "/work/repo-a",           // daemon 当前绑定 workspace
  "supportsBindSwap": false,                  // 不支持替换 session（PR#3889 现状）
  "orchestratorUrl": "http://localhost:7700", // 仅经 orchestrator 路由时返回
  "features": [                                // PR#3889 STAGE1_FEATURES（9 项 feature tag，client 按此 gate UI）
    "health", "capabilities", "session_create", "session_list",
    "session_prompt", "session_cancel", "session_events",
    "session_set_model", "permission_vote"
  ],
  "tags": [                                    // 技术栈 / 实现细节标签
    "single-session", "process-isolation",
    "express-5", "ws", "sse", "ndjson",
    "bearer-auth", "host-allowlist",
    "permission-vote", "first-responder",
    "lastevent-replay"
  ]
}
```

Client（SDK / WebUI / IDE）通过 `mode === 'single-session-daemon'` 决定：
- 不再调 `POST /session` 多次创建（会返回现有 / 409）
- 看到 daemon URL 时直接用，不需要 multi-session router

### 8.4 Client SDK 接入策略

| Client 行为 | 单机 / Mode A | 多 session / Mode B + orchestrator |
|---|---|---|
| **创建 session** | `POST daemonUrl/session` 直接创建（幂等返回现有）| **调 orchestrator**：`POST /coordinator/sessions` 拿 daemonUrl + token |
| **连接已有 session** | 已知 daemonUrl → `daemonUrl/session/:id/events` | 已知 sessionId → `GET /coordinator/sessions/:id/route` 拿 daemonUrl，再连 |
| **多 client 同 session** | 同 daemonUrl 多次 attach（live collaboration）| 同 daemonUrl 多次 attach |

**SDK 加 `coordinatorUrl` 配置项**：
- 未配置 → 直连 daemon（兼容 PR#3889 现有用法）
- 已配置 → 走 orchestrator 路由（多 session 场景）

```ts
// SDK 用法
import { DaemonClient } from '@qwen-code/sdk-typescript'

// 场景 1: 直连（Mode A 或已知 daemon URL）
const client = new DaemonClient({
  daemonUrl: 'http://127.0.0.1:7776',
  daemonToken: '<token>',
})

// 场景 2: 经 orchestrator
const client = new DaemonClient({
  coordinatorUrl: 'http://orchestrator.internal:7700',
  coordinatorToken: '<coord-token>',
})
const session = await client.createSession({ workspaceUri, scope: 'single' })
// SDK 内部已连接到正确的 daemon URL
```

### 8.5 兼容性保证

| 项 | 设计 |
|---|---|
| PR#3889 SDK / WebUI 直连 daemon | ✅ 所有路由保留 |
| `POST /session` 多次调用 | 幂等返回当前绑定的 session（多 session 走 orchestrator）|
| `POST /coordinator/*` 路由 | External Reference Architecture，与 daemon 层正交 |
| `GET /capabilities` 字段 | 字段加法策略，老 client 忽略未知字段 |
| sessionId 在 URL 中 | 保留作 fail-fast 校验 |
| daemon API 版本号 | `daemon: "1"`（wire 稳定）|

### 8.6 错误码增量

新增的错误码（沿用 §五 同款 ACP error envelope）：

| HTTP code | error code | 来源 | 含义 |
|---|---|---|---|
| 404 | `session_not_bound` | daemon | sessionId 不匹配 daemon 当前绑定的 session |
| 404 | `workspace_not_bound` | daemon | workspaceId 不匹配 daemon 当前绑定的 workspace |
| 409 | `already_bound` | daemon | `POST /session/:id/load` 在 daemon 已绑 session 时调用（不能 swap）|
| 503 | `daemon_starting` | **orchestrator** | 已 spawn daemon 但未就绪（client 应短暂重试）|
| 502 | `daemon_unreachable` | **orchestrator** | orchestrator → daemon 连接失败（应触发 daemon 重启）|
| 410 | `daemon_terminated` | **orchestrator** | 该 sessionId 对应的 daemon 已退出（client 应通过 orchestrator 重新路由）|

### 8.7 一句话总结

**Daemon 层 0 wire 破坏（PR#3889 已实现的全保留）+ Orchestrator 层全新一套（External Reference Architecture，由外部实施）**。单 session 场景（Mode A 或单 daemon Mode B）跳过 orchestrator 直连 daemon URL；多 session 场景（多 daemon Mode B）需要 orchestrator 路由 sessionId → daemonUrl。SDK 加 `coordinatorUrl` 配置项区分两种部署。

---

下一篇：[04-进程模型 →](./04-process-model.md)
