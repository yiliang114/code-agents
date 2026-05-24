# Qwen Code daemon (`qwen serve`) 用户使用文档

> Recipe-oriented，面向 daemon Mode B **终态**（feature-complete production-ready 状态）的使用方法。涵盖启动、客户端接入、常用操作、生产部署、故障排查。

## TL;DR

`qwen serve` 启动一个本地 HTTP daemon，把 qwen-code 的 agent 能力暴露给**多种 client**（web chat / web terminal / IDE / Zed / Goose / 自动化脚本）—— 不用每个 client 自己 spawn `qwen --acp` child。

**典型场景**：
- 🖥️ 浏览器里跑 web chat / web terminal，让 agent 操作本地 repo
- ☁️ 远端 cloud devbox / Codespaces / K8s pod 跑 daemon，本地浏览器/IDE 连进去
- 🧑‍🤝‍🧑 同一 session 多 tab 协作，shared permission 审批
- 🤖 Zed / Goose 等 ACP-native client 接入（走 `/acp` 端点）
- 🔁 CI / 自动化脚本通过 HTTP 调用 agent

**`qwen serve` ≠ 替代 `qwen` CLI**。本地单人开发不需要多 client / 不需要 web UI，**继续用 `qwen` native TUI**（直连本地 runtime，零网络 / 最低复杂度）。daemon 是给上面那些场景的，不是给 TUI 用户的。

### 按需阅读导航

