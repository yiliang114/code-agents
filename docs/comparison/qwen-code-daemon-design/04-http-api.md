# 04 — HTTP API 设计

> **🚀 Stage 1 实现状态**（2026-05-07）：本章 9 路由全部由 [PR#3889](https://github.com/QwenLM/qwen-code/pull/3889) 实现（commits `61f2f59a1` scaffold + `ca996ecb5` prompt/cancel + `41aa95094` SSE EventBus + `6ee655f0a` permission + `a8ce5e08d` workspace/model）。详见 [§08 Stage 1 实现 audit](./08-roadmap.md#stage-1-pr3889-实现-audit2026-05-07)。

> **🔄 设计 pivot 影响（2026-05-09）**：pivot 改为"1 Daemon Instance = 1 Session"后：
>
> - **`POST /session` 仍存在**——但语义从"在多 session daemon 内创建一个 session"变为"daemon instance 启动时绑定唯一 session（如已绑定则返回 409）"
> - **多 session 操作移到 orchestrator 层**：`POST /coordinator/sessions/{id}/route` 等聚合 API 由 orchestrator 提供，单 daemon 不感知
> - **本章 9 路由的 wire 格式不变**——pivot 不改协议，只改"daemon 内 N 个 session"语义为"orchestrator 路由到 N 个 daemon 各自的唯一 session"
> - **Mode A vs Mode B**：两种部署模式的 HTTP API **完全一致**（Mode A 多挂个 in-process TUI subscriber 不影响 wire）
>
> 详见 [§03 §2](./03-architectural-decisions.md#2-状态进程模型pivot-后) + [§03 §7](./03-architectural-decisions.md#7-daemon-部署模式cli-httpserver-vs-headless-httpserverpivot-后新增)。

> [← 上一篇：6 个架构决策](./03-architectural-decisions.md) · [下一篇：进程模型 →](./05-process-model.md)

> daemon HTTP 路由的核心创新：**复用 ACP NDJSON 的 zod schema** —— body 结构与 `PromptRequest` / `NewSessionRequest` 等 ACP 类型 1:1 对应。

## 一、根路由总览

```
GET    /                                   服务端元信息
GET    /health                             健康检查（无认证）
POST   /authenticate                       (HTTP-only) bearer token 取换 long-lived token

# Session 生命周期（直接映射 ACP RPC）
POST   /session                            new session       ← NewSessionRequest
GET    /session                            list sessions     ← ListSessionsRequest
GET    /session/:id                        session info      ← (新加 schema)
POST   /session/:id/load                   load session      ← LoadSessionRequest
DELETE /session/:id                        archive / delete

# 与 session 交互
POST   /session/:id/prompt                 send prompt       ← PromptRequest
POST   /session/:id/cancel                 cancel current    ← CancelNotification
POST   /session/:id/model                  set model         ← SetSessionModelRequest
POST   /session/:id/mode                   set mode          ← SetSessionModeRequest
POST   /session/:id/config                 set config option ← SetSessionConfigOptionRequest

# 流式事件（核心 — daemon 与 stdio ACP 的唯一传输层差异）
GET    /session/:id/events                 SSE / WebSocket   ← SessionNotification[]
                                            (Upgrade: websocket 走 WS，否则 SSE)

# 权限审批（HTTP 异步流模式）
POST   /permission/:requestId              respond to permission_request

# Workspace 管理（多 workspace 路由）
GET    /workspace                          list workspaces
POST   /workspace                          register workspace  body: { directory }
DELETE /workspace/:id                      dispose workspace

# 工具能力查询
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
POST   /workspace/:id/skill/reload         reload skill registry
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

> **HTTP 框架选择**：默认推荐 **Express 5**（复用 vscode-ide-companion 已有依赖，0 新包）。Hono 是 Stage 6 SaaS 高并发场景的可选项（与 OpenCode 对齐 + Bun.serve 一线支持），但 MVP 不必要——Express 5 + zod 校验 ~10 行包装即可。详见决策评估部分。

**意义**：协议 schema 0 设计成本——与 ACP agent 共用一份 zod schema，daemon route handler 与 ACP `Session.handleXxx()` 共用同一组业务函数。

### Daemon 特有的扩展字段

少数 HTTP 特有字段需要新增 schema：

```ts
// 新增 schema（daemon 特有）
const DaemonSessionMeta = z.object({
  workspaceId: z.string(),                // 多 workspace 路由
  cwd: z.string().optional(),              // 显式 cwd（覆盖 workspace 默认）
  clientId: z.string().optional(),         // 多 client 标识
  scope: z.enum(['thread', 'single', 'user']).optional(),
})

const DaemonNewSessionRequest = NewSessionRequest.extend({
  meta: DaemonSessionMeta,
})
```

## 三、SSE / WebSocket 事件流（核心）

### 选择：默认 SSE，按 client 升级到 WebSocket

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
- Stage 6+ 切到 Hono 时（Hono 用 Bun.serve 原生 createBunWebSocket，不再需 express-ws）

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

client → daemon: POST /permission/r1  body: { allow: true, alwaysAllow: false }
daemon → client: SSE { type: 'tool_result', ... }
                 SSE { type: 'message_part', content: '...' }
                 (response body 是 PromptResponse)
```

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

(同时 client 打开 GET /session/sess-xyz/events SSE 监听)

→ 200 OK (PromptResponse) — 等待中，事件流持续推送

← SSE event_stream 同时推送中:
data: {"type":"message_part","content":"我来帮..."}

data: {"type":"tool_call","name":"ReadFile","args":{"path":"src/foo.ts"}}

data: {"type":"tool_result","name":"ReadFile","output":"..."}

...

(最后)
→ 200 OK 返回 PromptResponse
{ "stopReason": "end_turn", "tokenUsage": {...} }
```

### 4.2 加载历史 session

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

### 4.3 多 client 跨设备续行（默认 `single` scope 下的典型流）

**默认 daemon `sessionScope: 'single'`** —— 同 workspace 多 client 自动共享 session。

```
[CLI]: qwen workspace register /work/repo-a → workspaceId=ws-a
       qwen → POST /session { meta: { workspaceId: 'ws-a', scope: 'single' } }
       daemon SessionRouter.routingKey('http', '*', 'ws-a') = "http:__single__:ws-a"
       创建 sess-foo（首个 client）
       → 200 OK { sessionId: 'sess-foo' }
       开始 prompt: "请重构 src/foo.ts"

[VSCode 同时打开]: 自动连 daemon
       POST /session { meta: { workspaceId: 'ws-a', scope: 'single' } }
       同 routing key 命中 sess-foo
       → 200 OK { sessionId: 'sess-foo', attached: true }
       
       GET /session/sess-foo/events （SSE 接入）
       VSCode 实时看到 CLI 触发的 message_part / tool_call / tool_result
       
[Web UI 同时打开]: 同上 → 也看到 sess-foo 实时事件流

→ Agent 决定调 Bash 跑 npm test，触发 permission_request
  CLI / VSCode / Web UI 三个 client 都通过 SSE 收到事件
  用户在 Web UI 上点 "Allow"
  → POST /permission/r1 { allow: true }
  → daemon SSE 广播 "permission_resolved by client-webui-1" 给所有 client
  → CLI / VSCode 自动关闭弹窗
  → Bash 工具继续执行
```

### 4.4 跨 channel 续行（手机/电脑场景，需要 `scope: 'user'`）

```
[手机微信]: 通过 channels/weixin → SessionRouter
            scope='user', user-id=u123 → routing key "weixin:u123:chat-456"
            创建 sess-mobile

[电脑 SDK]: scope='user' 显式指定
POST /session HTTP/1.1
{ "meta": { "workspaceId": "ws-a", "scope": "user", "userId": "u123" } }
  
  daemon SessionRouter.routingKey('http', 'u123', 'ws-a') = "http:u123:ws-a"
  
  这是不同 channel 的 routing key (weixin: vs http:)，所以 NOT 命中 sess-mobile
  
  解决方案：用 LoadSession 显式跨 channel 拉取
POST /session/sess-mobile/load
  → 200 OK (LoadSessionResponse 含完整 transcript)
  
  现在 SDK client 也接入 sess-mobile，能看到手机端正在跑的 background task
```

**关键点**：
- 同 channel 内（如 `'http'` channel 含 SDK + WebUI + IDE）`single` scope 下默认共享
- 跨 channel（如 `'weixin'` ↔ `'http'`）需要显式 LoadSession 跨边界拉取
- 跨 channel 自动共享需要 `scope='user'`（要求双方都标记同 user-id）

## 五、错误码与状态码

| HTTP code | 含义 | 对应 ACP error code |
|---|---|---|
| 401 | bearer token 缺失/错误 | — |
| 403 | workspace 越权 / permission denied | — |
| 404 | session/workspace not found | `errorCodes.SESSION_NOT_FOUND` |
| 409 | 同 session 已有 active prompt（多 client 并发冲突）| 新增 `SESSION_BUSY` |
| 422 | request body schema 校验失败 | — |
| 429 | rate limit | — |
| 500 | core internal error | `errorCodes.INTERNAL_ERROR` |
| 504 | LLM upstream timeout | `errorCodes.UPSTREAM_TIMEOUT` |

`packages/cli/src/acp-integration/errorCodes.ts` 已定义 ACP 错误码，daemon 加 HTTP code 映射即可。

## 六、OpenAPI 自动生成（可选，Stage 3+）

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

> 如果切到 Hono（Stage 6 高并发场景），可改用 `hono-openapi`，更紧凑但功能等价。

SDK 客户端可以从 `/openapi.json` codegen 出 typed HTTP client（参考 OpenCode `@opencode-ai/sdk` 的做法）——但 Qwen 也可以选**手写 SDK 客户端**（更精准控制，复用 ACP zod 类型），不强制 codegen。

## 七、版本与向后兼容

```
GET / HTTP/1.1
→ 200 OK
{
  "qwen": "0.16.0",              // qwen-code package version
  "daemon": "1",                  // daemon API major version
  "acp": "0.14",                  // ACP protocol version (ACP_PROTOCOL_VERSION)
  "capabilities": {
    "websocket": true,
    "sse": true,
    "openapi": true
  }
}
```

- **daemon API 版本独立于 qwen 包版本** —— 允许 qwen 包升级时不破坏 SDK 客户端
- **ACP 协议版本透传** —— 与底层 ACP 库版本一致（当前 0.14）

---

下一篇：[05-进程模型 →](./05-process-model.md)
