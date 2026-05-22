# 05 — Security & Permission

> [← 上一篇：Deployment & Client](./04-deployment-and-client.md) · [下一篇：Roadmap & Ecosystem →](./06-roadmap.md)

## TL;DR

**三层权限模型**（Wave 1-4 已完整落地）：
- **Layer 1 传输层** —— Bearer token（PR#3889 ✅）+ `--require-auth` mutation gate（PR#4236 ✅, Wave 4 启动）+ daemon-stamped `X-Qwen-Client-Id` 头（PR#4231 ✅）
- **Layer 2 应用层** —— 复用 PR#3723 `evaluatePermissionFlow()` + session-scoped permission route（PR#4232 ✅）+ bounded record（同 sessionId/requestId 只能投一次）+ `parsePermissionOutcome()` 共享 helper
- **Layer 3 审计层** —— audit hooks（SHA-256-hashed paths + `originatorClientId` stamping）+ typed-error 设计哲学（cross-PR `errorKind` / `TrustGateError` / `BridgeTimeoutError` 复用）

**默认安全策略**：0.0.0.0 binding + 无 token = 拒绝启动；`--require-auth` 启用后所有 mutation 路由（PR#4249/4250/4280/4255 等）强制 401 if 无 bearer + clientId。**OAuth device-flow**（PR#4255 ✅ Wave 4 PR 21 史上最难合 20h39m / +4828 / 35 文件 / 4 reviewer voices）—— RFC 8628 + BrandedSecret 4-way redaction + 0o600 file mode + 6 leak-path coverage tests + build-time grep 防 client browser-spawn。

**Wave 5+ 候选**：chiga0 finding 3 `PermissionMediator` 抽象（4 policy strategies）—— PR 22b/3 之后从 first-responder / nonInteractive ControlDispatcher / channels BridgeClient 三处独立实现统一为 1 个 mediator。

---

## 一、三层权限模型

```
┌──────────────────────────────────────────────────────────────────┐
│ Layer 1：传输层 Bearer Token + clientId stamping + mutation gate    │
│ ├─ daemon 启动: QWEN_SERVER_TOKEN env / --token flag (PR#3889 ✅)  │
│ ├─ AuthMiddleware: SHA-256 + crypto.timingSafeEqual                │
│ ├─ 401 uniform across missing / bad-scheme / wrong                 │
│ ├─ X-Qwen-Client-Id: client_<randomUUID> (PR#4231 ✅)              │
│ │   ↳ daemon 端 stamping，122 bits entropy，缺失 401                 │
│ └─ --require-auth flag (PR#4236 ✅ Wave 4 启动)                     │
│     ↳ CONDITIONAL_SERVE_FEATURES 4-cell behavior matrix            │
└──────────────────────────────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────────────────┐
│ Layer 2：应用层 Permission Flow（PR#3723 + PR#4232 ✅）              │
│ ├─ L3: Tool 内置默认权限                                            │
│ ├─ L4: PermissionManager 规则覆盖（allowlist/deny）                 │
│ ├─ L5: 调用方覆盖（YOLO / AUTO_EDIT / PLAN / daemon-http）           │
│ ├─ session-scoped permission route (PR#4232 ✅)                     │
│ │   ↳ POST /session/:id/permission/:requestId                      │
│ │   ↳ bounded record（同 sessionId 同 requestId 只能投一次）          │
│ │   ↳ parsePermissionOutcome() 共享 helper                          │
│ └─ finalPermission: allow / deny / ask                              │
└──────────────────────────────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────────────────┐
│ Layer 3：审计层（Wave 4 PR 17 FS boundary 强约束 PR#4282 ✅）         │
│ ├─ originatorClientId stamping (每次 mutation 必须带)               │
│ ├─ SHA-256-hashed paths（audit log 不存 raw path）                  │
│ └─ typed-error 设计哲学（errorKind / TrustGateError 跨 PR 复用）       │
└──────────────────────────────────────────────────────────────────┘
                       ↓
                tool 执行 / 拒绝 / 弹审批
```

### Mode B 认证默认值

2026-05-15 后 roadmap 先只推进 Mode B（`qwen serve`）。Mode A（`qwen --serve`）保留为 parking lot，不再作为近期 Stage 1.5 主线。

