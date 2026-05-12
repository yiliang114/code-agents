# 10 — 远端 CLI 模式与 Client Capability 协议

> [← 上一篇：TUI 兼容性](./09-tui-compatibility.md) · [回到 README](./README.md)

> **远端 client 接入流程**（[§02 §2](./02-architectural-decisions.md#2-状态进程模型) "1 daemon = 1 session"下）：
>
> - **Multi-client per daemon 是核心价值**——CLI / WebUI / IM bot 连同一 daemon URL = 共享同一 session
> - **远端 client 直连 daemon instance**——已知 daemonUrl 时不需要中间路由
> - **Client capability 反向 RPC / NAT 穿透 / TLS / mTLS / Bearer token** 是 External Reference Architecture 范畴的设计（PR#3889 / Stage 2 不实现，仅本章作为外部集成方蓝图描述）
> - **Discovery / 跨 daemon 路由**：多 daemon 部署下 client 通过 [§14 Orchestrator](./14-orchestrator-multi-tenancy.md) `POST /coordinator/sessions/:id/route` 解析 sessionId → daemonUrl，再直连

> CLI 连接远端 daemon 的完整设计：3 类拓扑取舍、Client Capability 反向 RPC 协议（让 daemon 调起本地 editor/clipboard/browser）、TLS/mTLS auth 链、NAT 穿透方案、Local echo 性能优化、离线降级。

> **本章 scope**：以下大部分内容（Client Capability 反向 RPC 协议 / mTLS / Sticky cookie HMAC / NAT 穿透方案 / Local echo / 离线降级）属 **External Reference Architecture** 范畴——Stage 1 PR#3889 仅实现"远端 client 直连 daemon URL + Bearer token + SSE 重连"基础链路；本章其余设计供外部集成方（商业平台 / k8s operator / 云厂商）参考。

## 一、TL;DR

| 维度 | 设计 |
|---|---|
| 推荐拓扑 | **Remote-Remote**（workspace 与 daemon 同机）—— 类比 GitHub Codespaces / Coder |
| Auth 链 | TLS 1.3 + Bearer token + 可选 mTLS + sticky cookie HMAC |
| 反向 RPC | **Client Capability Request 协议**：daemon 通过 SSE event 反向调用 CLI（editor / clipboard / browser / notification / file_picker）|
| NAT 穿透 | Cloudflare Tunnel / Tailscale / SSH reverse tunnel |
| 性能优化 | TUI 端 local echo 抹平 keystroke RTT；LLM streaming 50ms RTT 几乎无感 |
| 重连 | SSE Last-Event-ID（[§03 §三 重连协议](./03-http-api.md#sse-last-event-id-重连协议)）|
| 离线降级 | `--daemon-or-local` flag：daemon 不可达自动 fallback 到本地子进程模式 |

## 二、3 类拓扑详细对比

### 2.1 拓扑 A — Local-Local（同机）

```
Laptop / Workstation
├─ qwen CLI ──────HTTP──────→ qwen daemon (127.0.0.1:<port>)
├─ Workspace /work/repo
└─ Editor / clipboard / browser
```

**适用**：
- 单人开发（最常见）
- Stage 1 / 1.5 / 2 默认部署
- 同 host 多 client（CLI 1 + CLI 2 + IDE 同 session，[§09](./09-tui-compatibility.md)）

**特点**：
- 无网络层 latency
- 所有本地依赖功能直接可用（editor / clipboard / xdg-open）
- 不需要 TLS（loopback 安全）

### 2.2 拓扑 B — Local-Remote（混合，**不推荐**）

```
Laptop                            Cloud / Workstation
├─ qwen CLI ──HTTPS+TLS─────────→ qwen daemon
├─ Workspace /work/repo           └─ ?? (no workspace here)
└─ Editor / clipboard
```

**问题**：
- daemon Edit/Read tool 看不到本地 `/work/repo` 文件
- daemon Bash spawn `npm test` 没有 repo 在远端
- LSP / MCP server 启动在远端，不能解析本地文件路径
- 沙箱在远端 spawn，访问的是远端 fs

**唯一可行的解法**（每种都有重大问题）：

| 方案 | 实现 | 问题 |
|---|---|---|
| sshfs / Mutagen 同步 workspace 到 daemon | mount 本地 dir 到远端 | 高 latency / 文件锁 / 大文件性能差 |
| daemon 主动 git clone | repo 必须在 git remote | dirty/uncommitted 修改丢失 |
| 双向同步（Mutagen continuous）| 持续同步 | 冲突 / 复杂运维 |

**结论**：拓扑 B **不主流支持**，文档明确标记为 unsupported（如真要用，建议走拓扑 C（开发环境整体迁移到远端 daemon 同机））。

### 2.3 拓扑 C — Remote-Remote（**推荐**）

```
Laptop (thin client)              Cloud / Workstation / Container
├─ qwen CLI ──HTTPS+TLS─────────→ qwen daemon
                                  ├─ Workspace /work/repo
                                  ├─ MCP / LSP / sandbox（all 在 daemon 同机）
└─ Editor / clipboard / browser   └─ Background tasks 子进程

Capability 反向 RPC:
                                  daemon emit { type: 'open_editor', content: '...' }
Editor / clipboard / browser ←─── via SSE event ─────
```

**适用**：
- External Phase 3+ SaaS（云端 dev container）
- GitHub Codespaces / Coder 风格 cloud workspace
- 工程师笔记本性能弱 / 跨机器开发
- 团队共享 dev environment（多人接入同一 daemon = 同一 session live collaboration；多 session 由 orchestrator spawn 多 daemon 实例，[§14](./14-orchestrator-multi-tenancy.md)）

**特点**：
- daemon 端有完整 workspace 视图
- 仅 5 类本地依赖功能需 capability 反向 RPC
- LLM 对话延迟基本无感（50ms RTT）
- TUI 端 local echo 抹平键击延迟

### 2.4 决策表

| 维度 | 拓扑 A | 拓扑 B | 拓扑 C |
|---|---|---|---|
| 开发体验 | 最佳 | 差 | 良好 |
| 文件 IO 复杂度 | 0 | 极高 | 0 |
| 沙箱 / 子进程 | 简单 | 极复杂 | 简单 |
| 网络要求 | 无 | 高 | 中 |
| 适用人群 | 单人 | 特殊 | SaaS / 团队 |
| 官方支持 | ✓ Stage 1+ | ✗ | ✓ Stage 1+ 基础 Remote / External Phase 3+ SaaS 部署 |

## 三、Client Capability Request 协议

### 3.1 设计动机

拓扑 C 下，daemon 在云端，无法直接调用本机 `xdg-open`、`vim`、`xclip` 等命令。**反向 RPC** 让 daemon 通过 SSE 事件请求 CLI 端代为执行。

类比 [LSP `window/showDocument`](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#window_showDocument) / [DAP `runInTerminal`](https://microsoft.github.io/debug-adapter-protocol/specification#Reverse_Requests_RunInTerminal) 的 reverse request 模式。

### 3.2 协议层

```
[CLI] ←──── SSE event ──── [daemon]      capability request
[CLI] ──── HTTP POST ────→ [daemon]      capability response
```

**为什么不用 WebSocket 全双工**：
- SSE + HTTP POST 简单，企业代理兼容性好
- WebSocket 在公司代理 / Cloudflare 之类有时需特殊配置
- HTTP/2 multiplexing 自然支持多 capability 并发

### 3.3 Request 格式

daemon 端 emit SSE event：

```
event: capability_request
id: cap-12345
data: {
  "id": "cap-12345",
  "type": "open_editor",
  "params": {
    "filename": "draft.md",
    "initialContent": "...",
    "syntax": "markdown",
    "expectsContent": true
  },
  "timeout_ms": 600000,
  "fallback": "return_inline"
}
```

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 唯一 ID，用于 response 关联 |
| `type` | string | capability 类型（5 种，见 §四）|
| `params` | object | type 特定参数 |
| `timeout_ms` | number | client 必须在此时间内响应；超时 daemon 自动 fallback |
| `fallback` | string | client 不支持时 daemon 的退化策略（`error` / `return_inline` / `skip`）|

### 3.4 Response 格式

CLI 端 POST 回 daemon：

```http
POST /session/<sid>/capability/cap-12345/response HTTP/1.1
Authorization: Bearer ...
Content-Type: application/json

{
  "id": "cap-12345",
  "status": "success",         // success / cancelled / error / unsupported
  "result": {
    "content": "edited content..."
  },
  "error": null                 // 当 status=error 时填
}
```

### 3.5 Client 不支持时的兜底

CLI 启动时声明能力：

```http
POST /session HTTP/1.1
Authorization: Bearer ...
Content-Type: application/json

{
  "meta": { "workspaceId": "ws-abc" },
  "clientCapabilities": {        // ACP camelCase（§03 §二 复用 ACP zod schema）
    "fs": { "readTextFile": true },
    "remote": {
      "openEditor": true,
      "clipboard": true,
      "openBrowser": true,
      "notification": false,      // 终端环境无桌面通知
      "filePicker": false         // CLI 不支持 GUI file picker
    }
  },
  "clientInfo": {
    "name": "qwen-cli",
    "version": "1.0.0",
    "platform": "linux",
    "tty": true
  }
}
```

daemon 在 emit capability_request 前检查 `clientCapabilities.remote`，不支持的 capability 走 `fallback` 策略。

> **注**：本章 capability 协议是 [External Reference Architecture](./06-roadmap.md#external-reference-architecture参考实现非项目路线图) 设计——[§06 Stage 2 worklist](./06-roadmap.md#stage-2daemon-完善拆分-2a-2d3-4-周总计) 不含此项；外部集成方决定 ACP `clientCapabilities` extension 的 schema 命名空间（本节示例用 `clientCapabilities.remote`）。

## 四、5 类 Capability 详细设计

### 4.1 `open_editor`

**目的**：daemon 需要用户编辑长文本（commit message / 大段输入）。

**Request**：
```json
{
  "type": "open_editor",
  "params": {
    "filename": "COMMIT_EDITMSG",
    "initialContent": "feat: ...\n\n# Please enter the commit message...",
    "syntax": "git-commit",
    "expectsContent": true,
    "instructions": "Edit and save to confirm; close empty to abort."
  }
}
```

**CLI 端实现**：
```ts
// packages/cli/src/capability/editor.ts
async function handleOpenEditor(params: OpenEditorParams) {
  const editor = process.env.EDITOR || 'vim'
  const tmpFile = await mkstemp({ suffix: params.filename })
  await fs.writeFile(tmpFile, params.initialContent)
  
  await spawn(editor, [tmpFile], { stdio: 'inherit' })
  
  const finalContent = await fs.readFile(tmpFile, 'utf-8')
  await fs.unlink(tmpFile)
  
  return { status: 'success', result: { content: finalContent } }
}
```

**Fallback `return_inline`**：daemon 改用内置 multi-line input box（TUI 内部 multi-line edit primitive（Ink + `ink-text-input` 包））。

**对比单进程模式**（同 host）：daemon 直接在本机 spawn editor 子进程（PTY）—— 拓扑 A 的方式；远端拓扑 C 必须走反向 RPC 让 CLI 端 spawn。

### 4.2 `clipboard`

**目的**：把内容复制到本地剪贴板 / 从剪贴板读取。

**Request (write)**：
```json
{
  "type": "clipboard",
  "params": {
    "operation": "write",
    "content": "https://github.com/...",
    "mime": "text/plain"
  }
}
```

**Request (read)**：
```json
{
  "type": "clipboard",
  "params": {
    "operation": "read",
    "mime": "text/plain"
  }
}
```

**CLI 端实现**：

```ts
async function handleClipboard(params: ClipboardParams) {
  if (params.operation === 'write') {
    // 优先 OSC 52 终端 escape (跨平台 / SSH 兼容)
    if (supportsOSC52()) {
      process.stdout.write(`\x1b]52;c;${base64(params.content)}\x07`)
    } else {
      // fallback: pbcopy / xclip / xsel / clip
      const cmd = pickClipboardCmd()
      await spawnWithStdin(cmd, params.content)
    }
    return { status: 'success' }
  } else {
    // read: 仅本机命令支持（OSC 52 read 安全风险大，多终端禁用）
    const cmd = pickClipboardCmd('read')
    const content = await spawnReadStdout(cmd)
    return { status: 'success', result: { content } }
  }
}
```

**OSC 52 优势**：
- 跨 SSH / tmux / VSCode Terminal 透明
- 不需要本地 X11 / Wayland 环境
- 不需要本机 `xclip` / `pbcopy` 安装

**OSC 52 限制**：
- 内容大小有限（多数终端 100KB-1MB）
- read 多数终端默认禁用（安全考虑）

### 4.3 `open_browser`

**目的**：OAuth flow / 文档链接 / preview server。

**Request**：
```json
{
  "type": "open_browser",
  "params": {
    "url": "https://login.qwen.com/oauth?...",
    "purpose": "oauth_flow",
    "expectsCallback": false
  }
}
```

**CLI 端实现**：

```ts
async function handleOpenBrowser(params: OpenBrowserParams) {
  // 1. 优先 OSC 8 hyperlink (终端可点)
  if (supportsOSC8()) {
    process.stdout.write(
      `\x1b]8;;${params.url}\x07[Click to open]\x1b]8;;\x07\n`
    )
  }
  
  // 2. 调系统命令
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start'
            : 'xdg-open'
  
  try {
    await spawn(cmd, [params.url], { stdio: 'ignore', detached: true })
    return { status: 'success' }
  } catch {
    // 3. fallback: 显示 URL 让用户复制
    process.stdout.write(`Open in browser: ${params.url}\n`)
    return { status: 'success', result: { fallback: 'displayed_url' } }
  }
}
```

**OAuth callback 接管**（特殊场景）：

```
1. CLI 启动 ephemeral local HTTP server (e.g. localhost:23456/callback)
2. daemon 生成 OAuth URL，redirect_uri = http://localhost:23456/callback
3. CLI capability response 时附带 callback_port: 23456
4. daemon 把 redirect_uri 改为 client-provided
5. 浏览器 → callback → CLI HTTP server → POST 回 daemon
```

### 4.4 `notification`

**目的**：长任务完成通知用户。

**Request**：
```json
{
  "type": "notification",
  "params": {
    "title": "Background agent finished",
    "body": "PR draft ready for review",
    "urgency": "normal",         // low / normal / critical
    "icon": null
  }
}
```

**CLI 端实现**：

```ts
async function handleNotification(params: NotificationParams) {
  // 1. 终端 bell（最低公分母）
  if (params.urgency !== 'low') {
    process.stdout.write('\x07')  // BEL
  }
  
  // 2. OSC 9 / iTerm2 通知
  if (supportsOSC9()) {
    process.stdout.write(`\x1b]9;${params.title}: ${params.body}\x07`)
  }
  
  // 3. 桌面通知（仅本机环境）
  if (process.env.DISPLAY || process.platform === 'darwin') {
    const cmd = process.platform === 'darwin' ? 'osascript' : 'notify-send'
    // ...
  }
  
  return { status: 'success' }
}
```

