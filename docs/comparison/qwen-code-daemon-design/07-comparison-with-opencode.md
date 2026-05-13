# 07 — 与 OpenCode 详细对比

> [← 上一篇：3 阶段路线图](./06-roadmap.md) · [下一篇：协议兼容性 →](./08-protocol-compatibility.md)

> 本设计与 OpenCode daemon 在 wire 协议、HTTP 路由、SQLite 持久化层面相似。**进程模型层面**：OpenCode HTTP daemon 走 single-process N-session 跨 workspace 共享，**Qwen PR#3889 Stage 1 走 channel-per-workspace + N session multiplexed**（commit `6a170ef8`，2026-05-12）—— 后者在**同 workspace 内**已达到 OpenCode 同款 in-process N-session 经济性（OAuth × 1 / cache × 1 / MCP × 1 / cold start <200ms after first），**跨 workspace** 仍走 OS 进程隔离（`acpAgent.ts:601 loadSettings(cwd)` 边界）。OpenCode 跨 workspace 资源共享是 qwen-code Stage 2e 才考虑的可选演进。详见 [§02 §2](./02-architectural-decisions.md#2-状态进程模型) + [§13 单 vs 多 Session 设计深度对比](./13-single-vs-multi-session-design.md)。

## 一、设计哲学对比

| 维度 | OpenCode | Qwen Daemon（本设计）| 差异理由 |
|---|---|---|---|
| 进程模型 | 单 daemon 多 session 共进程（跨 workspace）| **PR#3889 Stage 1 = channel-per-workspace + N session multiplexed**（commit `6a170ef8`）| 同 workspace 已 in-process N-session（OpenCode 同款经济性）；跨 workspace 仍走 OS 进程隔离；Stage 2e native in-process 可选演进解决跨 workspace |
| `process.cwd()` | 永不改变 | **同款** | OpenCode 已验证 |
| 上下文传播 | Effect-TS `LocalContext`（per-request session + workspace ctx）| **Stage 1**：HTTP route handler 拿到 sessionId 后 dispatch 到对应 ACP channel；同 channel 内多 session 走 ACP wire 自带 sessionId 路由（不需要应用层 ALS）。**Stage 2e**：daemon 直接 import `QwenAgent` 时需引入 Node 内建 `AsyncLocalStorage` per-request session ctx | Qwen 不引入 Effect 重依赖 |
| HTTP 框架 | Hono | **Express 5（默认，复用 vscode-ide-companion 已有依赖）/ Hono 可选（External SaaS 高并发）** | 不强行对齐——Express 5 + zod 校验已够用，Hono 是性能 trigger 后再切 |
| 协议 schema | OpenAPI codegen（13525 行）| **复用 ACP NDJSON zod schema** | Qwen 已有 838 行 ACP agent，0 设计成本 |
| 多 channel 支持 | 仅 SDK / TUI / Web | **+ IM / IDE 全走 SessionRouter** | Qwen 已有 Channels 包 |
| 鉴权 | 单密码 `OPENCODE_SERVER_PASSWORD` | **bearer token + PR#3723 应用层权限流** | Qwen 已有 PR#3723 |
| Session 共享 | 否（per-SDK call）| **默认 `single` 同 workspace 多 client 共享 + 事件 fan-out + 任意 client 审批 permission** —— **live collaboration 模型** | Qwen Channels 已有 scope 概念 + 单用户多 client 真实场景 |
| 数据持久化 | SQLite（drizzle-orm）| **JSONL session（PR#3739）+ SQLite for permission decisions** | 复用 Qwen 现有持久层 |
| 默认安全 | 无 token 警告，仍启动 | **无 token + 0.0.0.0 拒绝启动** | 比 OpenCode 严格 |

## 二、HTTP 路由对比（详细）

### OpenCode 路由结构

```
/global          → 全局元信息
/control         → 多 workspace 调度面
/                → workspace router
  ├─ /session/*       (session lifecycle)
  ├─ /file/*          (file 读写)
  ├─ /pty/*           (terminal, WebSocket)
  ├─ /tui/*           (TUI client 接入点)
  ├─ /provider/*      (provider 管理)
  ├─ /mcp/*           (MCP 管理)
  ├─ /permission/*    (审批)
  └─ /event/*         (SSE/WS)
/ui              → 内嵌 web UI
```

### Qwen Daemon 路由结构（本设计）