| 你是 | 跳到 |
|---|---|
| 第一次配 daemon，5 分钟跑起来 | [§一 快速上手](#一快速上手5-分钟) → [§五 常用操作 recipes](#五常用操作-recipes) |
| 想理清术语（bearer / session / workspace / clientId 等）| [§〇 核心概念](#〇核心概念) |
| 配启动参数 / 安全启动 | [§二 启动选项](#二qwen-serve-启动选项) |
| 选客户端接入方式（SDK / curl / ACP / web-shell）| [§四 客户端接入](#四客户端接入) |
| 上 systemd / Docker / K8s 生产 | [§八 生产部署](#八生产部署) |
| 出问题排查 | [§七 诊断 & 故障排查](#七诊断--故障排查) → 附录 B decision tree |
| 选 Permission strategy（多 client 协作）| [§2.5 Permission strategy 选择](#25-permission-strategy-选择) |

---

## 〇、核心概念

> 后续章节会反复用到的术语，**先在这里把心智模型建好**，遇到生词回来查。

### 进程与状态

| 术语 | 含义 |
|---|---|
| **`qwen serve`** | 启动 daemon 的命令；起一个 HTTP server 进程，里面再 spawn 一个 `qwen --acp` agent 子进程 |
| **daemon** / **daemon process** | `qwen serve` 起的 HTTP server 进程本身，对外是 northbound transport，对内 spawn ACP agent |
| **ACP child** | daemon 内嵌的 `qwen --acp` 子进程，真正执行 LLM 调用 / tool / shell / MCP / skill 的 runtime |
| **workspace** | daemon 启动时绑定的**一个**绝对路径目录（默认 `process.cwd()`，可 `--workspace` 指定）。**1 daemon = 1 workspace**，要支持多 workspace 就起多个 daemon process 各占一个端口 |
| **session** | 一段对话上下文（含 transcript / FileReadCache / PermissionManager）。**1 daemon = N session 复用同一个 ACP child**，session 之间隔离但共享同一 workspace |

### 客户端身份与认证

| 术语 | 含义 |
|---|---|
| **client** | 调 daemon 的程序：web chat / SDK / curl 脚本 / VSCode 插件 / Zed / Goose 等。**一个 daemon 可被多 client 同时连接**（每个 client 可订阅同一个 session 的事件） |
| **bearer token** | HTTP 标准 `Authorization: Bearer <token>` 认证。daemon 启动时设（`QWEN_SERVER_TOKEN` env / `--token` flag / 自动生成）。详 [§2.2](#22-bearer-token-认证基础) |
| **`X-Qwen-Client-Id`** | daemon 第一次见到 client 时 stamp 给它的 122-bit randomUUID，**daemon 生成、client 不能伪造**。所有 mutation 请求必须带，permission 投票用它判 "哪个 client 在投" |

### 协议表面

| 术语 | 含义 |
|---|---|
| **REST + SSE** | daemon 的主 northbound transport：HTTP request/response + `text/event-stream` 长连接推 `session_update` / `permission_request` 等 typed event |
| **`/acp`** | 第二 northbound transport ([RFD #721](https://github.com/agentclientprotocol/agent-client-protocol/pull/721) ACP Streamable HTTP)，让 Zed / Goose 等 ACP-native client 直接接入。env `QWEN_SERVE_ACP_HTTP=0` 关 |
| **capability tag** | `GET /capabilities` 返回的 feature flag 字符串数组（如 `session_lifecycle` / `mcp_workspace_pool`）；client 用 `if (caps.features.includes(...))` 判断 daemon 是否支持某能力，做优雅降级。完整列表见 [附录 A](#附录-acapability-tag-速查) |
| **`Last-Event-ID`** | SSE 标准头。client 重连时带上次见到的最大 event id，daemon 从 ring buffer 回拉断流期间的 missed events |

### 权限模型

| 术语 | 含义 |
|---|---|
| **permission request** | agent 调有副作用的 tool（如 `Bash`）时，daemon 通过 SSE 推 `permission_request` 给所有订阅 client 让用户审批 |
| **permission strategy** | 多 client 怎么投票决定批准/拒绝。4 种：`first-responder`（默认，任意 client 抢答）/ `designated`（仅 prompt 发起者）/ `consensus`（N-of-M 投票）/ `local-only`（仅 loopback）。详 [§2.5](#25-permission-strategy-选择) |
| **`--require-auth`** | 启用 mutation gate —— 所有写操作（mutation route）都强制带 bearer + clientId。loopback 默认免 token，这个 flag 强制 loopback 也要 |

### 文件 / MCP / 状态

| 术语 | 含义 |
|---|---|
| **sandbox-bounded** | 文件操作（read / write / edit）受 sandbox root 限制 + symlink_escape rejection —— agent 不能通过 symlink 写出 workspace 外 |
| **MCP transport pool** | N 个 session 共享同一个 MCP server 连接（按 `(name + config fingerprint)` keyed）—— `--mcp-client-budget=2` 是 workspace 上限 2 而非 2N |
| **typed event** | daemon SSE 推的事件都有 `type` 字段做 discriminated union；client 用 `switch (event.type)` 处理，未知 type fall through 不 throw —— forward-compat 设计 |
| **`errorKind` 7-值 taxonomy** | daemon HTTP 错误响应都带一个 closed enum `errorKind` (`missing_binary` / `blocked_egress` / `auth_env_error` / `init_timeout` / `protocol_error` / `missing_file` / `parse_error`)，client `switch` 处理而不是 regex match error message |

---

## 一、快速上手（5 分钟）

```bash
# 1) 装 qwen-code
npm install -g @qwen-code/qwen-code

# 2) 启动 daemon（loopback 默认免 token，仅本机可用）
cd /path/to/your/repo
qwen serve

# stderr 输出：
#   qwen serve listening on http://127.0.0.1:4170 (workspace=/path/to/your/repo)

# 3) 验证健康
curl -s http://127.0.0.1:4170/health
# {"status":"ok"}

# 4) 看能力清单
curl -s http://127.0.0.1:4170/capabilities | jq .

# 5) 建一个 session + 发 prompt + 流式读
SID=$(curl -s -X POST http://127.0.0.1:4170/session \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg ws "$PWD" '{sessionScope:"session", workspaceCwd:$ws}')" \
  | jq -r .sessionId)

# 后台订阅 SSE
curl -N -H "Accept: text/event-stream" \
  "http://127.0.0.1:4170/session/$SID/events" &

# 发 prompt
curl -s -X POST "http://127.0.0.1:4170/session/$SID/prompt" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":[{"type":"text","text":"hello"}]}'
```

跑通这 5 步就有 daemon 了。后面是把它做对、做安全、上生产的细节。

---

## 二、`qwen serve` 启动选项

### 2.1 基本 flag

| flag | 默认 | 说明 |
|---|---|---|
| `--port <N>` | `4170` | TCP 端口；`0` = OS 分配 ephemeral |
| `--hostname <addr>` | `127.0.0.1` | 绑定 interface；loopback (`127.0.0.1` / `localhost` / `::1` / `[::1]` / `host.docker.internal`) 默认免 token，其他必须配 token |
| `--token <hex>` | — | bearer token；**生产强烈建议走 env 而非 flag**（`--token` 在 `/proc/<pid>/cmdline` 任何本机用户可见，env 则只在 `/proc/<pid>/environ` owner-only）|
| `--workspace <abs path>` | `process.cwd()` | 绑死的 1 workspace 绝对路径，`POST /session` 携带不一致 cwd 返 `400 workspace_mismatch` |
| `--require-auth` | `false` | 即使 loopback 也强制 token；防共享 dev host / CI runner / 多租户工作站任意本地用户打 `127.0.0.1`；启用后 `/health` 也要 bearer |
| `--max-sessions <N>` | `20` | 并发活 session 上限，超出 spawn 返 503；attach 现有 session 仍可；`0` = 禁用 |
| `--max-connections <N>` | `256` | listener 级 TCP socket 上限（`server.maxConnections`），慢/僵尸 SSE client 在 accept time 被拒；`0` = 禁用 |
| `--event-ring-size <N>` | `8000` | per-session SSE 重放 ring 深度，`Last-Event-ID` 重连可回拉的 backlog 大小 |
| `--http-bridge` | `true` | Stage 1 模式（daemon 内嵌 `qwen --acp` child）；Stage 2 native in-process 是预留 |
| `--mcp-client-budget <N>` | — | **workspace-scope** MCP client 数 cap（N session 共享 transport，N 个 session × budget 2 是 2 而非 2N）；正整数 |
| `--mcp-budget-mode <off\|warn\|enforce>` | `warn` if budget set else `off` | budget 怎么 enforce：`off` 纯观测 / `warn` 75% 阈值发警告不拒 / `enforce` 超 cap 拒绝（按 `mcpServers` 声明顺序确定）；`enforce` 必须配 budget |

### 2.2 Bearer token 认证基础

> 看 §2.1 flag 表很多地方提"token"和"bearer"，先把这套机制说清楚再讲启动配方。

**什么是 bearer**：HTTP 标准认证 scheme（[RFC 6750](https://datatracker.ietf.org/doc/html/rfc6750)）—— 把 token 当"持有令牌"用，谁拿到这串字符串谁就能调 API，没有公私钥之类的非对称结构。请求头格式固定：

```
Authorization: Bearer <token>
```

**daemon 怎么用**：

```bash
# 启动时设 token（推荐 env 不要 --token，下面 token 来源优先级有解释）
export QWEN_SERVER_TOKEN=$(openssl rand -hex 32)
qwen serve --require-auth

# client 每个调用必须带：
curl http://127.0.0.1:4170/capabilities \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN"
```

**Token 来源优先级**（daemon 启动时）：

| 来源 | 推荐度 | 备注 |
|---|---|---|
| `--token <hex>` CLI flag | ❌ **不推荐生产** | `/proc/<pid>/cmdline` 任何本机用户可见（除非 hidepid=2）；启动时 stderr 也会 warn |
| `QWEN_SERVER_TOKEN` env var | ✅ **推荐** | `/proc/<pid>/environ` 仅 owner 可读 |
| 都没设 | (自动) | daemon 启动随机生成 + 写 `~/.qwen/serve/token`（0o600）；SDK 默认从这读 |

**Token 来源优先级**（client 端 SDK / web-shell）：

1. 显式传 `bearerToken` 参数
2. `QWEN_SERVER_TOKEN` env var
3. `~/.qwen/serve/token` 文件（如果存在）

**daemon 端实现细节**：

- **SHA-256 hash + `crypto.timingSafeEqual` 比对** —— 防 timing side-channel attack（不让攻击者从响应时间猜 token 字符）
- **401 uniform 响应** —— "缺 header" / "bad scheme（不是 Bearer）" / "token 错" 三种错误返回**完全一致**，防 side-channel 探测哪种错了
- **`0.0.0.0` + 无 token = boot 拒绝启动** —— 防开发时不开 token 直接走勿勿上线
- **loopback 默认免 token** —— 127.0.0.1 / localhost / ::1 / `[::1]` / host.docker.internal 五种 loopback 主机识别免 token；**`--require-auth` 启用后 loopback 也要 bearer**（且 `/health` 也要，K8s/Compose 健康探针需带 bearer）
- **Host header allowlist** —— loopback 绑定时同时 enforce Host 头白名单（防 DNS rebinding attack）

**bearer 不是全部 —— 还有 `X-Qwen-Client-Id` header**：

```
Authorization: Bearer <token>            ← 第 1 道：你有权访问 daemon 吗
X-Qwen-Client-Id: client_<uuid>          ← 第 2 道：你是哪个 client 在调
```

`X-Qwen-Client-Id` 是 daemon 第一次见到 client 时 stamp 的 122-bit entropy randomUUID（**daemon 生成，client 不能自己挑** —— 防 client 伪造身份）。所有 mutation route（`POST /workspace/memory` / `POST /workspace/file` / `POST /session/:id/permission/...` 等）都强制带；read-only route 也要带做 audit symmetry。permission strategy 如 `designated` 就用这个 id 判 "prompt originator 是不是你"。

**两者关系**：
- **bearer 解决"is this caller allowed in?"** —— 传输层访问控制
- **clientId 解决"which caller is this?"** —— 应用层身份与审计

**为什么不用 cookie / OAuth / JWT**：
- daemon 不是 web app —— 没有 browser session、没有 logout flow
- 主流 SDK client（IDE plugin / CLI tool / 自动化脚本）拿 bearer 比拿 OAuth 简单
- OAuth device-flow 是 **daemon 与上游 provider** 之间（让 daemon 代用户登录 Qwen / OpenAI 等），不是 client 与 daemon 之间 —— 别混淆，详见 [§5.6](#56-oauth-device-flow远端-daemon-auth-provider)

### 2.3 安全启动配方

**本机开发** —— 最省事：
```bash
cd /path/to/repo
qwen serve              # loopback 免 token，仅 127.0.0.1 可达
```

**本机但工作站多用户 / CI runner** —— 不让本机其他用户访问：
```bash
export QWEN_SERVER_TOKEN=$(openssl rand -hex 32)
qwen serve --require-auth          # 强制 token，loopback 也要 bearer
echo "$QWEN_SERVER_TOKEN" > ~/.qwen/serve/token
chmod 600 ~/.qwen/serve/token       # SDK 默认会从这读
```

**暴露远端**（远端 cloud devbox / k8s pod）：
```bash
export QWEN_SERVER_TOKEN=$(openssl rand -hex 32)
qwen serve --hostname 0.0.0.0 --port 4170
# ⚠️ 0.0.0.0 + 无 token = boot 拒绝启动（防开发时不开 token 直接走勿勿上线）
```

**Production hardened**（mutation routes 全 gate）：
```bash
export QWEN_SERVER_TOKEN=$(openssl rand -hex 32)
qwen serve --require-auth \
  --hostname 0.0.0.0 \
  --max-sessions 50 \
  --max-connections 500 \
  --mcp-client-budget 8 --mcp-budget-mode enforce
```

### 2.4 环境变量

| env | 说明 |
|---|---|
| `QWEN_SERVER_TOKEN` | bearer token（优先于 `--token`，**推荐生产用这个**）|
| `QWEN_SERVE_ACP_HTTP` | `0` opt-out `/acp` ACP Streamable HTTP transport（default on）|
| `QWEN_SERVE_MCP_POOL_TRANSPORTS` | MCP shared transport pool 接受的 transport 类型列表，默认 `stdio,websocket`；显式开 `http,sse` 才让 HTTP/SSE MCP transport 走 shared pool（HTTP/SSE 因 server 实现差异较大默认 opt-in） |
| `QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID` | `true` 让 metric 重新带 `session.id` —— 默认不带防 Prometheus/ARMS unbounded cardinality fan-out |
| `OTEL_RESOURCE_ATTRIBUTES` / `OTEL_SERVICE_NAME` | 标准 OTel resource attribute 注入（telemetry P3, `telemetry.resourceAttributes` setting 同效）|

### 2.5 Permission strategy 选择

`PermissionMediator` 4 个 strategy 通过 workspace `settings.json` opt-in（缺省 = `first-responder` 保 wire 字节 compat）：

```json
{
  "policy": {
    "permissionStrategy": "first-responder",
    "consensusQuorum": null
  }
}
```

| strategy | 行为 | 用例 |
|---|---|---|
| `first-responder`（缺省） | 任意 validated voter 抢答，后到 voter 收 `permission_already_resolved` | 本地单用户 / 默认 |
| `designated` | 仅 prompt originator client 能决；非 originator 403 `permission_forbidden / designated_mismatch`；anonymous prompt（无 `X-Qwen-Client-Id`）fall back first-responder | 远端多 client 但有"主控"client 的场景 |
| `consensus` | N-of-M voter 投票（default N = `floor(M/2)+1`，可 `policy.consensusQuorum` override），first option 到 quorum 赢；中间投票 fan out `permission_partial_vote` SSE event | 多人 review 工作流 |
| `local-only` | 仅 loopback voter 能决（**kernel-stamped `req.socket.remoteAddress`，不看 X-Forwarded-For 或任何 header**）；remote 403 `permission_forbidden / remote_not_allowed` | 远端 daemon 但 permission 只接受本地批准 |

修改后**重启 daemon 生效**（不支持热加载）。

---

## 三、2 种 deployment shape

> 核心不变式：**daemon host = workspace host = runtime host**。所有 fs / tool / MCP / skill / shell / 网络 egress / 凭据存取在 daemon 所在那台机器上 evaluate；如果你想"daemon 在远端但 workspace 在本地"，那是反模式——daemon 看不到 local files，`POST /session` 携带本地 cwd 会被 `400 workspace_mismatch` 拒。

### Shape 1: Local single-machine（本地单机）✅ 推荐

```
┌─────────────────────────────────────────┐
│ your laptop                             │
│   ┌──────────────┐    ┌──────────────┐  │
│   │ qwen serve   │←───│ web-shell /  │  │
│   │ workspace=   │    │  curl / SDK  │  │
│   │ /repo        │    └──────────────┘  │
│   └──────┬───────┘                      │
│   /repo  ↓ fs/tool/MCP/skill            │
└─────────────────────────────────────────┘
```

- daemon host = workspace host = client host = 都本机
- 用例：开发期跑 web-shell；多个 tab 同时连同一 daemon
- 提醒：**native TUI (`qwen`) 不走 daemon** —— 这个 shape 是给 web client / 多 tab 协作，不是替代 `qwen` CLI

### Shape 2: Cloud / devbox remote-runtime（远端 runtime + 本地 client）✅ 推荐

```
┌──────────────┐         HTTP/SSE         ┌──────────────────────────┐
│ your laptop  │   ───────────────────→   │ remote devbox / k8s pod  │
│              │                          │   ┌──────────────┐       │
│ browser /    │   ←───────────────────   │   │ qwen serve   │       │
│ SDK / IDE    │                          │   │ workspace=   │       │
└──────────────┘                          │   │ /workspace   │       │
                                          │   └──────┬───────┘       │
                                          │  /workspace ↓ fs/tool... │
                                          └──────────────────────────┘
```

- daemon host **==** workspace host（同一台远端机器/pod）
- client 在本地浏览器/IDE，通过 HTTP+SSE 与远端 daemon 对话
- 用例：Codespaces / Coder / 内部 cloud devbox
- 必须配 token + hostname 0.0.0.0 + TLS reverse proxy

---

## 四、客户端接入

daemon 对外提供 **两套 northbound transport 共存**，client 按生态选：

| transport | 端点 | 适合 |
|---|---|---|
| **REST + SSE**（qwen-specific dialect） | `/session` / `/workspace/*` / `GET /session/:id/events` SSE | qwen 官方 SDK / web-shell / VSCode companion / channels / curl |
| **ACP Streamable HTTP**（[RFD #721](https://github.com/agentclientprotocol/agent-client-protocol/pull/721) 标准） | `/acp` 单端点（POST/GET/DELETE）| Zed / Goose / 任何 ACP-native SDK |

两套 transport 共享同一 `HttpAcpBridge` + `EventBus` —— **同一个 session 可以从任一 transport 访问**。env `QWEN_SERVE_ACP_HTTP=0` 关 ACP HTTP。

### 4.1 TypeScript SDK：`DaemonSessionClient`

```ts
import { DaemonSessionClient } from '@qwen-code/sdk-typescript/daemon';

const client = new DaemonSessionClient({
  baseUrl: 'http://127.0.0.1:4170',
  bearerToken: process.env.QWEN_SERVER_TOKEN,    // 远端 / require-auth 时必填
});

// 1) 建 session
const { sessionId } = await client.createSession({
  workspaceCwd: process.cwd(),
  sessionScope: 'session',
});

// 2) 订阅 SSE 事件（typed discriminated union, PR#4217）
const unsubscribe = client.subscribe(sessionId, (event) => {
  switch (event.type) {
    case 'session_update':         /* LLM stream / tool call / result */  break;
    case 'permission_request':     /* 弹审批 */                            break;
    case 'permission_resolved':    /* first-responder 已应答 */            break;
    case 'permission_partial_vote':/* consensus 中间投票 */                break;
    case 'permission_forbidden':   /* designated / local-only 拒绝 */      break;
    case 'slow_client_warning':    /* ring 80% 满 */                       break;
    case 'state_resync_required':  /* ring evicted, 需要 loadSession 重建 */ break;
    case 'mcp_budget_warning':     /* workspace MCP 用量警告 */            break;
    case 'session_died':           /* child 死了 */                        break;
    case 'unknown':                /* 向前兼容新 daemon */                  break;
  }
});

// 3) 发 prompt（HTTP request 挂起到 prompt 完成）
await client.prompt(sessionId, [{ type: 'text', text: 'hello' }]);

// 4) 关 session
await client.closeSession(sessionId);
unsubscribe();
```

### 4.2 SDK 共享 daemon UI 层 `@qwen-code/sdk-typescript/daemon-ui`

如果你在写 web chat / web terminal client，**不要自己 reimplement** streaming merge / tool preview / permission state / shell output —— 用 SDK 提供的共享 UI 层：

```ts
import {
  createDaemonTranscriptState,
  reduceDaemonTranscriptEvents,
  daemonBlockToMarkdown,
  daemonBlockToPlainText,
  createDaemonSessionViewState,
} from '@qwen-code/sdk-typescript/daemon-ui';

// typed daemon events → UI events → transcript blocks → framework-free store
let viewState = createDaemonSessionViewState();
const events = await client.fetchEvents(sessionId);
viewState = reduceDaemonTranscriptEvents(viewState, events);

// 渲染到任何 framework（DOM chat / web terminal / Ink TUI 等）
const markdown = viewState.blocks.map(daemonBlockToMarkdown).join('\n\n');
```

包含 reducer 状态字段 `currentTool` / `approvalMode` / `awaitingResync` / `permissionVoteProgress` 等。


### 4.3 curl 直走 HTTP/SSE

**建 session**：
```bash
curl -s -X POST http://127.0.0.1:4170/session \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  -d "$(jq -nc --arg ws "$PWD" '{sessionScope:"session", workspaceCwd:$ws}')" \
  | tee /tmp/session.json
# {"sessionId":"sess_abc","clientId":"client_xyz","capabilities":{...}}
```

**订阅 SSE**（保持开着读流）：
```bash
SID=$(jq -r .sessionId /tmp/session.json)
curl -N -H "Accept: text/event-stream" \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  "http://127.0.0.1:4170/session/$SID/events"
# event: session_update
# id: 1
# data: {"id":1,"v":1,"type":"session_update","data":{...},"_meta":{"serverTimestamp":"2026-..."}}
```

**Last-Event-ID 重连**：SSE 断了之后续，daemon 从 ring buffer 回拉 missed events；如果 ring 已 evict 过这段，daemon 推 `state_resync_required` 合成终止帧让 client 走 `loadSession` 重建状态：

```bash
curl -N -H "Accept: text/event-stream" \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  -H "Last-Event-ID: 42" \
  "http://127.0.0.1:4170/session/$SID/events"
```

### 4.4 ACP-native client (Zed / Goose / RFD #721 SDK)

`/acp` 端点接 [RFD #721](https://github.com/agentclientprotocol/agent-client-protocol/pull/721) Streamable HTTP transport，让 ACP-native client 不需要懂 qwen-specific REST 方言就能驱动 daemon：

```bash
# 1) POST /acp {initialize} → 200 + capabilities + Acp-Connection-Id header
curl -s -X POST http://127.0.0.1:4170/acp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  -d '{"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"protocolVersion":1, "clientCapabilities":{...}}}' \
  | jq .
# 响应里抽 Acp-Connection-Id

# 2) GET /acp 带 Acp-Connection-Id header → connection-scoped SSE
# 3) 后续 POST /acp 都带 Acp-Connection-Id；其他 POST → 202，reply 走 SSE
# 4) DELETE /acp → 202 teardown
```

ACP 标准 method 直接走：`initialize` / `session/new` / `session/prompt` / `session/cancel` / `session/load`/`resume`/`close` / `session/request_permission`。

daemon-specific 扩展放在 **`_qwen/...` namespace**（ACP spec 保留 `_` 前缀）：
- `_qwen/session/set_model` —— 切 model
- `_qwen/session/heartbeat` —— client 心跳

这些 extension 在 `initialize` 响应里 advertise。

### 4.5 `/demo` 调试页

`/demo` 是单 HTML browser-based debug UI —— 最薄 POST+SSE 验证面：

```bash
qwen serve
# 浏览器打开 http://127.0.0.1:4170/demo
# 输入 token（如果 --require-auth）→ 发 prompt → 看 typed event 流
```

主要用于：联调 daemon 协议时验证 wire shape / 看 typed event payload / 复现 client bug。**不是 production UI**。

### 4.6 Web-shell（可选 reference web client）

`packages/web-shell` 是 daemon-backed React web-shell 参考实现 —— 接 daemon session / SSE / permission / slash command / model 切换 / approval mode / session resume / memory + MCP + skills + agents view / `/session/:id` URL restore，对齐 CLI/ACP slash 行为（`/model --fast` / `/rename --auto` / `/new` / `/reset`）。可直接用，也可作 fork starting point。

---

## 五、常用操作 recipes

下表是常用 route 速查；完整 ~40 route 列表通过 `GET /capabilities` + `GET /workspace/sessions` 等运行时探测。

### 5.1 Session 生命周期

| 操作 | 命令 |
|---|---|
| 建 session | `POST /session` `{workspaceCwd, sessionScope?}` |
| 列出 session | `GET /workspace/sessions` |
| 加载 session（attach） | `POST /session/:id/load` |
| 恢复 paused session | `POST /session/:id/resume` |
| 关闭 session（tombstone） | `DELETE /session/:id` |
| client 心跳 | `POST /session/:id/heartbeat`（或 ACP `_qwen/session/heartbeat`）|

### 5.2 Prompt + 控制

| 操作 | 命令 |
|---|---|
| 发 prompt | `POST /session/:id/prompt` `{prompt: ContentBlock[]}` |
| 取消 prompt | `POST /session/:id/cancel` |
| 切 model | `POST /session/:id/model` `{model}`（或 ACP `_qwen/session/set_model`）|
| 切 mode | `POST /session/:id/mode` `{mode}` |
| 切 approval mode | `POST /session/:id/approval-mode` `{mode: "plan"\|"default"\|"auto-edit"\|"yolo", persist?: true}` |

### 5.3 Permission vote（4 strategy）

`first-responder`（缺省 strategy）—— 任意 client 抢答：

```bash
# 客户端订阅 SSE 时收到：
# event: permission_request
# data: {"requestId":"req_abc", "tool":"Bash", "args":{"cmd":"npm test"}, "policy":{"kind":"first-responder"}, ...}

# 任意 client：
curl -X POST "http://127.0.0.1:4170/session/$SID/permission/req_abc" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  -H "X-Qwen-Client-Id: $CLIENT_ID" \
  -d '{"outcome":"allow_with_scope", "scope":"session"}'

# winner 收到 permission_resolved 事件；loser 收到 permission_already_resolved
```

`consensus` strategy —— 需要 quorum 投票：

```jsonc
// SSE event: permission_request
{
  "requestId":"req_abc",
  "policy": {"kind":"consensus", "minVotes": 3},  // 3 票才 quorum
  ...
}

// 投票时 outcome 是 option 选择，达 quorum 的 option 赢；中间投票推 permission_partial_vote
```

`designated` —— 仅 prompt originator 决：
```jsonc
{"policy": {"kind":"designated", "clientId":"client_originator_xyz"}}
// 非 originator client 应答 → 403 permission_forbidden / designated_mismatch
```

`local-only` —— 仅 loopback voter 决（kernel-stamped）：
```jsonc
{"policy": {"kind":"local-only"}}
// remote (非 127.0.0.1) client 应答 → 403 permission_forbidden / remote_not_allowed
```


### 5.4 Workspace state CRUD（mutation gate 后）

启用 `--require-auth` 后这些都要 bearer + `X-Qwen-Client-Id` header。

| 操作 | route |
|---|---|
| 读 memory | `GET /workspace/memory` |
| 写 memory | `POST /workspace/memory` |
| 列 agents | `GET /workspace/agents` |
| 加/删 agents | `POST /workspace/agents` |
| 启/禁 tool | `POST /workspace/tools/:name/enable` |
| workspace init（scaffold QWEN.md，**不调 model**） | `POST /workspace/init` |
| MCP server 状态 | `GET /workspace/mcp` (含 `entryCount` + `entrySummary`，反映 shared pool 状态)|
| MCP budget snapshot + push | `GET /workspace/mcp/budget` |
| MCP server restart（pool-aware）| `POST /workspace/mcp/:server/restart?entryIndex=<N>` |

### 5.5 文件读写（sandbox-bounded）

```bash
# 读文件（prior-read 跟踪 + symlink_escape rejection）
curl -G "http://127.0.0.1:4170/workspace/file" \
  --data-urlencode "path=src/index.ts" \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  -H "X-Qwen-Client-Id: $CLIENT_ID"

# 写文件（原子 temp+rename + content-hash precondition）
curl -X POST "http://127.0.0.1:4170/workspace/file" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  -H "X-Qwen-Client-Id: $CLIENT_ID" \
  -d '{"path":"src/index.ts", "content":"...", "expectedHash":"sha256-..."}'

# edit（single-match policy: oldText 必须 exactly 1 处匹配，0 或多处都报错）
curl -X POST "http://127.0.0.1:4170/workspace/file/edit" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  -H "X-Qwen-Client-Id: $CLIENT_ID" \
  -d '{"path":"src/index.ts", "oldText":"foo()", "newText":"bar()"}'
```

文件操作受 sandbox root + symlink_escape rejection 约束。**agent 通过 symlink 写文件会被拒**（与 HTTP `POST /file` 一致；如有合法 use case，agent 需要直接寻址 resolved path）。

### 5.6 OAuth device-flow（远端 daemon auth provider）

```bash
# 1) 启动 device flow
RESP=$(curl -s -X POST "http://127.0.0.1:4170/workspace/auth/device-flow" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
  -d '{"provider":"qwen"}')
echo "$RESP" | jq .
# {"userCode":"ABCD-EFGH", "verificationUri":"https://...", "interval":5, "expiresIn":900}

# 2) client UI 显示 userCode + verificationUri 让用户在浏览器登录
#    ⚠️ 浏览器开在 client 端，不是 daemon 端 —— daemon 经常在 headless container 无 GUI
#    daemon 端有 build-time grep test 防 client browser-spawn regression

# 3) 轮询完成
while true; do
  POLL=$(curl -s -X POST "http://127.0.0.1:4170/workspace/auth/device-flow/poll" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $QWEN_SERVER_TOKEN" \
    -d '{"provider":"qwen"}')
  STATUS=$(echo "$POLL" | jq -r .status)
  case "$STATUS" in
    authorized) echo "✓ done"; break ;;
    pending)    sleep 5 ;;
    expired|denied) echo "✗ $STATUS"; break ;;
  esac
done
# token 落地到 daemon host ~/.qwen/auth/qwen.json (0o600)
```

token 在 daemon host **永远不出现在 wire / log / error / stderr / template literal**（BrandedSecret 4-way redaction：`toString` / `util.inspect` / `JSON.stringify` / `valueOf` 全 redact 成 `[REDACTED]`，仅通过显式 `.unwrap()` 拿原值）。token 文件用 `0o600` 权限（umask-respecting + force mode）。

---

## 六、配置文件 & 持久化路径

| 路径 | 权限 | 内容 | 谁写 |
|---|---|---|---|
| `~/.qwen/serve/token` | `0o600` | bearer token（未设 `--token` / `QWEN_SERVER_TOKEN` 时 daemon 启动随机生成 + 写这） | daemon |
| `~/.qwen/auth/<provider>.json` | `0o600` | OAuth 凭证（device-flow 落地）| daemon |
| `~/.qwen/permissions.json` | — | global scope permission decisions | daemon |
| `~/.qwen/workspaces/<wsId>/permissions.json` | — | workspace scope decisions | daemon |
| `~/.qwen/serve/instances/<host>-<port>-<wsHash>/` | — | per-instance state（token / pid / runtime metadata）| daemon |
| `~/.qwen/settings.json` | — | 全局 settings（含 `policy.permissionStrategy` / `telemetry.*` / `policy.consensusQuorum` 等）| user |
| `<workspace>/.qwen/settings.json` | — | workspace 级覆盖 | user |

**SDK 默认 token 查找顺序**：
1. 显式传 `bearerToken` 参数
2. `QWEN_SERVER_TOKEN` env var
3. `~/.qwen/serve/token`（如果存在）

---

## 七、诊断 & 故障排查

### 7.1 健康 / 能力检查

```bash
# 浅层健康（仅 listener，无 auth）
curl -s http://127.0.0.1:4170/health
# {"status":"ok"}

# 深度健康（含 ACP child liveness + EventBus 状态）
curl -s "http://127.0.0.1:4170/health?deep=1" \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN"

# 能力清单
curl -s http://127.0.0.1:4170/capabilities | jq .
# {
#   "v": 1,
#   "mode": "http-bridge",
#   "workspaceCwd": "/path/to/repo",
#   "features": ["session_lifecycle", "session_prompt", "mcp_workspace_pool", "permission_mediation", ...],
#   "protocol_versions": {"acp": "0.14.x", "daemon_envelope": 1},
#   "auth": {"required": true, "type": "bearer"},
#   "policy": {"permission": {"kind": "consensus", "minVotes": 3}}
# }
```

### 7.2 Preflight 诊断

```bash
# daemon 启动 + 配置 readiness 整体检查
curl -s http://127.0.0.1:4170/workspace/preflight \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" | jq .
# {
#   "cells": [
#     {"name":"node_version", "status":"ok"},
#     {"name":"cli_entry", "status":"ok"},
#     {"name":"workspace_dir", "status":"ok"},
#     {"name":"ripgrep", "status":"ok"},
#     {"name":"git", "status":"ok"},
#     {"name":"auth", "status":"ok"},
#     {"name":"mcp_discovery", "status":"ok", "value":"4 servers, 0 refused"},
#     {"name":"skills", ...}, {"name":"providers", ...},
#     {"name":"egress", "status":"ok"}
#   ]
# }
```

### 7.3 Env 诊断

```bash
# daemon host 关键环境信息（masked secrets）
curl -s http://127.0.0.1:4170/workspace/env \
  -H "Authorization: Bearer $QWEN_SERVER_TOKEN" | jq .
# {
#   "cells": [
#     {"name":"runtime", "value":"node v24.12.0"},
#     {"name":"platform", "value":"darwin arm64"},
#     {"name":"sandbox", "status":"ok"},
#     {"name":"proxy_https", ...}, {"name":"proxy_http", ...},
#     {"name":"env_var:OPENAI_API_KEY", "status":"present"},   # presence-only, 不暴露 value
#     ...
#   ]
# }
```

### 7.4 常见错误（closed `errorKind` 7-值 taxonomy）

daemon 错误响应统一带 closed `errorKind`，client `switch` 处理：

| `errorKind` | 何时出现 | 应对 |
|---|---|---|
| `missing_binary` | `qwen` CLI 找不到 / `qwen --acp` child spawn 失败 | 检查 `which qwen`，确认 qwen-code 装好 |
| `blocked_egress` | egress probe 失败（防火墙阻断 provider endpoint）| 看 `/workspace/preflight` 的 `egress` cell，检查防火墙 / proxy |
| `auth_env_error` | 必要 auth env 缺失 / 无效 | 检查 `OPENAI_API_KEY` / OAuth 凭证 |
| `init_timeout` | ACP child init 超时 | 网络慢 / provider endpoint 不可达 |
| `protocol_error` | ACP NDJSON schema 不匹配 / 帧损坏 | bug，看 daemon stderr，提 issue |
| `missing_file` | 文件读路径不存在 / 越 sandbox 边界 | 检查 path，是否在 workspace 内 |
| `parse_error` | request body parse / zod schema 失败 | 检查 request JSON 格式 |

### 7.5 HTTP 状态码常见映射

| HTTP | 何时出现 | 应对 |
|---|---|---|
| `401 Unauthorized` | 缺 bearer / 错误 token / 缺 `X-Qwen-Client-Id` 头 | 检查 token + clientId |
| `400 workspace_mismatch` | `POST /session` 携带 `workspaceCwd` 与 daemon 启动绑定的 workspace 不一致 | client 拿错 daemon URL，或 daemon 启动 workspace 不对 |
| `403 permission_forbidden` | designated / local-only strategy 拒绝（`designated_mismatch` 或 `remote_not_allowed`）| 检查 `X-Qwen-Client-Id` 是否 originator / client IP 是否 loopback |
| `404 session_not_found` | URL 里的 `:sessionId` 在 daemon 内不存在 | session 已被 close / daemon 重启过 |
| `409` | `permission_already_resolved` / `WorkspaceInitConflictError` / `RestoreInProgressError` | concurrent state 冲突，retry |
| `503` | `--max-sessions` 已满 / MCP budget enforce 模式拒 | 等现有 session 关闭或调大 cap |

### 7.6 日志位置

| 日志 | 路径 |
|---|---|
| daemon stderr | 启动 terminal 或 systemd journal |
| daemon audit log | 由 `originatorClientId` 索引（每 mutation 一条；SHA-256-hashed paths）—— 具体路径取决于部署 |
| Permission audit ring | 内存 512-entry bounded ring（**NOT routed onto SSE**）；由专用 `GET /workspace/permission/audit` route 查询（如部署开启）|
| ACP child stderr | daemon 转发到自己 stderr |
| OpenTelemetry logs/spans/metrics | 如配 `OTEL_EXPORTER_OTLP_ENDPOINT`，发到 OTel collector（详 `docs/comparison/telemetry-architecture-deep-dive.md`）|

---

## 八、生产部署

### 8.1 systemd

```ini
# /etc/systemd/system/qwen-serve.service
[Unit]
Description=Qwen Code daemon
After=network.target

[Service]
Type=simple
User=qwen
EnvironmentFile=/etc/qwen/serve.env
# /etc/qwen/serve.env contains: QWEN_SERVER_TOKEN=<hex>
ExecStart=/usr/local/bin/qwen serve \
  --hostname 0.0.0.0 \
  --port 4170 \
  --require-auth \
  --workspace /var/qwen/workspace \
  --max-sessions 50 \
  --mcp-client-budget 8 --mcp-budget-mode enforce

Restart=on-failure
RestartSec=5s
MemoryMax=4G

[Install]
WantedBy=multi-user.target
```

### 8.2 Docker

```dockerfile
FROM node:24-bookworm
RUN npm install -g @qwen-code/qwen-code
RUN useradd -ms /bin/bash qwen
USER qwen
WORKDIR /workspace
EXPOSE 4170
CMD ["qwen", "serve", "--hostname", "0.0.0.0", "--port", "4170", "--require-auth", "--workspace", "/workspace"]
```

```bash
docker run -d \
  -e QWEN_SERVER_TOKEN=$(openssl rand -hex 32) \
  -v /path/to/repo:/workspace \
  -p 4170:4170 \
  qwen-code-daemon
```

### 8.3 Kubernetes（1 pod = 1 daemon = 1 workspace 天然契合）

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: qwen-daemon}
spec:
  serviceName: qwen-daemon
  replicas: 1                          # 1 pod = 1 workspace
  selector: {matchLabels: {app: qwen}}
  template:
    metadata: {labels: {app: qwen}}
    spec:
      containers:
      - name: qwen
        image: qwen-code-daemon
        args:
          - serve
          - --hostname=0.0.0.0
          - --require-auth
          - --workspace=/workspace
          - --max-sessions=20
          - --mcp-client-budget=8
          - --mcp-budget-mode=enforce
        env:
        - name: QWEN_SERVER_TOKEN
          valueFrom: {secretKeyRef: {name: qwen-token, key: token}}
        - name: QWEN_SERVE_MCP_POOL_TRANSPORTS
          value: "stdio,websocket,http,sse"     # 允许 HTTP/SSE MCP 共享 pool
        ports: [{containerPort: 4170}]
        volumeMounts:
        - name: workspace
          mountPath: /workspace
        resources:
          limits: {memory: 4Gi, cpu: 2}     # cgroup = per-tenant quota
        livenessProbe:
          httpGet:
            path: /health
            port: 4170
            httpHeaders: [{name: Authorization, value: "Bearer $TOKEN"}]
          initialDelaySeconds: 10
  volumeClaimTemplates:
  - metadata: {name: workspace}
    spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 50Gi}}}
```

**多 tenant 部署 = 多 daemon process / pod**（OS 进程级 / namespace 级天然隔离）。1 daemon = 1 workspace 不变，不要在 daemon 内做应用层 tenant 抽象 —— `systemd MemoryMax=` / cgroup / docker `--memory` / K8s `resources.limits.memory` 直接 = per-tenant quota。同 daemon N session 共 OS 权限（同 `qwen --acp` child，共 user UID + fs 视图），所以**不能让多 tenant 共一个 daemon**。

### 8.4 Reverse proxy / TLS（生产必备）

`qwen serve` 不自己做 TLS / cert rotation。生产部署在前面套 nginx / Envoy / k8s Ingress：

```nginx
# nginx fragment
server {
  listen 443 ssl http2;
  server_name daemon.example.com;
  ssl_certificate ...;
  ssl_certificate_key ...;

  # /demo SPA / web-shell 路由（如部署 web-shell）
  location /demo { proxy_pass http://127.0.0.1:4170/demo; }

  # daemon REST + SSE
  location ~ ^/(session|workspace|capabilities|health|authenticate|permission|acp) {
    proxy_pass http://127.0.0.1:4170;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Qwen-Client-Id $http_x_qwen_client_id;
    proxy_set_header X-Forwarded-For "";   # ⚠️ 注意 local-only permission strategy 用 kernel-stamped remote IP，不看 X-Forwarded-For
    proxy_buffering off;                   # SSE 不缓冲
    proxy_read_timeout 1d;                 # 长连接
  }
}
```

注意：**`PermissionMediator` `local-only` strategy 不看 `X-Forwarded-For`**（用 kernel-stamped `req.socket.remoteAddress`），所以反向代理后 daemon 看到的"remote address"是 nginx loopback。**`local-only` 在反向代理后失效** —— 这是设计如此，防 forged header bypass。如果需要"only LAN" 类语义，应在反向代理层做 IP allowlist + 用 daemon `first-responder` strategy。

### 8.5 网络 egress 策略（生产 best practice）

daemon host = runtime owner，所有 fs / tool / MCP / skill / shell / LSP / provider auth 在 daemon host 上 evaluate。

- **默认 deny-by-default + explicit allowlist** —— daemon host/pod 只允许 configured provider / MCP / skill 实际所需的 network surface
- **不需要 daemon 开公网** —— allowlist 列入 provider 端点 / MCP HTTP-SSE / skill 调用的外部 API
- **诊断** —— `/workspace/preflight` 的 `egress` cell 给 client 渲染 actionable error

### 8.6 凭据 / Secrets 都在 daemon host

| 类型 | 位置 |
|---|---|
| Provider OAuth tokens | daemon host `~/.qwen/auth/*.json` (0o600) |
| API keys / env vars | daemon process env（从 k8s secret / secret manager 注入）|
| MCP server credentials | MCP config 引用 daemon host env |
| SSH agent / kubeconfig | daemon host 本地（client 端的不自动传过来）|

**client credentials 不会自动可用** —— daemon host 必须自己持有。多 tenant 场景下，1 daemon = 1 tenant 时 credentials per-daemon process 隔离最干净。

---

## 九、与其他模式 / Mode A 的关系

### 9.1 Native `qwen` TUI 长期保留

**`qwen` 命令仍直连本地 runtime 不走 daemon** —— 这是长期保留的本地 TUI 路径（零网络 / 最低复杂度）。`qwen serve` 是给 **web / remote runtime / 多 client 协作** 场景的，不是 TUI 替代。

| 场景 | 推荐 |
|---|---|
| 本机单人开发，不需多 tab 协作 / 不需 web UI | **`qwen`**（native TUI，直连，无 daemon overhead） |
| 本机但要多 tab / web UI / 与 IDE 共享 session | `qwen serve` + web-shell / SDK |
| 远端 cloud devbox / Codespaces / K8s pod | `qwen serve --hostname 0.0.0.0 --require-auth` |
| ACP-native client（Zed / Goose）| `qwen serve` + 走 `/acp` |
| CI 自动化 / headless 脚本 | `qwen serve` + curl，或 `qwen --acp` stdio mode |

Stroustrup 零成本抽象原则——**不要为不需要的东西付费**。


### 9.2 Mode A (`qwen --serve`) 不是主线

`qwen --serve` 模式（CLI + HTTP server 同进程，本地 TUI super-client）作为 parking lot 保留 ([Issue #4156](https://github.com/QwenLM/qwen-code/issues/4156))，不进近期主线。Mode B (`qwen serve` headless) 是唯一推荐生产模式。

---

## 十、外部参考

| 资源 | 用途 |
|---|---|
| [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) | qwen-code GitHub 主仓 |
| [QwenLM/qwen-code#4175](https://github.com/QwenLM/qwen-code/issues/4175) | Mode B production-ready Wave plan（功能演进跟踪） |
| [RFC 6750](https://datatracker.ietf.org/doc/html/rfc6750) | Bearer token HTTP 认证标准 |
| [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) | OAuth 2.0 Device Authorization Grant（device flow 标准） |
| [RFD #721 ACP Streamable HTTP transport](https://github.com/agentclientprotocol/agent-client-protocol/pull/721) | `/acp` 端点遵循的标准草案 |
| [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) | ACP 协议主仓 |

---

## 附录 A：capability tag 速查

通过 `GET /capabilities` 返的 `features` 数组协商能力。客户端 `if (caps.features.includes(...))` 决定是否启用对应 UI：

```
# Stage 1 baseline (9):
session_lifecycle / session_prompt / session_cancel /
session_model_switch / session_mode_switch / permission_vote /
sse_events / last_event_id_replay / capabilities_endpoint

# Wave 1 protocol foundation:
capability_registry_v1 / typed_session_event_v1 / typed_control_event_v1 /
daemon_session_client_v1 / lockstep_invariant_v1

# Wave 2 session lifecycle:
session_scope_override / session_load / session_resume /
client_id_stamped / session_scoped_permission / permission_bounded_record

# Wave 2.5 reliability:
session_heartbeat / slow_client_warning / session_close_delete

# Wave 3 read-only control plane:
workspace_status_readonly / preflight_diagnostics / env_diagnostics /
mcp_restart_guarded / mcp_budget_push

# Wave 4 auth-gated mutation:
mutation_gate / workspace_memory_crud / workspace_agents_crud /
workspace_tools_crud / workspace_init / session_approval_mode /
fs_boundary_enforced / workspace_file_read / workspace_file_write /
auth_device_flow / branded_secret

# Wave 5 architecture extraction:
mcp_workspace_pool / mcp_pool_restart /
permission_mediation                  # advertised with active strategy in capabilities.policy.permission

# ACP HTTP transport (RFD #721):
acp_http_v1                            # /acp 端点可用
```

`/capabilities.policy.permission` 同时暴露 active strategy：
```jsonc
{"kind": "first-responder"}
{"kind": "designated", "clientId": "..."}
{"kind": "consensus", "minVotes": 3}
{"kind": "local-only"}
```

## 附录 B：典型 troubleshooting decision tree

```
症状 → 先查 → 再查
═══════════════════════════════════════════════════════════════
daemon 启动失败          → stderr 看 errorKind   → 0.0.0.0 + 无 token? 改 loopback 或 加 token
401 Unauthorized         → bearer 是否带          → clientId 是否带
                                                  → require-auth 模式下 /health 也要 token
400 workspace_mismatch   → daemon 启动 workspace  → curl 时 workspaceCwd 是否同一绝对路径
403 permission_forbidden → strategy 是否对        → designated 时 clientId 是否 originator
                                                  → local-only 时是否 loopback (注意 reverse proxy 后失效)
404 session_not_found    → daemon 是否重启过       → session 是否被 DELETE
SSE 流断了               → Last-Event-ID 重连     → 收到 state_resync_required 要 loadSession 重建
permission_request 卡住  → strategy 是否需要 N 票  → 60s 默认 deny；cancel 解锁
prompt 不响应             → /workspace/preflight   → ACP child 是否存活（session_died 事件）
                                                  → blocked_egress?
                                                  → auth_env_error?
MCP server 不见            → /workspace/mcp 状态    → budget mode=enforce 时被拒？
                                                  → mcp_discovery preflight cell
                                                  → HTTP/SSE MCP 没共享 pool? 检查 QWEN_SERVE_MCP_POOL_TRANSPORTS
文件写返回 missing_file    → 是否在 workspace 内    → 是否 symlink_escape (agent 不能 symlink 写)
                                                  → 是否 prior-read 守卫触发
ACP-native client 接不上  → /acp 端点是否开?       → 检查 QWEN_SERVE_ACP_HTTP env, 默认 on
                                                  → 检查 Acp-Connection-Id header 是否带
```

---

> 本文档描述 daemon Mode B **终态**（feature-complete production-ready）。当前 qwen-code release 的实际可用能力面可能少于此处描述 —— 通过运行时 `GET /capabilities` 协商 feature tag 是最准确的能力检测方式（参见附录 A）。
