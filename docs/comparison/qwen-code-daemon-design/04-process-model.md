# 04 — 进程模型与工作目录隔离

> [← 上一篇：HTTP API 设计](./03-http-api.md) · [下一篇：权限流与认证 →](./05-permission-auth.md)

> **核心约束**（[§02 §2](./02-architectural-decisions.md#2-状态进程模型) PR#3889 Stage 1 channel-per-workspace 架构）：
>
> - daemon HTTP front 进程内 **`byWorkspaceChannel: Map<workspace, ChannelInfo>`** 维护每 workspace 一个 ACP channel
> - 每个 ACP channel 持一个 `qwen --acp` child；同 channel 内通过 `QwenAgent.sessions: Map` 多路复用 N session
> - daemon HTTP front 本身**不绑定 workspace**——但当前实现里 1 daemon 服一组 workspace（外部 orchestrator 决定）
> - `process.cwd()` 启动后不变（daemon HTTP front + 每 `qwen --acp` child 各自启动时绑定 cwd）
> - 子进程 spawn（LSP / MCP / Bash）发生在 `qwen --acp` child 内，cwd = child 启动时绑定的 workspace cwd
>
> **Stage 2e native in-process 演进影响**：① 去 `qwen --acp` child 桥接，daemon 直接 import `QwenAgent`；② 需引入 Node 内建 `AsyncLocalStorage`（不引 Effect-TS）做 per-request session ctx 路由；③ 需解 `acpAgent.ts:601 loadSettings(cwd)` 跨 workspace 污染才能跨 ws 共享。

> 设计原则：**daemon HTTP front + 每 `qwen --acp` child 主进程 `process.cwd()` 永不改变**——参考 OpenCode 验证过的模式。详细背景见 [SDK / ACP / Daemon §六.4](../sdk-acp-daemon-architecture-deep-dive.md#64-工作目录隔离asynclocalstorage-上下文传播)。

## 一、整体进程拓扑（PR#3889 Stage 1 commit `6a170ef8`：channel per workspace + N session multiplexed）

```
qwen serve daemon instance 进程（绑定唯一 session，process.cwd() 启动后不变）
│
├─ Express 5 HTTP server + express-ws（Hono 可选 External SaaS 高并发）
│   ├─ Auth middleware（Mode A loopback / Mode B bearer）
│   └─ /session/:id/* / /capabilities / /health
│
├─ EventBus（多 client fan-out）
│   ├─ in-process subscriber（Mode A 本地 TUI = client #0）
│   ├─ HTTP/SSE subscriber（远端 client：CLI / WebUI / IDE / IM bot）
│   └─ first-responder permission vote
│
├─ Core（in-process · 直接绑唯一 session）
│   ├─ Session（1 个，启动时绑定）
│   ├─ FileReadCache（daemon-global singleton）
│   ├─ Permission decision cache（per-daemon）
│   ├─ Background tasks（4 kinds：agent / shell / monitor / dream）
│   ├─ providers / config / SessionService（PR#3739 transcript-first resume）
│   └─ Transcript JSONL（per-daemon 一份）
│
├─ 子进程层（per-daemon · 不跨 daemon 共享）
│   ├─ LSP server（绑此 daemon 的 workspace）
│   ├─ MCP servers（per-daemon · 详见 [§02 §3](./02-architectural-decisions.md#3-mcp-server-生命周期)）
│   └─ PTY / Bash 工具调用（按工具调用粒度）
│
└─ daemon 启动时绑定（启动后不变）
    ├─ workspace（1 个）
    ├─ session id（1 个）
    └─ process.cwd()（不变；子进程 spawn 显式传 cwd）
```

**关键性质**（与 §02 §2 决策一致）：
- daemon 进程本身就是 session ctx，**无需 AsyncLocalStorage Instance ctx**
- daemon 内只绑定一个 workspace，**无需 `Map<workspaceId, Instance>` 路由层**
- 多 session 由 External orchestrator spawn 多个 daemon 实例（[§01 §3.2](./01-overview.md#32-多-session-场景external-orchestrator--多-daemon-instances) + [§03 §8.2](./03-http-api.md#82-orchestrator-层-apiexternal-reference-architecture)）

## 二、cwd 在 `qwen --acp` child 启动时绑定

PR#3889 Stage 1 channel-per-workspace 模型下，每个 `qwen --acp` child 的逻辑 cwd 在**该 child 启动时一次性确定**（= workspace cwd），运行时不变。Stage 2e native in-process 重构后 daemon 直接持 `QwenAgent`，多 workspace 时需 per-session cwd 路由（引入 ALS）。

```ts
// daemon 启动决议顺序
const daemonBoundCwd =
     ENV.QWEN_DAEMON_CWD                  // 1. orchestrator spawn 时显式传
  ?? cliFlag.cwd                          // 2. `qwen serve --cwd ...`
  ?? settings.workspace.directory         // 3. settings.json 中的 workspace 配置
  ?? process.cwd()                        // 4. 兜底（daemon 启动时 OS cwd）
```

后续所有 HTTP 请求 / core 代码 / 子进程 spawn 都使用同一个 `daemonBoundCwd`——无需 per-request 解析。OpenCode 用 query / header / `process.cwd()` 三层是因为它 multi-session 模型一个 daemon 服多个 workspace；Qwen 不需要。

## 三、Core 代码 cwd 接入

Qwen Code core 已经是 **config 显式传递** 模式（不依赖 `process.cwd()`），daemon 化只需在 HTTP adapter 层把 daemon 启动时绑定的 `cwd` 透传到 `buildConfig`：

```ts
// daemon adapter 层（startup 时一次绑定，运行时不变）
const config = buildConfig({
  ...baseConfig,
  cwd: daemonBoundDirectory,   // 启动时根据 workspace 注册或 ENV 决定
  worktree: detectWorktree(daemonBoundDirectory),
})
```

**Stage 1（commit `6a170ef8` 后）**：HTTP route handler 从 URL 拿 sessionId → `byWorkspaceChannel` lookup 找到 channel → 发 ACP NDJSON 请求带 sessionId → child 内 `QwenAgent.sessions.get(sessionId)` 路由到对应 `Session`。**HTTP daemon front 端无需 ALS**——sessionId 路由通过 URL path + ACP wire 自带；**`qwen --acp` child 端也无需 ALS**——`Session` 实例就是 ctx 容器。

**Stage 2e native in-process**：daemon 直接持 `QwenAgent`，没有 ACP wire 中转，需引入 Node 内建 `AsyncLocalStorage` per-request 传 sessionId + workspace；core 代码改为读 `als.getStore()?.sessionId ?? config.getSessionId()`（fallback 兼容 standalone 路径）。

## 四、什么情况下 daemon 才会 spawn 子进程？

| 触发 | 子进程数 | 备注 |
|---|---|---|
| 启动 LSP server | LSP × 1 | daemon spawn 时一次性起 |
| 配 MCP server | MCP × N | per-daemon（详见 [§02 §3](./02-architectural-decisions.md#3-mcp-server-生命周期)）|
| 工具调用 `bash` / 长跑 monitor | PTY / shell 进程 | 按工具调用粒度，结束就回收（`PR#3642` background shell pool）|
| 后台 SubAgent（fork）| Node fork 或 in-process worker | 按 PR#3471/3739 transcript-first fork resume 模式 |

**daemon 主进程绝不为以下情况 spawn**：
- LLM 调用（HTTP fetch from daemon main thread）
- 新 session 创建（多 session 由 orchestrator spawn 新 daemon 实例完成）

## 五、`process.chdir()` 完全禁用

OpenCode 全仓只 3 处 `process.chdir()`，全在非 daemon 的短生命 CLI 模式（`run.ts` / `tui/attach.ts` / `tui/thread.ts`）。**Qwen Code daemon 路径下 0 处 `chdir`**——这是设计上必须保证的。

```bash
# 落地后回归检测脚本
$ grep -rn "process\\.chdir" packages/server/  # daemon 代码目录
$ # 期望 0 输出

$ grep -rn "process\\.chdir" packages/core/    # core 代码
$ # 任何 hit 都需审计 — daemon 绑定 core 时 chdir 会污染并发请求
```

## 六、子进程 spawn 时显式传 cwd

LSP / MCP / shell 工具 spawn 时**必须显式传 cwd**，不能让子进程继承 daemon 的 `process.cwd()`：

```ts
// ✓ 正确（已经是 Qwen 现有模式 - tool/bash.ts 等）
spawn(cmd, args, { cwd: daemonBoundCwd })   // daemon 启动时绑定的 cwd

// ✗ 错误（会让子进程继承错误的 cwd）
spawn(cmd, args)
```

Qwen Code `packages/core/src/tools/bash.ts` 当前已经是显式传 cwd 模式（参考 `params.workdir` 处理）—— daemon 化无需修改。

## 七、典型场景

### 场景 1：多 client 同 session（live collaboration）

```
Client A → POST /session                           （daemon 启动时已绑 sess-x / cwd=/work/repo-a）
Client B → POST /session  → 返回同一 sess-x（幂等）

两 client 共享:
  - 同一 Session 对象 + EventBus fan-out
  - LSP server / MCP children / FileReadCache（per-daemon）
  - Permission decision cache
  
任意 client 发 prompt → 另一 client 通过 SSE 看到完整事件流（[§02 §1](./02-architectural-decisions.md#1-session-是否跨-client-共享)）
```

### 场景 2：Bash 工具内 workdir 参数覆盖

```
daemon 绑定 cwd=/work/repo-a
Client → bash tool call { command: "ls", workdir: "../repo-b" }

  resolvePath('../repo-b', '/work/repo-a') == '/work/repo-b'
  spawn(cmd, args, { cwd: '/work/repo-b' })  ← OS 级显式 cwd
  
  daemon 主进程的 process.cwd() 从未变化
```

### 场景 3：跨 workspace 跨 session（多 daemon）

```
User 同时在 /work/repo-a 和 /work/repo-b 工作
  → orchestrator spawn 两个独立 daemon 实例：
       daemon-1: cwd=/work/repo-a, sess-A
       daemon-2: cwd=/work/repo-b, sess-B

每 daemon 各自的 LSP / MCP / FileReadCache / process.cwd 完全独立。
跨 daemon 不共享状态（详见 [§14 Orchestrator](./14-orchestrator-multi-tenancy.md)）。
```

## 八、Effect-TS / ALS Instance 路由层：Stage 1 通过 ACP wire 解决，Stage 2e 需要轻量 ALS

OpenCode multi-session daemon 用 Effect-TS（`Context.Service` / `LocalContext.create()`）+ `AsyncLocalStorage` 做 per-request ctx 路由——因为它一个 daemon 进程内承载 N 个 session × M workspace，必须在每个 async 链中携带"当前是哪个 session"的 ctx。

**Stage 1（commit `6a170ef8`）**：sessionId 路由发生在 wire 层——HTTP URL path `/:id` + ACP NDJSON 协议自带 sessionId 字段，HTTP front 通过 `byWorkspaceChannel: Map` 找到 channel，把 ACP 请求 forward 进 child；child 端 `BridgeClient.resolveEntry(sessionId)` 按 sessionId 分发到 `QwenAgent.sessions.get(sessionId)`。**应用层不需要 ALS** —— wire 协议自带的 sessionId 维度足够。

**Stage 2e native in-process**：去 child 桥接 daemon 直接持 `QwenAgent` 时，没有 ACP wire 中转，core 代码读 `config.getSessionId()` 时拿不到当前 request 的 sessionId（Stage 1 这层依赖被 child 隔离掉了）→ 需引入 **Node 内建 `AsyncLocalStorage`**（不引 Effect-TS）做 per-request session ctx 传播。改动范围：HTTP route handler 入口 `als.run({ sessionId }, ...)`，core 代码 `config.getSessionId()` 包装为 `als.getStore()?.sessionId ?? config.getSessionId()` fallback。比 OpenCode Effect-TS 路径轻得多（不引入新依赖、不重写 control flow）。

## 九、与 OpenCode 工作目录处理对比

| 维度 | OpenCode（multi-session 跨 ws）| PR#3889 Stage 1（channel per workspace）| Stage 2e native in-process |
|---|---|---|---|
| daemon 改 `process.cwd()` | ❌ | ❌ | ❌ |
| 上下文传播机制 | `LocalContext` (Effect-TS + AsyncLocalStorage) | **wire 层自动**——HTTP path `:id` + ACP wire sessionId | Node 内建 `AsyncLocalStorage`（不引 Effect-TS）传 sessionId |
| 客户端声明 cwd 方式 | query / header / process.cwd() | `POST /session` body `cwd` 字段（含进 ACP `newSession({cwd})`）| 同 Stage 1 |
| 子进程显式 cwd | ✓ | ✓（在 `qwen --acp` child 内） | ✓ |
| Bash 工具 workdir 参数 | ✓ | ✓（已是 Qwen 现状）| ✓ |

---

下一篇：[05-权限流与认证 →](./05-permission-auth.md)