```
/                                       服务端元信息（含 acp 协议版本）
/health                                  健康检查（无认证）
/authenticate                            bearer token 取换 long-lived token

/session                                 session lifecycle (复用 ACP 协议)
  ├─ POST /session                       NewSessionRequest
  ├─ GET  /session                       ListSessionsRequest
  ├─ POST /session/:id/load              LoadSessionRequest
  ├─ POST /session/:id/prompt            PromptRequest
  ├─ POST /session/:id/cancel            CancelNotification
  ├─ POST /session/:id/model             SetSessionModelRequest
  └─ GET  /session/:id/events            SSE / WebSocket

/permission/:requestId                   审批响应（异步流模式）

/workspace                               daemon 内 byWorkspaceChannel 管理 M workspace（同 daemon 多 workspace 已自带；跨 daemon process 才需 External orchestrator）
  ├─ POST /workspace                     register workspace（daemon 未绑时；已绑返回现有）
  ├─ GET  /workspace/:id/skills          已加载 skill
  ├─ GET  /workspace/:id/mcp             MCP server 状态
  ├─ GET  /workspace/:id/lsp             LSP 状态
  ├─ GET  /workspace/:id/tasks           background tasks (4 kinds)
  ├─ GET  /workspace/:id/file            read file
  ├─ POST /workspace/:id/file            write file (PR#3774 prior-read 守卫)
  ├─ POST /workspace/:id/file/edit       edit file (同上)
  └─ POST /workspace/:id/pty             open PTY (Upgrade: websocket)
```

**关键差异**：

1. **ACP RPC 直接映射**：Qwen 的 `/session/:id/*` body 直接是 ACP request schema（`PromptRequest` / `LoadSessionRequest` / `SetSessionModelRequest` 等）；OpenCode 是自创的 OpenAPI schema。
2. **`/workspace/:id/tasks` 列出 4 kinds**：Qwen 把 PR#3471/3488/3642/3791/3836 的 agent/shell/monitor/dream 4 种 kind 任务统一展示；OpenCode 没有 monitor + dream 概念。
3. **`/permission/:requestId` 异步响应**：Qwen 走 SSE 推 + POST 回的异步流模式；OpenCode 走 dialog 同步模式（与 daemon 模型相对差，因为 daemon 通常 headless）。

## 三、技术栈对比