| 维度 | Mode B（`qwen serve`）|
|---|---|
| 默认 auth | loopback 可无 token；非 loopback 必须 bearer token |
| 默认 listen | `127.0.0.1`（需显式 `--hostname 0.0.0.0` 才暴露远端）|
| CORS / Origin | 默认拒绝 browser Origin；Stage 2/后续 named `--allow-origin` |
| 关键场景 | 服务器 / 容器 / 远端机器 / TUI、channels、web、IDE client 统一 runtime |

本章下面的机制均按 Mode B 描述；未来若 Mode A 重新评估，应复用相同 permission / auth contract，而不是引入第二套权限语义。

---

## 二、Layer 1：传输层 Bearer Token（Stage 1 ✅ 实现）

### 启动配置

```bash
# 方式 A：环境变量（推荐 production / scripting）
QWEN_SERVER_TOKEN=$(openssl rand -hex 32) qwen serve

# 方式 B：CLI flag（推荐手动 / 测试）
qwen serve --token=$(openssl rand -hex 32)
```

Mode B 默认：未设 token 时 daemon 启动时随机生成一次性 token + 写入 `~/.qwen/serve/token`（0600 权限）；SDK / CLI 默认从该路径读取。

### 关键安全特性（PR#3889 commit `ad0e6ec06`）

| 特性 | 实现 |
|---|---|
| **timing-safe compare** | SHA-256 hash + `crypto.timingSafeEqual`——防 side-channel timing attack |
| **401 uniform** | "missing header" / "bad scheme" / "wrong token" 三种情况返回**完全一致**——防 side-channel 探测 |
| **0.0.0.0 + 无 token = 拒绝启动** | `--hostname 0.0.0.0` 必须配 `--token` 或 `QWEN_SERVER_TOKEN`，否则 boot refuses |
| **Host allowlist** | loopback 绑定时 Host 白名单（防 DNS rebinding）：`localhost:port` / `127.0.0.1:port` / `[::1]:port` / `host.docker.internal:port` |
| **IPv6 loopback** | `LOOPBACK_BINDS` 含 `::1` / `[::1]` |
| **CORS** | 默认拒绝所有 browser Origin |

### 0.0.0.0 + 无 token 拒绝启动设计依据

OpenCode 无 token 也启动（仅警告 "unsecured"）；Qwen 选择**直接拒绝启动**——理由：
- Qwen 默认服务对象包含 IM 用户（不只是开发者本地用），暴露公网风险更高
- 强制安全 default 是对用户负责（避免"开发时不开 token 直接走勿勿上线"）

### `X-Qwen-Client-Id` 头：daemon-stamped clientId（PR#4231 ✅ Wave 2 PR 7）

```
client → daemon:  POST /session  →
daemon → client:  201 Created
                  Set-Cookie / response body: { clientId: "client_<randomUUID>", ... }

subsequent:
client → daemon:  POST /session/:id/prompt
                  Authorization: Bearer <token>
                  X-Qwen-Client-Id: client_<randomUUID>   ← 缺失或不匹配 → 401
```

| 维度 | 设计 |
|---|---|
| **生成方** | daemon（`crypto.randomUUID()`），client 不允许自挑 |
| **熵** | 122 bits（randomUUID v4 standard）—— 防 brute-force 枚举 |
| **前缀** | `client_` —— log / audit 行可以前缀 grep 识别 |
| **作用域** | per-daemon-process；daemon restart → 新 clientId set；client 看到 401 → 重新走 `POST /session` 拿 |
| **强制路径** | 所有 mutation routes（PR#4236 启动 mutation gate 之后）+ permission vote |
| **审计** | audit log 用 `originatorClientId` field 标 mutation 触发方 |

### `--require-auth` mutation gate（PR#4236 ✅ Wave 4 启动 PR 15）

```bash
# Wave 4 起，写路由默认走 mutation gate
qwen serve --require-auth   # 所有 mutation 路由 401 if 无 bearer + clientId
```

**CONDITIONAL_SERVE_FEATURES 4-cell behavior matrix**：

| | `gate=on` | `gate=off` |
|---|---|---|
| **`auth=present`**（bearer + clientId 都有）| ✅ mutation 路由开放；capability `auth_device_flow` 不暴露（已 auth） | ✅ 兼容 PR#3889 行为 |
| **`auth=absent`** | 🚫 mutation 路由 401；capability `auth_device_flow` 暴露（让 client 走 device flow 拿 token）| ⚠️ legacy 模式（不推荐 production）|

`/capabilities` 根据 4-cell 状态决定是否暴露 capability tag —— client 看到 `auth_device_flow` 时知道走 PR#4255 device flow，看不到时知道 already authed。

---

