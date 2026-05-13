# 05 — Security & Permission

> [← 上一篇：Deployment & Client](./04-deployment-and-client.md) · [下一篇：Roadmap & Ecosystem →](./06-roadmap.md)

## TL;DR

**双层权限模型**：传输层 Bearer token（PR#3889 ✅ MERGED 2026-05-13）+ 应用层复用 PR#3723 `evaluatePermissionFlow()`（daemon 作为第 4 种 execution mode）。**默认安全策略**：0.0.0.0 binding + 无 token = 拒绝启动。**Permission 分发**：first-responder vote（任意 client 抢答），per-session 隔离（cross-session permission_request 不泄漏）。

**Stage 1.5+ 候选**：per-request `sessionScope` override / Stage 1.5 must-have #3 pair tokens + revocation API / chiga0 finding 3 `PermissionMediator` 抽象（4 policy strategies）。

---

## 一、双层权限模型

```
┌────────────────────────────────────────────────────┐
│ Layer 1：传输层 Bearer Token（PR#3889 已实现）         │
│ ├─ daemon 启动: QWEN_SERVER_TOKEN env / --token flag │
│ ├─ AuthMiddleware: SHA-256 + crypto.timingSafeEqual  │
│ └─ 401 uniform across missing / bad-scheme / wrong   │
└────────────────────────────────────────────────────┘
                       ↓
┌────────────────────────────────────────────────────┐
│ Layer 2：应用层 Permission Flow（PR#3723 已合并）      │
│ ├─ L3: Tool 内置默认权限                              │
│ ├─ L4: PermissionManager 规则覆盖（allowlist/deny）   │
│ ├─ L5: 调用方覆盖（YOLO / AUTO_EDIT / PLAN / daemon-http）│
│ └─ finalPermission: allow / deny / ask                │
└────────────────────────────────────────────────────┘
                       ↓
                tool 执行 / 拒绝 / 弹审批
```

### 双部署模式认证默认值

| 维度 | Mode A（`qwen --serve`）| Mode B（`qwen serve`）|
|---|---|---|
| 默认 auth | `none`（loopback only）| `bearer`（生成 token + 写 `~/.qwen/serve/token`）|
| 默认 listen | `127.0.0.1` | `127.0.0.1`（需显式 `--host 0.0.0.0`）|
| CORS / Origin | loopback only | 配置驱动 |
| 关键场景 | 终端用户本地 + 同机 IDE / WebUI | 服务器 / 容器 / 远端机器 |

本章详细机制 **两种模式完全一致**——Mode A 默认关 bearer（loopback 信任）但可显式 `--token` 启用。

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
- `workspace` / `global` scope decisions 文件 **per-workspace 共享**——同 bridge N session 并发写时需 in-memory mutex（per-file lock）
- first-responder vote 路由按 sessionId 隔离——A session 的 `permission_request` 走 EventBus 只 fan-out 到订阅 A session 的 client，不会泄漏到 B session 的订阅者

### Stage 2e native in-process（可选演进）

跨 workspace 共享时需 key 加 workspace 维度（`(workspace, sessionId, toolName, resource) → decision`）；同 daemon 内多 workspace 隔离仍由应用层保证。

### Persistence scope（per-tool decisions）

| Scope | 存储 | 生命周期 |
|---|---|---|
| `session` | 内存（per-Session）| daemon 退出即失效 |
| `workspace` | `~/.qwen/workspaces/<wsId>/permissions.json` | 启动时加载，per-bridge 共享 |
| `global` | `~/.qwen/permissions.json` | 启动时加载，daemon process 全局 |

---

## 五、Permission Vote 流（PR#3889 commit `6ee655f0a` 已实现）

### 完整流程

```
1. agent 内代码: PermissionManager.evaluate('Bash', {cmd: 'npm test'})
2. flow 走到 L4 = 'ask' → 推送 permission_request event 走 EventBus
3. daemon broadcasts 'permission_request' SSE event 到 session 所有 subscriber
4. HTTP request 挂起（pending in `pendingPermissions` Map）
5. 任意 client `POST /permission/:requestId` 应答（first-responder）
6. PermissionManager 解锁 HTTP request → 继续 tool 执行
7. SSE 推 `permission_resolved` 让其他 client 知道结果
8. cancelSession / shutdown 解锁 outstanding requests as `cancelled`（per ACP spec）
```

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

### Stage 1.5-prereq finding 3 — `PermissionMediator` interface lift

> chiga0 [comment 4427773706](https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427773706) finding 3：当前 daemon 的 first-responder + `nonInteractive/ControlDispatcher` + `channels/BridgeClient` 是同一概念的 3 个独立实现。Stage 1.5-prereq 抽 `PermissionMediator` interface + 4 种 strategy policy 让 4 路 expose 路径共享同一 mediator：

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

详 [§06 §三 Stage 1.5-prereq](./06-roadmap.md#1.5-prereq--chiga0-6-architecture-refactor-findings)。

---

## 六、Multi-Tenant 关键约束

> 🚨 **同 daemon 同 workspace N session 共 OS 权限**（同 `qwen --acp` child，共 user UID + fs 视图 + MCP children）—— 多 tenant 必须避开此边界。

### Default mode 下 = 天然 1 tenant per daemon

[§02 §2](./02-architectural-decisions.md#2-状态进程模型核心决策) Default = 1 daemon = 1 workspace 模式下，**多 tenant 走 OS 进程级真隔离**（1 daemon = 1 tenant × 1 workspace），无需应用层 tenant 抽象。systemd `MemoryMax=` / cgroup / docker `--memory` 直接 = per-tenant quota。这是 Qwen 主推的多 tenant 部署形态。

### Advanced `--multi-workspace` 模式下的约束

**不可让多 tenant 共一个 Workspace Bridge**（同 `qwen --acp` child 内 N session 共 OS 权限）——orchestrator 必须在以下两层之一做 1:1 tenant 绑定：

| 隔离层 | 实现 | 适用 |
|---|---|---|
| **Workspace 层** | 1 tenant ↔ 1 workspace（或多 workspace 但全归同 tenant）| advanced 模式默认场景；orchestrator 在创建 daemon 时绑 workspace → tenant |
| **Daemon process 层（推荐高安全）** | 1 tenant ↔ 独立 daemon process（= default mode）| 高合规场景；跨 tenant 走 OS 进程级隔离 + per-tenant resource quota |

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

下一篇：[06 — Roadmap & Ecosystem →](./06-roadmap.md)