| 组件 | OpenCode | Qwen Daemon |
|---|---|---|
| HTTP 框架 | Hono | **Express 5（默认）** / Hono（External SaaS 可选） |
| Runtime | Bun 优先 / Node fallback | **Node.js 优先（prod 长跑稳）/ Bun dev** |
| WebSocket | `Bun.serve` + `createBunWebSocket` | 默认 `express-ws`（备选 `ws` 直挂）+ SSE 兜底 |
| OpenAPI 生成 | `hono-openapi` | `@asteasolutions/zod-to-openapi`（Stage 2 引入）|
| Schema 验证 | Effect Schema | **zod**（与现有 ACP 一致）|
| 上下文传播 | Effect `Context.Service` | **`AsyncLocalStorage` 直接** |
| 服务发现 | mDNS Bonjour（默认开启）| Stage 2 可选（默认关）|
| 持久化 | SQLite via drizzle-orm | JSON+JSONL → External Phase 1 SQLite（[§14 持久化栈](./14-orchestrator-multi-tenancy.md#四持久化栈大致方向)）|
| 鉴权 | `OPENCODE_SERVER_PASSWORD` env | bearer token + PR#3723 |

## 四、API 命名对比

| 概念 | OpenCode | Qwen Daemon |
|---|---|---|
| 创建 session | `POST /session` | `POST /session`（body 是 ACP `NewSessionRequest`）|
| 发送消息 | `POST /session/:id/message` | `POST /session/:id/prompt`（ACP 术语）|
| 取消 | `POST /session/:id/abort` | `POST /session/:id/cancel`（ACP 术语）|
| 流式事件 | `GET /event` 全局 | `GET /session/:id/events`（per-session 流）|
| 切换 workspace | URL `/?directory=...` query | URL `/workspace/:id/...` path |
| MCP 列表 | `/mcp` 全局 | `/workspace/:id/mcp`（per-workspace 隔离）|

**Qwen 选择更显式的 path-based workspace** —— 与 OpenCode 的"directory query"相比，URL 一眼能看出请求作用范围。

## 五、与 OpenCode 不同的 4 个核心选择

### 5.1 ACP zod schema 而非自创 OpenAPI

**收益**：
- 协议层 0 设计成本（ACP 已有 838 行 agent 验证过）
- daemon route handler 与 ACP `Session.handleXxx()` 共享同一组业务函数
- 客户端可直接复用 ACP 类型（`@agentclientprotocol/sdk`）

**代价**：
- ACP schema 设计为 stdio NDJSON，HTTP body 用起来不是最 idiomatic（如 path id 与 body id 重复）
- 协议演进绑定 ACP 版本（当前 0.14）

**判断**：复用 ACP 收益远大于代价——0 设计成本 + 与 IDE/Zed 生态天然兼容（IDE 通过 ACP 连 daemon 时不需要 schema 适配）。

### 5.2 多 channel 路由（IM / VSCode / Web 全走 SessionRouter）

**OpenCode**：daemon 是给 SDK / TUI / Web UI 用的——单一类客户端。
**Qwen**：Channels 包已有的 IM 路由（Telegram / 微信 / 钉钉）也走 daemon——多类异构客户端共存。

**优势**：
- 一个用户可以从手机微信发命令，回到电脑 SDK 继续看（`scope='user'`）
- IM 客户端 + 桌面 IDE + Web UI 同时观察一个 session

**复杂性**：
- 多 channel scope 矩阵（thread / single / user）增加测试面积
- IM 客户端的认证模式与 HTTP bearer token 不同（IM 用 OAuth 配对）—— 需额外适配层

### 5.3 PR#3723 应用层权限流

**OpenCode**：单 password 控制访问，工具级 permission 走 OpenCode permission system。
**Qwen**：bearer token + 复用 PR#3723 evaluatePermissionFlow()——daemon 只是第 4 种 mode。

**收益**：
- 工具级权限决策与 Interactive / Non-Interactive / ACP mode 共享同一份逻辑
- bug 修一处全 mode 受益（PR#3723 把"散落 3 处"重构为单一权威路径）
- `alwaysAllow` 持久化跨 mode 一致

**代价**：
- daemon 加 mode 后 PR#3723 的 4 mode 矩阵更复杂

### 5.4 默认 0.0.0.0 + 无 token = 拒绝启动

**OpenCode**：无 token 也启动（仅警告 "unsecured"）。
**Qwen**：无 token + `--hostname=0.0.0.0` **直接拒绝启动**。

**理由**：
- Qwen 默认服务对象包含 IM 用户（不只是开发者本地用），暴露到公网风险更高
- 强制安全 default 是对用户负责

### 5.5 多 expose 路径 convergence — Stage 1.5-prereq 抽 `@qwen-code/acp-bridge`

> 来源：chiga0 PR#3889 [comment 4427773706](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427773706) "cross-module unification" + tanzhenxin [comment 4428974701](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4428974701)。

OpenCode 没有这个问题——HTTP daemon 是它唯一的 "expose agent" 路径。Qwen Code 已经有 6 条独立路径（`acp-integration/` / `nonInteractive/` / `dualOutput/` / `remoteInput/` / `channels/` / `serve/`）共享 ~80% machinery 但 ~0% abstractions。tanzhenxin 直接观察："`httpAcpBridge.ts` (~1820 LOC) 与 `channels/base/AcpBridge` (~360 LOC) 架构相似——都有 `spawnOrAttach` + per-session FIFO + sessionId map + `sessionScope: 'single' | 'thread'`"。

Stage 1.5-prereq 工作：把 `AcpChannel` interface + `EventBus` + `PermissionMediator` 抽到 `@qwen-code/acp-bridge` 共享包（[§06 Stage 1.5-prereq 6 findings 详表](./06-roadmap.md#stage-15-prereq--chiga0-6-架构重构-findingscross-module-unification)）。**Qwen 此后比 OpenCode 多一层泛化**——OpenCode 的 Hono daemon 是单一 transport；Qwen 的 `AcpChannel` 通吃 stdio / HTTP-bridge / native-in-process / WebSocket / IM channel 5 种 transport。

## 六、性能对比预期

| 维度 | OpenCode（实测）| Qwen Stage 1 channel-per-workspace（commit `6a170ef8`）| Qwen Stage 2e native in-process（预期）|
|---|---|---|---|
| 启动时间 | ~2-3s | ~2-3s（HTTP front 启动）| 类似（同框架）|
| 首 session 创建（新 workspace）| <100ms | ~1-3s（spawn `qwen --acp` child + V8 / module load）| <100ms（无 child spawn）|
| 同 workspace 第 N session | <50ms（LSP/MCP/cache 已 ready）| **<200ms**（attach existing channel + 1 ACP `newSession` RPC）| <50ms 同 OpenCode |
| 跨 workspace 第二个 session | <50ms（同进程共享 LSP/MCP）| ~1-3s（不同 child）| <50ms（如解 `loadSettings(cwd)` 污染）|
| Prompt 端到端延迟（SSE 首字节）| 主要由 LLM 决定 | 类似 | 类似 |
| 100 同 workspace session | 内存约 100-150MB（共享）| **类似** ~100-150MB（1 child + 100 session multiplexed via ACP `sessions: Map`）| 类似 |
| 100 跨 workspace session（每 ws 1 session）| 内存 ~200MB（同进程共享）| ~6-10GB（100 child × ~60-100MB）| 类似 OpenCode 同进程共享 |

**Qwen 可能略高的地方**：
- ACP zod schema 校验 vs OpenCode Effect Schema —— zod 在大 schema 上略慢但 Qwen 路由相对简单，影响可忽略
- Channels SessionRouter 的额外路由层 —— 仅 Map 查表，纳秒级

## 七、迁移路径（Qwen 用户从 stdio ACP 切到 daemon）

```bash
# Stage 0：现状 - 用户启动 stdio ACP agent
qwen --acp                                   # stdio NDJSON

# Stage 1（PR#3889 ✅ MERGED 2026-05-13 / Stage 1 scope 100%）：Mode B headless qwen serve
qwen serve --port 5096

# Stage 1.5（~4d 增量）：Mode A CLI + HttpServer
qwen --serve --port 5096

# 客户端切换
# 旧：spawn qwen --acp + ndJsonStream(child.stdin/stdout)
# 新：HTTP fetch + EventSource
```

SDK 用户：

```ts
// 旧
const q = query({ transport: new ProcessTransport(...) })

// 新
const q = query({ transport: new HttpTransport({
  baseUrl: 'http://localhost:5096',
  bearerToken: process.env.QWEN_SERVER_TOKEN,
}) })
```

`Transport` 接口不变，业务代码一行不改。

## 八、长期可能的差异

5 个维度上 Qwen daemon **可能比 OpenCode 走得更远**（因为 Qwen 的 ecosystem 更广）：

1. **ChannelAdapter 生态**：Telegram / 微信 / 钉钉 / Slack 直接挂在 daemon 上 —— OpenCode 没这套
2. **VSCode IDE companion 直连 daemon**：替代当前 ide-server.ts 自起 express
3. **Java SDK 直连 daemon**：Qwen 唯一有 Java acp-sdk，daemon 后跨语言更顺
4. **Background tasks 4 kinds 跨 client 可见**：Qwen kind framework（PR#3836）能在 daemon 模式下让所有 client 看到所有后台任务（agent/shell/monitor/dream）
5. **MCP in-flight coalesce + 30s 健康检查**：daemon 设计仍走 per-workspace 路线（与 OpenCode 一致），但同 workspace 内 PR#3818 提供请求去重 + 30s 自动健康检查（OpenCode 没有等价物；PR#3819 已 closed 不再相关）

## 九、核心结论

| 共识（与 OpenCode 部分相同）| Qwen 差异化 |
|---|---|
| daemon 不再 spawn CLI 子进程 | 1. 复用 ACP zod schema |
| HTTP+SSE+WebSocket 协议层 | 2. 多 channel 路由（IM/IDE/Web/SDK 同源）|
| 持久化分层（文件+RDBMS）| 3. **Express 5 复用 vscode-ide-companion**（Hono 是 External SaaS 高并发可选，不是默认）|
| ACP / OpenAPI 协议表面 | 4. 复用 PR#3723 应用层权限流 |
| **进程模型差异** | 5. **PR#3889 Stage 1 = channel-per-workspace + N session multiplexed**（commit `6a170ef8`，2026-05-12）——同 workspace 内 in-process N-session 与 OpenCode 同款经济性；跨 workspace 仍走 OS 进程隔离（vs OpenCode 单进程 N workspace 共享）。Stage 2e native in-process 是可选演进，解决跨 workspace 资源共享 |
| 默认安全策略 | 6. 默认 0.0.0.0 + 无 token = 拒绝启动 |

**Qwen daemon 不是"OpenCode 的复刻"，而是"借鉴 OpenCode 验证过的进程模型 + 复用 Qwen 自家的 ACP / Channels / PR#3723 / Background tasks 等成熟资产"** —— ~75% 复用率的来源即此。

---

[← 回到 README](./README.md)