### 4.5 `file_picker`

**目的**：用户选择本地文件（attach to prompt）。

**注意**：远端拓扑 C 下，"本地"指 CLI 端。这是 **唯一一个允许从 CLI 端读取文件并发送到 daemon 的 capability**。

**Request**：
```json
{
  "type": "file_picker",
  "params": {
    "multiple": false,
    "accept": ["image/*", ".pdf"],
    "purpose": "attach_to_prompt",
    "maxSize": 10485760
  }
}
```

**CLI 端实现**：

```ts
async function handleFilePicker(params: FilePickerParams) {
  // CLI 通常用 fzf / 内置 input
  const filename = await prompt('Enter file path: ')
  const fullPath = path.resolve(filename)
  
  const stats = await fs.stat(fullPath)
  if (stats.size > params.maxSize) {
    return { status: 'error', error: 'file_too_large' }
  }
  
  // 大文件分块上传到 daemon attachment endpoint
  const attachmentId = await uploadAttachment(daemonUrl, token, fullPath)
  
  return {
    status: 'success',
    result: {
      attachments: [
        { id: attachmentId, filename: path.basename(fullPath), size: stats.size }
      ]
    }
  }
}
```

### 4.6 Capability 协议总结表

| Capability | 用途 | OSC 终端兼容 fallback | 必需性 |
|---|---|---|---|
| `open_editor` | 编辑长文本 | 内置 ink-text-input multi-line | High（commit msg / 长 prompt）|
| `clipboard` | 读写剪贴板 | OSC 52 | Medium |
| `open_browser` | OAuth / 文档 | OSC 8 hyperlink + 显示 URL | High（OAuth 必需）|
| `notification` | 异步通知 | terminal bell + OSC 9 | Low |
| `file_picker` | 选本地文件 | 文件路径输入 | Medium |