## 三、Layer 2：应用层 Permission Flow（复用 PR#3723）

### 决策

**复用 PR#3723 共享 L3→L4 permission flow + daemon 加为第 4 种 execution mode**。

```typescript
type ExecutionMode = 'interactive' | 'non-interactive' | 'acp' | 'daemon-http'
```

PR#3723（已合并 +461/-95）把 Interactive / Non-Interactive / ACP 三模式的 L3→L4 决策合一为 `evaluatePermissionFlow()`。daemon 是第 4 种 mode，复用同一份决策逻辑——bug 修一处全 mode 受益。

### `daemon-http` mode 关键差异

ACP mode 是 stdio 单 client 同步等待；`daemon-http` mode 是多 client + HTTP 异步：

| 维度 | ACP mode | daemon-http mode |
|---|---|---|
| client 数 | 1 | N（同 session 多 subscriber）|
| `ask` 决策传递 | 直接 stdio 双向 RPC | SSE 推 `permission_request` + HTTP `POST /permission/:requestId` 应答 |
| 应答 | client 阻塞等待 → response | 任意 client first-responder wins |
| 超时 | client 端处理 | 60s 默认 deny |

---

## 四、Permission Cache 与 Multi-Session

### Stage 1 (commit `6a170ef8`) 现状

- **Permission decisions cache 是 per-`qwen --acp` child（= per-workspace）**
- 同 workspace N session 各自维护 PermissionManager（每个 ACP `Session` 实例内）
- `workspace` / `global` scope decisions 文件 **per-workspace 共享**——同 daemon N session 并发写时需 in-memory mutex（per-file lock）
- first-responder vote 路由按 sessionId 隔离——A session 的 `permission_request` 走 daemon 内部 EventBus，并通过 SSE 只 fan-out 到订阅 A session 的 client，不会泄漏到 B session 的订阅者

### Stage 2e native in-process（可选演进）

跨 workspace 共享时需 key 加 workspace 维度（`(workspace, sessionId, toolName, resource) → decision`）；同 daemon 内多 workspace 隔离仍由应用层保证。

### Persistence scope（per-tool decisions）

| Scope | 存储 | 生命周期 |
|---|---|---|
| `session` | 内存（per-Session）| daemon 退出即失效 |
| `workspace` | `~/.qwen/workspaces/<wsId>/permissions.json` | 启动时加载，per-daemon 共享 |
| `global` | `~/.qwen/permissions.json` | 启动时加载，daemon process 全局 |

---

## 五、Permission Vote 流（PR#3889 + PR#4232 ✅ 完整）

### 完整流程（Wave 2 PR 8 PR#4232 ✅ 落地后）

```
1. agent 内代码: PermissionManager.evaluate('Bash', {cmd: 'npm test'})
2. flow 走到 L4 = 'ask' → 推送 permission_request event 到 daemon 内部 EventBus
3. daemon broadcasts 'permission_request' SSE event 到 session 所有 subscriber
4. HTTP request 挂起（pending in `pendingPermissions` Map per sessionId）
5. 任意 client `POST /session/:sessionId/permission/:requestId` 应答（first-responder）
   ↑ Wave 2 PR#4232 之前是 global `POST /permission/:requestId`
   ↑ Wave 2 PR#4232 之后 session-scoped → cross-session 串号攻击被关闭
6. parsePermissionOutcome() 共享 helper 解析 body → outcome
7. bounded record 检查：同 (sessionId, requestId) 已 resolved → 返回 409 + 推 'permission_already_resolved'
8. 否则 PermissionManager 解锁 HTTP request → 继续 tool 执行
9. SSE 推 `permission_resolved` 让其他 client 知道结果（含 winning clientId, outcome）
10. cancelSession / shutdown 解锁 outstanding requests as `cancelled`（per ACP spec）
```

### bounded record 设计（PR#4232 关键 invariant）

```ts
// pseudocode
const resolved = new Map<`${sessionId}:${requestId}`, PermissionOutcome>()

POST /session/:sessionId/permission/:requestId {
  const key = `${sessionId}:${requestId}` as const
  if (resolved.has(key)) {
    sse.emit('permission_already_resolved', { sessionId, requestId, outcome: resolved.get(key) })
    return 409 // 不返回 outcome，防 client 误以为自己投赢
  }
  const outcome = parsePermissionOutcome(req.body)
  resolved.set(key, outcome)
  // ...
}
```

