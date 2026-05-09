# 05 — 进程模型与工作目录隔离

> [← 上一篇：HTTP API 设计](./04-http-api.md) · [下一篇：MCP / 资源共享 →](./06-mcp-resources.md)

> **核心约束**（[§03 §2](./03-architectural-decisions.md#2-状态进程模型)）：
>
> - daemon 进程本身就是 session ctx —— 不需要 AsyncLocalStorage Instance 路由层
> - daemon 内只绑定一个 workspace —— 不需要 `Map<workspaceId, Instance>`
> - `process.cwd()` 启动后不变 —— daemon 启动时绑定 cwd，跑期间不变
> - 子进程 spawn 仍需显式传 cwd（LSP / MCP / Bash）
>
> 本章下面"AsyncLocalStorage / LocalContext / Instance.directory" 等内容作为 "未来如扩展到 multi-session daemon 的实现参考"（详见 [§21](./21-future-multi-session-migration.md) 路径 C）保留。

> 设计原则：**daemon 主进程 `process.cwd()` 永不改变**——参考 OpenCode 验证过的模式。详细背景见 [SDK / ACP / Daemon §六.4](../sdk-acp-daemon-architecture-deep-dive.md#64-工作目录隔离asynclocalstorage-上下文传播)。

## 一、整体进程拓扑（当前架构：1 daemon = 1 session）

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
│   ├─ MCP servers（per-daemon · 详见 §06）
│   └─ PTY / Bash 工具调用（按工具调用粒度）
│
└─ daemon 启动时绑定（启动后不变）
    ├─ workspace（1 个）
    ├─ session id（1 个）
    └─ process.cwd()（不变；子进程 spawn 显式传 cwd）
```

**关键性质**（与 §03 §2 决策一致）：
- daemon 进程本身就是 session ctx，**无需 AsyncLocalStorage Instance ctx**
- daemon 内只绑定一个 workspace，**无需 `Map<workspaceId, Instance>` 路由层**
- 多 session 由 External orchestrator spawn 多个 daemon 实例（[§01 §3.2](./01-overview.md#32-多-session-场景external-orchestrator--多-daemon-instances) + [§04 §8.2](./04-http-api.md#82-orchestrator-层-apiexternal-reference-architecture)）

> **下面 §三-§四 章节描述的 `AsyncLocalStorage` / `Map<workspaceId, Instance>` / `LocalContext` 等内容**——是"如果未来扩展到 multi-session daemon 的实现参考"（[§21 路径 C](./21-future-multi-session-migration.md#三路径-c纯迁移到-opencode-模式2-3-月最坏情况)），不是当前 qwen-code 主线设计。读者如想对照 OpenCode multi-session 模型可参考；如只关注当前 1-session 模型可跳过。

## 二、客户端如何声明 cwd

每个 HTTP 请求 4 种方式（按优先级）：

```ts
// daemon middleware 解析顺序
const directory =
     req.body?.meta?.cwd                              // 1. 请求 body meta（最高优先级）
  ?? req.headers['x-qwen-directory']                  // 2. HTTP header
  ?? workspaceMap.get(req.body?.meta?.workspaceId)    // 3. workspace 注册时的 directory
  ?? process.cwd()                                    // 4. 兜底（daemon 启动时 cwd）
```

OpenCode 用 3 种（`?directory=` query / `x-opencode-directory` header / `process.cwd()` 兜底），Qwen 多一种"workspace 注册"路径——更适配多 workspace 场景。

## 三、AsyncLocalStorage 上下文传播

### 3.1 Qwen 现有的 LocalContext 等价物

Qwen Code 已经有类似 OpenCode `LocalContext` 的封装（PR#3707 OPEN 引入 per-agent ContentGenerator 时用过 `AsyncLocalStorage`）。daemon 化用同模式：

```ts
// packages/core/src/util/instance-context.ts （建议新加位置）
import { AsyncLocalStorage } from 'async_hooks'

export interface InstanceContext {
  workspaceId: string
  directory: string
  worktree: string
  sessionId?: string
  clientId?: string
}

const storage = new AsyncLocalStorage<InstanceContext>()  // 注：当前 1 daemon = 1 session 不需要；下面是 multi-session 扩展参考（§21 路径 C）

export const Instance = {
  provide<R>(ctx: InstanceContext, fn: () => R): R {
    return storage.run(ctx, fn)
  },
  current(): InstanceContext {
    const ctx = storage.getStore()
    if (!ctx) throw new Error('Instance.current() called outside provide()')
    return ctx
  },
  get directory() { return Instance.current().directory },
  get workspaceId() { return Instance.current().workspaceId },
  get sessionId() { return Instance.current().sessionId },
}
```

### 3.2 Middleware 路由

```ts
// daemon Express middleware（Hono 切换时 c → context 即可）
const instanceMiddleware: RequestHandler = (req, res, next) => {
  const directory = resolveDirectory(req)
  const workspaceId = req.params.workspaceId ?? req.header('x-qwen-workspace')
  const sessionId = req.params.sessionId
  
  const ctx: InstanceContext = {
    workspaceId,
    directory,
    worktree: await detectWorktree(directory),
    sessionId,
    clientId: req.header('x-qwen-client-id'),
  }
  
  return Instance.provide(ctx, () => next())
}

app.use('/workspace/:workspaceId/*', instanceMiddleware)
app.use('/session/:sessionId/*', instanceMiddleware)
```

### 3.3 Core 代码改动量

**几乎为 0**。Qwen Code core 当前用法：

```ts
// 现有代码常见模式
async function readFile(path: string, ctx: { config: Config }) {
  const cwd = ctx.config.getCwd()      // ← 已经是 ctx-driven，不读 process.cwd()
  ...
}
```

Qwen Code core 已经是 **config 显式传递** 模式（不依赖 `process.cwd()`），daemon 化只需在 middleware 层把 config.cwd 替换为 `Instance.directory` 即可：

```ts
// daemon adapter 层
const config = buildConfig({
  ...baseConfig,
  cwd: Instance.directory,           // ← 取自 AsyncLocalStorage
  worktree: Instance.worktree,
})
```

## 四、什么情况下 daemon 才会 spawn 子进程？

| 触发 | 子进程数 | 与 session 的关系 |
|---|---|---|
| 启动新 workspace | LSP server × 1 | 同 workspace 内 session 共享 |
| 配新 MCP server | MCP server × 1 | 跨 session 复用（详见 [06](./06-mcp-resources.md)） |
| 工具调用 `bash` / 长跑 monitor | PTY / shell 进程 | 按工具调用粒度，结束就回收（`PR#3642` background shell pool）|
| 后台 SubAgent（fork）| Node fork 或 in-process worker | 按 PR#3471/3739 transcript-first fork resume 模式 |

**daemon 主进程绝不为以下情况 spawn**：
- 新加 session（纯数据结构 + Effect Context）
- 新加 workspace（仅在 Map 中加 entry）
- LLM 调用（HTTP fetch from daemon main thread）

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
spawn(cmd, args, { cwd: Instance.directory })   // 显式 OS 级 cwd

// ✗ 错误（会让子进程继承错误的 cwd）
spawn(cmd, args)
```

Qwen Code `packages/core/src/tools/bash.ts` 当前已经是显式传 cwd 模式（参考 `params.workdir` 处理）—— daemon 化无需修改。

## 七、4 个典型场景

### 场景 1：两个 client 在不同 workspace

```
Client A → POST /workspace/ws-a/session    （ws-a 注册时 directory='/work/repo-a'）
Client B → POST /workspace/ws-b/session    （ws-b 注册时 directory='/work/repo-b'）

middleware 解析:
  Client A 请求: Instance.provide({ workspaceId: 'ws-a', directory: '/work/repo-a' }, ...)
  Client B 请求: Instance.provide({ workspaceId: 'ws-b', directory: '/work/repo-b' }, ...)

整条 async 链中:
  Client A 的 Bash tool 拿到 Instance.directory == '/work/repo-a'
  Client B 的 Bash tool 拿到 Instance.directory == '/work/repo-b'
  互不污染，因为 AsyncLocalStorage 跨 await 隔离

LSP/MCP server 子进程:
  workspace ws-a 启 LSP（cwd='/work/repo-a'）
  workspace ws-b 启 LSP（cwd='/work/repo-b'）
  各自独立
```

### 场景 2：两个 client 在同一 workspace

```
Client A → POST /session  meta: { workspaceId: 'ws-a' }
Client B → POST /session  meta: { workspaceId: 'ws-a' }

workspaceMap.get('ws-a') → 同一个 Workspace 对象
  ↓
两个 session 各自的 FileReadCache 独立（决策 §4 session-private terminal decision）
但共享:
  - LSP server (ws-a 唯一)
  - MCP servers (跨 session 复用)
  - Provider config / Database / Bus
```

### 场景 3：单 session 通过 LoadSession 跨 workspace

```
Client A 已经在 ws-a 跑了 session-x
Client A 想把 session-x 加载到 ws-b（不常见但 ACP 协议支持）

POST /workspace/ws-b/session/session-x/load HTTP/1.1
{ "preserveTranscript": true }

  daemon: 在 ws-b 工作目录加载 session-x 的 transcript
  Instance.directory 切到 ws-b 的 directory（per-request）
```

### 场景 4：Bash 工具内 workdir 参数覆盖

```
Client A 在 ws-a (/work/repo-a)
Client A → bash tool call { command: "ls", workdir: "../repo-b" }

  Instance.directory == '/work/repo-a'
  resolvePath('../repo-b', '/work/repo-a') == '/work/repo-b'
  spawn(cmd, args, { cwd: '/work/repo-b' })  ← OS 级显式 cwd
  
  daemon 主进程的 process.cwd() 从未变化
```

## 八、Effect-TS 风格 vs Qwen 当前风格

OpenCode 用 Effect-TS（`Context.Service` / `LocalContext.create()`）做依赖注入。Qwen Code 当前是更传统的"config 显式传参"模式。

**daemon 化建议**：**不引入 Effect-TS**，而是用纯 `AsyncLocalStorage` 包装一层 `Instance` API。理由：
1. 引入 Effect-TS 是大型基础设施变更（学习曲线 + 重构面积大）
2. `AsyncLocalStorage` 是 Node 标准 API（自 14.x），无依赖
3. Qwen 已有的"config 显式传参"模式在 daemon 入口包一层 ALS 即可——不需要重构 core

OpenCode 用 Effect 的是因为他们整个项目就是 Effect-first；Qwen 没那个负担。

## 九、与 OpenCode 工作目录处理对比

| 维度 | OpenCode | Qwen Daemon（本设计）|
|---|---|---|
| daemon 改 `process.cwd()` | ❌ | ❌ |
| 上下文传播机制 | `LocalContext` (基于 AsyncLocalStorage) | `Instance` (基于 AsyncLocalStorage) |
| 客户端声明 cwd 方式 | query / header / process.cwd() | query / header / **workspace 注册** / process.cwd() |
| 同 directory 复用 InstanceContext | ✓ Map<directory, Promise<InstanceContext>> | ✓ Map<workspaceId, Workspace> |
| 子进程显式 cwd | ✓ | ✓ |
| Bash 工具 workdir 参数 | ✓ | ✓（已是 Qwen 现状）|

---

下一篇：[06-MCP / 资源共享 →](./06-mcp-resources.md)