## 五、TLS / Auth 完整链

### 5.1 5 层握手

```
[CLI 启动]
   ↓
1. DNS 解析 daemon.qwen.example.com
   ↓
2. TCP connect :443
   ↓
3. TLS 1.3 handshake
   ├─ Server cert 验证
   ├─ SNI: daemon.qwen.example.com
   └─ ALPN: h2 / http/1.1
   ↓
4. (可选) mTLS 客户端证书 challenge
   ↓
5. HTTP/2 stream
   ├─ Authorization: Bearer <token>
   └─ Initial: GET /session/sess-abc/events
   ↓
6. daemon 验证：
   ├─ Token SHA-256 hash + timingSafeEqual 比对（[§05 §二 Bearer Token](./05-permission-auth.md#二layer-1传输层-bearer-token)）
   ├─ Tenant lookup
   ├─ Workspace allowlist check
   └─ Session 存在性 + 所属 tenant 匹配
   ↓
7. SSE 长连接建立 → 业务流量
```

### 5.2 Bearer Token 设计

参考 [§05 §二 Bearer Token](./05-permission-auth.md#二layer-1传输层-bearer-token)：

```
Token format: qwen_<env>_<tenant_id>_<random_64bytes_base32>

例:
  qwen_prod_t-alice_b7m2k9....    # 生产 tenant alice
  qwen_dev_t-bob_h3p8j2....       # 开发 tenant bob

Storage: SHA-256(token_secret)
         daemon 仅存 hash，比对走 crypto.timingSafeEqual（防 side-channel）
         明文 token 仅返回一次（PR#3889 commit `ad0e6ec06` 已实现）
```

### 5.3 mTLS（可选，企业级）

```yaml
# /etc/qwen/daemon.json
{
  "tls": {
    "cert": "/etc/qwen/tls/server.crt",
    "key": "/etc/qwen/tls/server.key",
    "clientAuth": {
      "required": true,                    // 强制 mTLS
      "ca": "/etc/qwen/tls/client-ca.crt",  // 客户端证书 CA
      "verifyDepth": 2
    }
  }
}
```

**优势**：
- 第二因子（token + cert）
- token 泄漏 + 无客户端证书 → 仍无法连接
- 企业 PKI 集成

**不足**：
- 客户端证书发放 / 撤销复杂
- 笔记本丢失 → 撤销窗口期 cert revocation

### 5.4 Sticky Cookie HMAC

跨多 pod 部署（External SaaS HA）需要 sticky session cookie 防止 cookie 篡改路由到任意 pod：

```
qwen-aff cookie = base64( HMAC-SHA256(sessionId, server-secret) )
HttpOnly + Secure + SameSite=Strict
```

防 cookie 篡改路由到任意 pod。

### 5.5 完整的认证三因子

| 因子 | 强度 | Stage |
|---|---|---|
| Bearer token | 默认 | Stage 1+ |
| + TLS server cert | 默认 | Stage 1+ |
| + mTLS client cert | 加固 | External Phase 1+ 企业（多租户 auth）|
| + IP allowlist | 加固 | External Phase 1+ 企业（多租户 auth）|
| + Time-based OTP（capability_request 二次确认）| 高敏感 | 可选 |

## 六、NAT 穿透方案

daemon 在内网 / 家里 / 防火墙后，CLI 在公网，3 种主流方案：

### 6.1 Cloudflare Tunnel（推荐）

```bash
# daemon 端
$ cloudflared tunnel login
$ cloudflared tunnel create qwen
$ cloudflared tunnel route dns qwen daemon.mydomain.com
$ cloudflared tunnel run --url http://localhost:8080 qwen

# CLI 端（任何地方）
$ qwen --daemon https://daemon.mydomain.com --token $QWEN_TOKEN
```

**优点**：零配置 NAT 穿透 / 自动 TLS / DDoS 防护
**缺点**：依赖 Cloudflare / 流量过它家

### 6.2 Tailscale（推荐内网）

```bash
# daemon 端 + CLI 端都装 Tailscale
$ tailscale up

# daemon 端获取 tailscale IP / hostname
$ tailscale ip -4   # 100.64.0.5

# CLI 端
$ qwen --daemon http://workstation:8080 --token $QWEN_TOKEN
       # workstation 是 Tailscale magic DNS hostname
```

**优点**：mesh VPN 端到端加密 / 零信任 / 跨 OS
**缺点**：需双端都装客户端

### 6.3 SSH Reverse Tunnel

```bash
# daemon 在内网 NAT 后，主动反向连到公网 jumphost
$ ssh -R 8080:localhost:8080 jumphost.example.com -N

# CLI 端
$ qwen --daemon http://jumphost.example.com:8080 --token $QWEN_TOKEN
```

**优点**：纯 SSH 协议，无第三方依赖
**缺点**：手动管理隧道存活 / 无 HTTPS 默认

### 6.4 直接公网部署（云端 daemon）

```yaml
# k8s Service + Ingress + Let's Encrypt
apiVersion: networking.k8s.io/v1
kind: Ingress
spec:
  tls:
  - hosts: [daemon.qwen.example.com]
    secretName: qwen-tls
  rules:
  - host: daemon.qwen.example.com
    http: ...
```

**External Phase 3+ SaaS 默认**。

### 6.5 方案选择决策

| 场景 | 推荐 |
|---|---|
| 个人 / 单人开发 / 家庭 NAS daemon | Tailscale |
| 团队 / 公司内网 daemon | Cloudflare Tunnel / Tailscale |
| External Phase 3+ SaaS（公网 daemon）| Ingress + Let's Encrypt |
| 临时测试 / 演示 | Cloudflare quick tunnel |
| 安全要求高 | mTLS + Tailscale + IP allowlist |

## 七、性能优化：Local Echo

### 7.1 问题

50ms RTT 下，每个键击 round-trip：

```
T=0    用户按 'h'
T=0    CLI sendKey('h')
T=50   daemon ack → 显示 'h'
```

50ms 视觉滞后用户能感知。100ms+ 网络环境下不可用。

### 7.2 Local Echo 设计

```
T=0    用户按 'h'
T=0    CLI 立即在屏幕渲染 'h'（local echo）
T=0    CLI sendKey('h') 发到 daemon（异步）
T=50   daemon ack（不影响 UI 已渲染）
```

**实现**：

```ts
// packages/cli/src/ui/InputBox.tsx
function InputBox() {
  const [localValue, setLocalValue] = useState('')
  const { sendKey } = useDaemonClient()
  
  const handleKey = (key: string) => {
    setLocalValue(v => v + key)        // 立即本地渲染
    sendKey(key)                         // 异步发 daemon
  }
  
  return <Input value={localValue} onKey={handleKey} />
}
```

### 7.3 哪些场景必须 local echo

| 场景 | local echo? | 原因 |
|---|---|---|
| Prompt 输入框 keystroke | ✓ | 高频，必须 |
| Submit prompt | ✗ | 低频 + 需 daemon 确认 |
| Tool call 决策（y/n）| ✓ | 用户希望立即看到 |
| LLM streaming 输出 | ✗ | 是 daemon 主动 push |
| 文件补全 `@file` | ✗ | 需要 daemon 端 readdir |
| 历史 Ctrl-R 检索 | ✗ | 需要 daemon transcript 检索 |

### 7.4 与 daemon 状态对账

local echo 仅是显示层乐观更新；实际状态以 daemon 为准。如果 daemon 拒绝（如内容超长）：

```
T=0   CLI 显示 "Hello world... [LONG TEXT 50KB]"
T=50  daemon 返回 { error: 'attachment_required', threshold: 10240 }
T=51  CLI UI 提示 "Auto-promoting to attachment..."
T=52  CLI POST attachment endpoint
T=53  CLI 替换 prompt 中的 inline content 为 attachment ref
```

最差情况：50ms 后 UI 短暂闪烁更新，用户可接受。

## 八、离线模式与降级

### 8.1 `--daemon-or-local`

```bash
$ qwen --daemon https://daemon.qwen.example.com \
       --daemon-or-local \
       chat
```

启动时尝试 daemon → 失败立即 fallback 到本地子进程模式（拓扑 A）。

### 8.2 daemon 不可达检测

```ts
async function tryDaemon(url: string, token: string) {
  try {
    const resp = await fetch(`${url}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000)
    })
    if (!resp.ok) throw new Error(`status ${resp.status}`)
    return true
  } catch (e) {
    return false
  }
}