为什么是 **bounded**（不是 idempotent）：第二个 voter 必须明确收到"你输了"而非误以为自己投赢。`permission_already_resolved` event 把第一个 winning vote 的 outcome 推给所有 subscriber，让 UI 显式标记"已被 X client 应答"。

### `parsePermissionOutcome()` 共享 helper（PR#4232）

```ts
// 同一份解析逻辑用于 HTTP route / channels client / nonInteractive ControlDispatcher
type PermissionOutcome =
  | { kind: 'allow' }
  | { kind: 'allow_once' }
  | { kind: 'allow_with_scope'; scope: 'session' | 'workspace' | 'global' }
  | { kind: 'deny' }
  | { kind: 'cancel' }

export function parsePermissionOutcome(body: unknown): PermissionOutcome { ... }
```

共享 helper 是 [§06 §三 Wave 5 PR 24 `PermissionMediator`](./06-roadmap.md) 抽象的前置 —— 现在 3 处独立解析，未来统一进 mediator。

### 6 种 Permission Policy（Stage 2a permission_request schema 预留）

> chiga0 [PR#3889 audit](https://github.com/QwenLM/qwen-code/pull/3889) 指出 first-responder 缺 authorization model 风险：daemon 升级为 1:N 广播后没有 client identity 区分，**bot client 可在 human 看到前自动 approve**。即使 Stage 1 只实现 first-responder，schema 应预留 policy 字段。

```jsonc
// SSE event: permission_request
{
  "type": "permission_request",
  "requestId": "r1",
  "tool": "Bash",
  "args": { "cmd": "npm test" },
  "policy": "first-responder",     // Stage 2a schema 预留
  "designatedClientIds": null,      // policy='designated' 时填
  "quorumRequired": null            // policy='quorum' 时填
}
```

### Stage 1.5b/P1 finding 3 — `PermissionMediator` interface lift

> chiga0 [comment 4427773706](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427773706) finding 3：当前 daemon 的 first-responder + `nonInteractive/ControlDispatcher` + `channels/BridgeClient` 是同一概念的 3 个独立实现。Stage 1.5b/P1 抽 `PermissionMediator` interface + 4 种 strategy policy，让 daemon HTTP/SSE、channels、stream-json 等路径共享同一 mediator：

```ts
interface PermissionMediator {
  request(req: PermissionRequest, policy?: PermissionPolicy): Promise<PermissionOutcome>;
}
type PermissionPolicy =
  | { kind: 'first-responder' }              // Stage 1 默认
  | { kind: 'designated'; clientId: string } // 多用户场景：指定 client 才能批
  | { kind: 'consensus'; minVotes: number }  // quorum 模式
  | { kind: 'local-only' };                  // 当前 TUI behavior（local-jsx，不出 wire）
```

详 [§06 §三 1.5-prereq](./06-roadmap.md#15-prereq--mode-b-event-contract--bridge-primitives) 与 cross-module refactor findings。

---

## 六、Multi-Tenant 关键约束

> ✅ **1 daemon = 1 workspace 模式下天然 OS 进程级隔离**：跨 tenant = 跨 daemon process，无需应用层 tenant 抽象。

### 隔离形态

[§02 §2](./02-architectural-decisions.md#2-状态进程模型核心决策) 1 daemon = 1 workspace × N session 模式下：

- **跨 tenant 部署 = 多 daemon process**：1 daemon = 1 tenant × 1 workspace，OS 进程级真隔离
- **systemd `MemoryMax=` / cgroup / docker `--memory` 直接 = per-tenant quota**——不需要 daemon 内部抽象
- **同 daemon N session 共 OS 权限**（同 `qwen --acp` child，共 user UID + fs 视图；MCP children 当前随 session config 创建但仍在同 UID/workspace 信任域内）——天然 1 tenant 内 N session 共信任域

### 同 daemon N session 边界（注意）

⚠️ 同 daemon N session 共享 OS 权限——即同 tenant 内 N session 共信任域。**不可让多 tenant 共一个 daemon**：

- 1 daemon 启动时绑定 1 tenant 的 1 workspace（启动 cwd + 启动用户）
- 多 tenant 必须各自独立 daemon process（orchestrator 在创建 daemon 时绑 daemon → tenant）

详 [§06 §5.2 Multi-tenancy](./06-roadmap.md#52-multi-tenancy--oidc--quota--audit)。

### 并发写 race condition

- **Stage 1**：同 workspace N session 并发写 `workspace` / `global` scope decisions / settings 时需 in-memory mutex（per-file lock）防 lost update。`session` scope 仍 per-session 私有不冲突
- **多 daemon 并发写**：由 orchestrator 层处理（SQLite `permission_decisions` 表 + WAL）；跨 daemon process 不共享 in-memory state，需 orchestrator 协调

---

## 七、PR#3726 Monitor permission namespace（已合并）

PR#3726（已合并）为 `Monitor` 工具加了独立 permission namespace：

```
Monitor(*)         # 所有 monitor 调用允许
Monitor(npm test)  # 仅 npm test 允许
```

daemon 模式下完全兼容——`evaluatePermissionFlow()` 已识别此 namespace；用户在远端 client 应答 permission_request 时填写规则会保存到 daemon 进程 settings。

---

## 八、OAuth device-flow + BrandedSecret（PR#4255 ✅ Wave 4 PR 21 / 史上最难合）

> PR#4255 ✅ MERGED 2026-05-18 —— 20h39m / +4828 / 35 文件 / **135 reviews** / 4 reviewer voices —— Wave plan 第一名所有维度最高纪录。

### RFC 8628 device-flow（仅 daemon host）

```
1. client → daemon:    POST /workspace/auth/device-flow
   daemon → provider:  POST oauth/device/code (provider 端点)
   daemon → client:    { user_code: "ABCD-EFGH", verification_uri, interval, expires_in }
2. client UI 显示 user_code + verification_uri 让用户在浏览器手动登录
   ↑ 浏览器在 client 端开（IDE / TUI / web），不是 daemon 端
3. client → daemon:    POST /workspace/auth/device-flow/poll （every `interval` seconds）
   daemon → provider:  POST oauth/token (grant_type=device_code)
   daemon → client:    { status: 'authorized' | 'pending' | 'expired' | 'denied' }
4. 成功后 daemon host 持久化 token 到 ~/.qwen/auth/<provider>.json（0o600）
```

| 维度 | 设计 |
|---|---|
| **浏览器开在哪** | client host（远端 IDE / TUI / web），**不是 daemon host**——因为 daemon 经常在容器 / SSH server 上无 GUI |
| **token 落地** | daemon host `~/.qwen/auth/`（runtime locality —— 跟 provider call 同一台机器，[§04 §五](./04-deployment-and-client.md)）|
| **build-time grep** | CI 跑 `grep` 防 client-side 代码 `child_process.exec('open ...')` / `spawn('xdg-open')`—— 早期 dev 实现误把浏览器开在 daemon 上 |

### BrandedSecret 4-way redaction（PR#4255 核心 invariant）

```ts
declare const __brand: unique symbol
export type BrandedSecret<TName extends string> = string & { readonly [__brand]: TName }

// 4-way redaction：序列化路径全堵
class _Secret<T extends string> implements BrandedSecret<T> {
  toString() { return '[REDACTED]' }              // 1
  [Symbol.for('nodejs.util.inspect.custom')]() { return '[REDACTED]' }  // 2
  toJSON() { return '[REDACTED]' }                // 3
  valueOf() { return '[REDACTED]' }               // 4 + 5（template-literal coercion）
  // 只能通过显式 .unwrap() 拿原值，调用点会出现在 grep / audit 里
  unwrap(): string { return this.#raw }
}
```

| 序列化路径 | redaction |
|---|---|
| `console.log(secret)` | `[REDACTED]`（toString / inspect.custom）|
| `JSON.stringify({ token: secret })` | `{ "token": "[REDACTED]" }`（toJSON）|
| `\`Bearer ${secret}\`` | `Bearer [REDACTED]`（valueOf 触发 template-literal coercion）|
| `process.env.X = secret` | `[REDACTED]`（env 赋值 → string coercion → valueOf）|

**6 leak-path coverage tests**（PR#4255 reviewer 卡 review 反复确认）：
1. logger.info(`token=${secret}`) → assert 输出含 `[REDACTED]` 不含 raw
2. `JSON.stringify(authState)` → 不含 raw
3. `util.inspect(authState)` → 不含 raw
4. Error message thrown 含 `[REDACTED]`
5. SSE event `{ data: { token: secret } }` 序列化后 → `[REDACTED]`
6. Express response body 序列化 → `[REDACTED]`

### 0o600 file mode（umask-respecting）

```ts
// ~/.qwen/auth/<provider>.json 写入时强制 mode 0o600
await fs.writeFile(path, JSON.stringify({ token: secret.unwrap() }), {
  mode: 0o600,
  flag: 'w',
})
// 不依赖 umask —— 即使 user 的 umask 是 022，文件依然是 -rw-------
```

---

## 九、typed-error 设计哲学（cross-PR 复用模式）

> daemon 内部用富类型 `Error` 子类保留 stack / cause / metadata；HTTP wire 序列化降级到 7-value `errorKind` enum（[§03 §八 closed `errorKind` taxonomy](./03-http-api.md#八closed-errorkind-7-value-taxonomypr4251-)）。这是从 PR#4251 立 `errorKind` 起跨 PR 反复复用的模式：

| PR | typed error | 用途 |
|---|---|---|
| **PR#4251** ✅ | `errorKind` 7-value taxonomy | HTTP wire 错误降级 enum |
| **PR#4247** ✅ | preflight / env diagnostics | 返 actionable error detail（含 errorKind）|
| **PR#4255** ✅ | OAuth `AuthError` 子类 | wire 上 `errorKind: 'auth_env_error'` |
| **PR#4282** ✅ | `TrustGateError`（FS boundary 越界） | wire 上 `errorKind: 'missing_file'` —— path 经 SHA-256 hash 后入 audit log |
| **PR#4295** ✅ Wave 5 22a | `BridgeTimeoutError` / `BridgeChannelClosedError` / `MissingCliEntryError` | daemon 内 bridge primitives —— typed error 解耦 child runtime, 为 Stage 2 native in-process 开 seam |

### audit hook 输出格式

```jsonc
// daemon audit log entry（PR#4282 FS boundary 强约束之后）
{
  "ts": "2026-05-18T12:00:00.000Z",
  "originatorClientId": "client_<uuid>",     // PR#4231 stamping
  "sessionId": "sess_<uuid>",
  "tool": "Write",
  "pathSha256": "abcd...",                   // PR#4282 path 不存 raw
  "outcome": "deny",                          // parsePermissionOutcome 解析结果
  "errorKind": "missing_file"                 // 7-value taxonomy
}
```

audit log 不存 raw path —— 即使 log forwarding 到第三方 SIEM，也不泄漏文件名 / 路径结构。

---

## 十、生产部署 best practice — runtime locality + egress 策略

> 来源：chiga0 [Issue #3803 comment 4458840712](https://github.com/QwenLM/qwen-code/issues/3803#issuecomment-4458840712)。Mode B daemon 是 **runtime owner**——所有 MCP / skill / shell / LSP / tool execution / provider auth / file access 在 daemon host 上 evaluate（详 [§04 §五 Runtime locality / environment contract](./04-deployment-and-client.md#五runtime-locality--environment-contract)）。

### 网络 egress 策略

- **默认 deny-by-default + explicit allowlist**：daemon host/pod 只允许 configured providers / MCP servers / skills 实际所需的 network surface
- **不需要 daemon 开放公网**：根据 provider 端点 / MCP HTTP/SSE endpoints / skill 调用的外部 API 列 allowlist
- **诊断**：通过 Stage 1.5c 的 `GET /workspace/preflight` route 暴露 daemon-side egress 检测结果让 client 渲染 actionable error

### 凭据 / Secrets 在 daemon host

| 类型 | 位置 |
|---|---|
| Provider OAuth tokens | daemon host `~/.qwen/auth/*` |
| API keys / env vars | daemon process env (从 secret manager / k8s secret 注入) |
| MCP server credentials | MCP config 中引用或 daemon host env |
| SSH agent / kubeconfig | daemon host 本地（client 端的不会自动传过来）|

**关键**：client 端的 credentials 不会自动可用——必须 daemon host 自己持有。多 tenant 场景下，1 daemon = 1 tenant 时 credentials per-daemon process 隔离最干净。

### 部署 checklist

- [ ] daemon host 安装 MCP server 所需 runtime（`node` / `uv` / `python` / docker / cloud CLIs）
- [ ] daemon host env vars / secrets / kubeconfig 等已 provision
- [ ] Skills 目录（`~/.qwen/skills` / `<workspace>/.qwen/skills`）已同步到 daemon filesystem
- [ ] daemon host/pod 网络策略允许 configured providers + MCP HTTP/SSE endpoints
- [ ] Stage 1.5c 后通过 `GET /workspace/preflight` + `GET /workspace/env` 暴露诊断给 client
- [ ] `GET /workspace/mcp` / `GET /workspace/skills` 返回 actionable error detail（不只是布尔状态）

---

下一篇：[06 — Roadmap & Ecosystem →](./06-roadmap.md)