if (await tryDaemon(daemonUrl, token)) {
  await runDaemonClient(daemonUrl, token)
} else {
  if (flags.daemonOrLocal) {
    console.warn('Daemon unreachable, falling back to local mode')
    await runLocalSubprocess()
  } else {
    process.exit(1)
  }
}
```

### 8.3 本地缓存

CLI 可缓存少量数据本地：

```
~/.qwen/cache/
├─ session_history/<sid>.jsonl     # 最近 7 个 session 的 transcript snapshot
├─ tools_manifest.json              # daemon `/workspace/:id/mcp` + tools 缓存
└─ skills_index.json                # `/workspace/:id/skills` 缓存
```

允许离线浏览历史 session（read-only）。

### 8.4 降级模式 UX

```
┌──────────────────────────────────────────┐
│ ⚠ Offline mode                            │
│ Daemon unreachable. Showing cached data.  │
│ [r] Retry daemon  [l] Switch to local    │
└──────────────────────────────────────────┘
```

## 九、SSE 重连体验（远端模式特殊性）

笔记本远端模式下 **断网频繁**：换 wifi / 进电梯 / hotspot 切换 / VPN 重连。

### 9.1 重连参数

```jsonc
{
  "reconnect": {
    "maxRetries": -1,                       // 无限
    "backoffMs": [1000, 2000, 5000, 10000, 30000],
    "jitter": 0.2,
    "resetAfterSuccessMs": 60000            // 1 分钟稳定后重置 backoff
  }
}
```

### 9.2 UX 状态指示

```
正常:    ● Connected · sess-abc · alice@daemon.qwen.example.com
重连中:  ◐ Reconnecting (attempt 3, in 5s) · sess-abc
失败:    ○ Disconnected · last seen 2min ago · [r] Retry now
恢复:    ● Reconnected · resuming session... [✓ caught up]
```

### 9.3 与 transcript-first 重建协调

CLI 重连时传 `Last-Event-ID`：daemon 用 PR#3739 transcript-first fork resume 重建 session 状态 → 从 `Last-Event-ID + 1` 拉 missed events → 客户端 UI 无缝续接。多 pod failover（External Phase 3 HA）下 sticky cookie 把 client 路由到含其 sessionId 的 pod；主线 1 daemon = 1 session 不涉及多 pod。

## 十、与 §09 TUI 兼容性的关系

[§09](./09-tui-compatibility.md) 讨论了 TUI 在单进程 vs daemon 下的兼容性，**Local-Local 拓扑（§09 主题）**已覆盖；**本章补充 Remote-Remote 拓扑**。

| 维度 | §09 Local | §10 Remote |
|---|---|---|
| Ink 组件 | 共用 | 共用 |
| HttpAcpAdapter | 同 host fast path | 跨 host RPC + TLS |
| 5 类本地依赖 | daemon spawn 直达 | **必须走 capability 反向 RPC** |
| Latency | < 1ms | 30-100ms RTT |
| Local echo | 不需要 | **必需** |
| 离线降级 | 通常不需要（同机不会断）| **必需** |

§09 + §10 合起来构成完整的 TUI 部署矩阵。

## 十一、与 VSCode Remote-SSH 的对比借鉴

| 维度 | VSCode Remote-SSH | qwen daemon Remote |
|---|---|---|
| 协议 | 自定义 stdio over SSH | HTTP/SSE over TLS |
| 安装位置 | thin client 本地 + server 自动安装到远端 | CLI 本地（任何 OS）+ daemon 远端运维管理 |
| 文件访问 | server 端 fs API | daemon 端 fs API |
| Terminal 调起 | server 端 spawn pty | daemon 端 spawn pty + SSE 流 |
| 编辑器 | server 端是 VSCode 自身（不需调起编辑器）| daemon emit `open_editor` capability → CLI spawn $EDITOR |
| Clipboard | VSCode 内置 sync | OSC 52 / capability |
| Browser 调起 | VSCode `vscode.env.openExternal` 自动转 | daemon emit `open_browser` capability |
| 多端共享 | 单 client 独占 | **多 client 共 session（[决策 §1](./02-architectural-decisions.md)）**|
| 离线模式 | 不可用 | `--daemon-or-local` fallback |
| Tunnel | SSH | HTTPS + TLS |
| Auth | SSH key | Bearer + 可选 mTLS |

**关键借鉴点**：
- VSCode Remote-SSH 把"自动安装 server"做得好——qwen 可以做 `qwen daemon ssh-deploy <host>` 一键远端安装
- VSCode Remote-Tunnel（更新版）走 HTTPS + tunnel —— 与 qwen 设计一致

**关键差异**：
- qwen 是"多 thin client + 共 session"模型（live collaboration）；VSCode Remote-SSH 是"单 client + server"
- qwen capability 反向 RPC 抽象出 5 类，VSCode 直接是 IDE protocol（更厚）

## 十一·五、与 PR#3929-3931 `qwen remote-control` stack 的对比

> 平行推进的 [PR#3929](https://github.com/QwenLM/qwen-code/pull/3929) / [#3930](https://github.com/QwenLM/qwen-code/pull/3930) / [#3931](https://github.com/QwenLM/qwen-code/pull/3931) 3-PR stack（作者 chiga0，独立开发，不引用 issue #3803）走另一条 remote-control 路线——**stream-json + dual-output + mobile UI**。本节澄清两条 stack 的差异 + 哪些能力可以 backport 到 daemon。

### 11.5.1 整体对比

| 维度 | daemon-design + PR#3889 | PR#3929-3931 stack |
|---|---|---|
| **作者 / scope** | wenshao · 通用 daemon building block | chiga0 · mobile/browser remote-control 专项 |
| **入口命令** | `qwen serve` (Mode B) / `qwen --serve` (Mode A) | `qwen remote-control` (worker) / `qwen --remote-control` (attach 当前 TUI) / `/remote-control` slash |
| **传输协议** | HTTP + SSE / WebSocket（Express 5 + ACP NDJSON）| HTTP + WebSocket + stream-json 控制平面 + dual-output JSONL bridge |
| **协议复用** | 100% 复用 ACP zod schema（§03 §二）| 复用 dual-output 现有 primitive + stream-json 包装 control plane |
| **session 模型** | 1 Daemon Instance = 1 Session（§02 §2）| Worker server spawn worker session（PR#3930）或 attach 当前 TUI（PR#3931）|
| **多 client 共 session** | ✅ live collaboration 默认 + first-responder permission | ⚠️ mobile/browser 可 attach 同 session 但首要场景是单 mobile + 当前 TUI 双视图 |
| **Mobile / browser UI** | ❌ §10 标 External Reference 范畴 | ✅ **自带最小化 mobile/browser UI**（PR#3930 +2564 行含 static 资产）|
| **Pairing token + LAN URL** | ❌ 仅 bearer token | ✅ **一次性 pairing token + 客户端 token + LAN URL 报告** |
| **Capability 反向 RPC（5 类）** | ✅ editor / clipboard / browser / notification / file_picker | ❌ 无反向 RPC——permission approve/deny 通过 stream-json 直接路由 |
| **状态** | PR#3889 ✅ Stage 1 GA-ready（merged path 内）| 3-PR stack OPEN（2026-05-07 起）+1302 / +2564 / +2067 行 |
| **与 issue #3803 关系** | 明确引用 #3803 设计 | **不引用** #3803，独立技术栈 |

### 11.5.2 PR#3929-3931 独有的 3 项能力

#### 1. Mobile / browser UI（PR#3930 内置 static 资产）

PR#3930 自带最小化 mobile / browser UI（HTML + JS + CSS），用户连 `http://<lan>:port` 即可在手机浏览器看到当前 session。这是 daemon-design 没有的——daemon-design 把 Web UI 视为 External Reference（外部集成方实现）。

**daemon backport 思路**：
- daemon Stage 2 后可在 `qwen serve` 内嵌一个**可选 static 资产目录**（默认 disabled，`--serve-ui` flag 启用）
- UI 通过 daemon 标准 HTTP API + SSE 接入，**无需 stream-json 协议**
- 体积估算：~500-800 行 HTML/JS + ~1-2KB CSS（minimal）

#### 2. Pairing Token + LAN URL 报告

PR#3930 协议层亮点：
- **一次性 pairing token**：daemon 启动时打印 6-8 位短 token，mobile/browser 一次性输入后换取**长期 client token**（raw token 不存盘）
- **LAN URL 报告**：检测本机非 loopback 网卡，打印类似 `http://192.168.1.42:5096/?pair=ABC123` 的链接 + QR code，mobile 扫码即接入
- **非 loopback 默认拒绝绑定**（`--allow-lan` 显式启用）+ 速率限制 + Origin 校验 + CSP

**daemon backport 思路**：
- Stage 2 daemon 多 token 设计（[§05 §2.4](./05-permission-auth.md#24-多-client-multi-tenant)）可吸收 pairing token 机制
- LAN URL + QR code 输出可作为 `qwen serve --print-lan-url` flag
- mobile/browser 端无需复杂 OAuth flow，pairing 5 秒完成

#### 3. dual-output / remote-input bridge attach 模式

PR#3931 创新点：让现有 TUI（已经在运行的 `qwen` 交互式 CLI）**不重启**就 attach 到 remote-control server——复用现有 `--json-file <events.jsonl>` / `--input-file <input.jsonl>` dual-output 原语，通过 `TuiRemoteBridge` / `RemoteInputWatcher` 把文件流桥接到 WebSocket。

**与 daemon Mode A 的区别**：
- daemon Mode A（[§02 §7](./02-architectural-decisions.md#7-daemon-部署模式clihttpserver-vs-headlesshttpserver)）：TUI 是 client #0，**通过 in-process EventBus** 共享 session（daemon HTTP server 在同进程内常驻）
- PR#3931：TUI **保留独立进程**，通过文件层 bridge 与独立运行的 remote-control server 同步——更轻的耦合

**daemon Mode A 已经覆盖 PR#3931 的场景**：本地 TUI + 远端 mobile 同看 session = `qwen --serve` 即可，无需文件 bridge 中间层。

### 11.5.3 协议层为何不冲突

| 层 | daemon-design | PR#3929-3931 |
|---|---|---|
| **HTTP 路由** | `/session/:id/*` / `/workspace/:id/*` 标准 RESTful | `/remote-control/*` + WebSocket upgrade |
| **wire schema** | ACP zod schema 1:1（`PromptRequest` / `SessionNotification`）| stream-json 自定义控制平面（`session_create` / `prompt_submit` / `interrupt`）|
| **event 编码** | SSE `data: <ACP JSON>\n\n` + `id: <transcript line#>` | dual-output JSONL（`session_start` / `stream_event` / `control_request` / `control_response`）|
| **接入方式** | `daemonUrl + Bearer token` 直接 HTTP fetch | pairing token 换 client token + WebSocket 长连 |

两层路由命名空间 (`/session/*` vs `/remote-control/*`) 不冲突——同一进程可同时承载两套（但当前 PR#3929-3931 用 standalone server，没有合并到 `qwen serve`）。

### 11.5.4 未来融合机会

| 能力 | 当前位置 | 融合方向 |
|---|---|---|
| Mobile UI static 资产 | PR#3930 自带 | Stage 2 后可移植到 daemon Mode B（`--serve-ui` opt-in flag）|
| Pairing token + LAN URL + QR code | PR#3930 | Stage 2 多 token 设计可吸收（[§05 §2.4](./05-permission-auth.md#24-多-client-multi-tenant)）|
| 一次性 pair → 长期 client token | PR#3930 | OAuth-lite 模式，daemon Stage 2 多 token 加 token-issue endpoint 即可 |
| `qwen --remote-control` attach 现有 TUI | PR#3931 | daemon Mode A 已覆盖（in-process EventBus）；PR#3931 文件 bridge 模式可作为"轻量替代"保留 |
| stream-json 控制平面 | PR#3929-3931 协议核心 | **不建议融合**——与 ACP zod schema 设计哲学冲突；两条 stack 应保留独立 wire 协议 |
| Capability 反向 RPC（5 类）| daemon-design §三/§四 | PR#3929-3931 未来需要 mobile editor 等本机能力时可借鉴 |

### 11.5.5 一句话定位

**PR#3929-3931 = 应用层（Mobile remote-control specialization）**：自带 UI + pairing UX + dual-output bridge。
**daemon-design (PR#3889) = 协议层（Generic daemon building block）**：HTTP + SSE + ACP NDJSON，让 mobile UI / pairing token 等应用层能力**可以基于此独立实现**。

两条 stack 互补不冲突——平行 merge 不影响彼此。Mobile UI / pairing token / LAN URL 这 3 块应用层能力是 daemon Stage 2 后可以**选择性吸收**的目标（无需改 wire 协议）。

## 十二、端到端 Setup 流程示例

> **注**：以下 CLI 命令（`qwen daemon init` / `qwen tenant create` / `qwen profile add` / `qwen login`）是 External Reference Architecture 范畴的 speculative 设计示例，**不在 qwen-code 主线 Stage 1/1.5/2 范围**——展示 External 集成方可能如何包装 daemon building block。

### 12.1 个人开发者 + 家里 NAS daemon（Tailscale）

```bash
# === 在 NAS 上 ===
# 1. 装 daemon
$ npm i -g @qwen/daemon
$ qwen daemon init --port 8080 --tls=disabled  # Tailscale 加密足够
$ qwen tenant create personal --owner $USER

# 2. 装 Tailscale
$ curl -fsSL https://tailscale.com/install.sh | sh
$ tailscale up

# 3. 启 daemon
$ qwen daemon start

# === 在 Laptop ===
# 1. 装 Tailscale + qwen CLI
$ tailscale up
$ npm i -g @qwen/cli

# 2. 拿 token (一次性)
$ ssh nas 'qwen token create personal --scope "*"'
qwen_dev_t-personal_xxxx....

# 3. 配 profile
$ qwen profile add nas \
    --url http://nas:8080 \
    --token qwen_dev_t-personal_xxxx....

# 4. 用
$ qwen --profile nas chat
```

### 12.2 团队共享 daemon（Cloudflare Tunnel）

```bash
# === Ops 在公司 daemon 服务器 ===
$ cloudflared tunnel login
$ cloudflared tunnel create qwen-team
$ cloudflared tunnel route dns qwen-team daemon.team.example.com
$ cloudflared tunnel run --url http://localhost:8080 qwen-team &

$ qwen tenant create team-alpha --members alice,bob,charlie

# === 团队成员 ===
$ qwen profile add team \
    --url https://daemon.team.example.com \
    --token $TEAM_TOKEN

$ qwen --profile team chat
```

### 12.3 External Phase 3+ SaaS（公网 daemon）

```bash
# === 用户首次登录 ===
$ qwen login
Browser opened for OAuth login...
✓ Logged in as alice@example.com
✓ Default profile created: prod (https://daemon.qwen.cloud)

# === 用 ===
$ qwen chat                 # 用默认 profile prod
```

## 十三、多端共 session 远端 UX

[决策 §1 'single' scope + §6 fan-out](./02-architectural-decisions.md) 在远端模式下尤其有价值：

```
工程师 Alice 在公司 daemon 上有 session sess-A:
  ├─ 早上：办公室笔记本 CLI 接入 sess-A
  ├─ 中午：会议室 IDE Web UI 接入 sess-A，看到上午 transcript
  ├─ 路上：手机微信 Bot 接入 sess-A，问 "进度如何？"
  └─ 晚上：家里 desktop CLI 接入 sess-A，继续

任何时刻 sess-A 内：
  - prompt 串行（同一时间只一个用户在输入）
  - events 全部 fan-out 到所有 subscribers
  - permission 第一个回应的 client 决定
```

远端模式天然消除"必须用某台机器"的束缚。

## 十四、安全考量

### 14.1 防止 capability 反向 RPC 滥用

daemon emit `open_browser` 可能是钓鱼攻击向量（如果 daemon 被入侵）：

| 攻击 | 防御 |
|---|---|
| 恶意 daemon emit `open_browser → http://phishing.com` | CLI 显示 URL 给用户确认（critical urgency 必须 prompt）|
| 恶意 daemon emit `clipboard → write` 覆盖密码 | clipboard write 不静默；显示 "daemon 写入了剪贴板" |
| 恶意 daemon emit `file_picker` 诱导上传敏感文件 | 用户主动操作；CLI 显示哪些文件被读 |
| daemon emit `open_editor` 写恶意 vim modeline | tmpfile 用 `/tmp/qwen-edit-<random>`，不在 git 工作树 |

CLI 端的 capability handler 应该**明确显示意图给用户**。

### 14.2 防止跨 tenant 嗅探

CLI 端必须验证收到的 SSE event `sessionId` 与自己订阅的 sessionId 匹配（ACP camelCase）。daemon 端 routing bug 不应导致跨 session 数据泄漏。

### 14.3 Token 安全

- 不写入 git tracked 文件
- `~/.qwen/profiles/*.json` 权限 600
- macOS Keychain / Windows Credential Manager / Linux libsecret 集成（可选）
- 短期 OAuth refresh token 优于长期 bearer token

## 十五、与决策的协同

| 决策 | Remote 模式影响 |
|---|---|
| §1 sessionScope='single' | Remote 模式下尤其有价值，跨设备共 session |
| §3 MCP per-daemon | MCP 在 daemon 端 spawn，看到的是 daemon 端 fs（拓扑 C 正确） |
| §4 FileReadCache per-daemon | 1d=1s 模型下等同 per-session；跨设备多 client 共享同一 daemon cache 仍正确 |
| §5 Permission 第 4 mode 'daemon-http' | Remote 是 daemon-http 的常见使用场景 |
| §6 多 client fan-out + first responder | Remote 多端协作的核心 |
| §05 auth + permission | Remote 加固：bearer + mTLS + IP allowlist + sticky cookie HMAC |
| External SaaS HA | Remote SSE 重连协议（Last-Event-ID）必需 |

## 十六、各阶段 Remote 支持矩阵

| Stage / Phase | Remote-Remote | Capability RPC | NAT 穿透 | 备注 |
|---|---|---|---|---|
| Stage 1 (Mode B headless, PR#3889) | ✓（默认 loopback；--host 0.0.0.0 + --token 启用 remote）| ✗ | ✗ | bearer + Host allowlist + 0.0.0.0 拒启动默认 |
| Stage 1.5 (Mode A) | ✓ 同上 | ✗ | ✗ | TUI + HttpServer 同进程 |
| Stage 2 (daemon 完善) | ✓ | ⚠️ 部分（外部 RPC 协议不在 §06 Stage 2 worklist；External 范畴）| ✓ | + WebSocket bidi + mDNS + 多 token |
| External Phase 1 (orchestrator + 多租户)| ✓ | ✓ | ✓ | + tenant 隔离 |
| External Phase 2 (sandbox) | ✓ | ✓ | ✓ | + sandbox 在 daemon 端 |
| External Phase 3 (HA) | ✓✓ 主部署模式 | ✓ | mTLS + Cloudflare | multi-pod sticky + SSE 跨 pod 重连 |
| External Phase 4 (multi-region) | ✓✓ 跨地域部署 | ✓ | mTLS + 多 region anycast | cross-geo scheduling |

## 十七、一句话总结

**Qwen daemon CLI 远端连接 = HTTP/SSE+TLS+Bearer token 设计天然支持，推荐拓扑 C（workspace 与 daemon 同机），通过 Client Capability 反向 RPC 协议（5 类：editor/clipboard/browser/notification/file_picker）让 daemon 可"调起"本地 editor 等本机依赖。NAT 穿透 Cloudflare Tunnel / Tailscale / SSH reverse tunnel 三选一。Local echo 抹平 keystroke RTT，LLM streaming 50ms 几乎无感。SSE Last-Event-ID 自动重连让笔记本网络抖动无感（PR#3889 已实现，详见 §03 §三）。`--daemon-or-local` flag 支持离线降级到本地子进程模式。External Phase 3+ SaaS 部署默认就是 Remote-Remote。与 VSCode Remote-SSH 设计哲学一致但更进一步：多 client 共 session 的 live collaboration 是 Remote 模式下的杀手级特性。**

---

[← 返回 README](./README.md) · [下一篇：多端协调策略 →](./11-client-coordination.md)
