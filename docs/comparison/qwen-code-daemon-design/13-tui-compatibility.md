# 13 — TUI 单进程 vs Daemon 兼容性

> [← 上一篇：水平越权防御](./12-horizontal-privilege-defense.md) · [回到 README](./README.md)

> Qwen Code 的 TUI（基于 Ink + React）在单进程和 Daemon 两种模式下的兼容性分析。**结论：显示层 / 状态层 100% 兼容（同一组组件 + Context shape），数据源层用 HttpAcpAdapter 替换，5 类本地依赖功能需要 case-by-case fallback**。

> **🆕 §03 §7 双部署模式（2026-05-09）**：Daemon 化下 TUI 实际有 **3 种数据源形态**：
>
> | TUI 形态 | 数据源 | 决策依据 |
> |---|---|---|
> | **传统单进程**（`qwen`）| in-process direct call（`Session.handleXxx()`）| 现状 |
> | **Mode A in-process bus subscriber**（`qwen --serve`）| in-process EventBus（与 HTTP 远端 client 走同一套 fan-out） | §03 §7 |
> | **Mode B 远端 TUI**（`qwen client --remote-url`，[§16](./16-remote-cli-mode.md)）| HTTP/SSE via HttpAcpAdapter | §16 |
>
> Mode A 的 TUI **不是 HTTP client**——它是 in-process subscriber，省了 HTTP 序列化成本但拿到字节级一致的事件流。本章下面的 HttpAcpAdapter 部分主要适用于 Mode B（远端 TUI）。Mode A 用 `InProcAdapter` 做同等抽象但内部直接订阅 EventBus。详见 [§03 §7](./03-architectural-decisions.md#7-daemon-部署模式clihttpserver-vs-headlesshttpserver)。

## 一、TL;DR — 4 层兼容性矩阵

| 层 | 单进程 TUI | Daemon TUI | 兼容性 |
|---|---|---|:---:|
| **显示层（Ink 组件）** | `BackgroundTasksDialog.tsx` / `AgentExecutionDisplay.tsx` 等 | **同一组组件**（直接复用 `packages/cli/src/ui/components/`）| ✅ **100%** |
| **状态层（React Context / hooks）** | `BackgroundTaskViewContext` / `SessionContext` 等 | 同一份 Context shape | ✅ **100%** |
| **数据源层** | in-process（`Session.handleXxx()` 直接 import）| **HttpAcpAdapter 翻译 SSE → React state** | ⚠️ **替换** |
| **本地依赖功能** | 直接读 fs / spawn editor / clipboard | **需 daemon RPC 或 client fallback** | ⚠️ **5 类 case-by-case** |

**多 TUI 客户端共 session** 是 daemon 模式的免费红利（决策 §1 默认 `single` + §6 fan-out 启用）。

## 二、Qwen TUI 现状（单进程模式）

### 2.1 组件结构

源码位置 `packages/cli/src/ui/`：

```
packages/cli/src/ui/
├─ components/
│   ├─ background-view/                    # PR#3488/3720/3791/3836 (4 kinds)
│   │   ├─ BackgroundTasksPill.tsx          (~40 行 · 状态行运行计数)
│   │   ├─ BackgroundTasksDialog.tsx        (~470 行 · 4 kinds 统一 dialog)
│   │   └─ MonitorDetailBody.tsx            (PR#3791 Monitor 详情)
│   ├─ subagents/runtime/AgentExecutionDisplay.tsx  (3 档 compact/default/verbose)
│   ├─ messages/ToolGroupMessage.tsx         (焦点锁 PR#3771)
│   ├─ permission/PermissionRequestDialog.tsx
│   ├─ mcp/                                  (MCP 连接状态)
│   ├─ agent-view/                           (subagent 视图)
│   ├─ views/                                (主视图 / 设置视图)
│   └─ shared/                                (复用 UI primitives)
├─ contexts/
│   ├─ AppContext.tsx                        (顶层应用状态)
│   ├─ BackgroundTaskViewContext.tsx          (4 kinds 任务状态)
│   ├─ SessionContext.tsx                     (session 状态)
│   ├─ KeypressContext.tsx                    (键盘事件)
│   ├─ ShellFocusContext.tsx                  (焦点锁实现 PR#3771)
│   ├─ StreamingContext.tsx                   (流式输出)
│   ├─ OverflowContext.tsx                    (输出截断)
│   ├─ ConfigContext.tsx                      (配置)
│   ├─ SettingsContext.tsx                    (settings)
│   ├─ UIActionsContext.tsx                   (UI action dispatcher)
│   ├─ UIStateContext.tsx                     (UI state)
│   ├─ AgentViewContext.tsx                   (agent 视图)
│   ├─ CompactModeContext.tsx                 (compact 模式)
│   └─ VimModeContext.tsx                     (Vim 输入)
├─ hooks/                                     (业务逻辑 hooks)
│   ├─ atCommandProcessor.ts                  (@文件路径补全)
│   ├─ slashCommandProcessor.ts               (/命令处理)
│   ├─ shellCommandProcessor.ts               (!shell 命令)
│   ├─ useAgentsManagerDialog.ts
│   ├─ useAgentStreamingState.ts
│   └─ ...
├─ commands/                                  (slash 命令实现)
├─ editors/                                   (输入编辑器)
├─ themes/                                    (主题，OSC 11 检测)
├─ layouts/                                   (TUI 布局)
└─ noninteractive/                            (headless 模式 UI)
```

**关键观察**：所有组件 + Contexts 都**通过 React 抽象**与具体数据源解耦——组件只关心 props / Context value 的 shape，不关心数据从哪里来。

### 2.2 单进程数据流

```
┌─────────────────────────────────────────────────────┐
│ qwen 主进程（单进程模式）                            │
│                                                      │
│  ┌──────────────────────────────────┐               │
│  │ Ink TUI（React 树）                 │               │
│  │ ├─ BackgroundTasksPill           │               │
│  │ │   └─ useBackgroundTaskView()    │               │
│  │ ├─ BackgroundTasksDialog          │               │
│  │ │   └─ 同 hook                    │               │
│  │ └─ ToolGroupMessage（焦点锁）      │               │
│  └──────────────────────────────────┘               │
│              ↑                                       │
│  ┌──────────────────────────────────┐               │
│  │ React Contexts                    │               │
│  │ ├─ BackgroundTaskViewContext      │               │
│  │ ├─ SessionContext                 │               │
│  │ └─ ...                            │               │
│  └──────────────────────────────────┘               │
│              ↑                                       │
│  ┌──────────────────────────────────┐               │
│  │ Provider（订阅 in-process registry）│               │
│  │ - subscribeToBackgroundTaskRegistry()              │
│  │ - subscribeToSessionEmitter()                      │
│  └──────────────────────────────────┘               │
│              ↑                                       │
│  ┌──────────────────────────────────┐               │
│  │ core (in-process)                 │               │
│  │ ├─ BackgroundTaskRegistry          │               │
│  │ ├─ Session                        │               │
│  │ ├─ MCP / LSP managers              │               │
│  │ └─ LLM HTTP client                 │               │
│  └──────────────────────────────────┘               │
└─────────────────────────────────────────────────────┘
```

**特点**：所有数据通过函数调用 / EventEmitter 在同一 V8 isolate 内传递，零开销。

## 三、Daemon TUI 数据流

```
TUI process (lightweight)              daemon process
                                       (持有所有状态)
┌────────────────────────────┐        ┌─────────────────────┐
│ Ink TUI (React 树)          │        │ HTTP / SSE server   │
│ ├─ BackgroundTasksPill      │        │                     │
│ ├─ BackgroundTasksDialog     │        │                     │
│ └─ 其他组件                  │        │                     │
└────────────────────────────┘        │                     │
              ↑                        │                     │
┌────────────────────────────┐        │                     │
│ React Contexts              │        │                     │
│ (与单进程模式同 shape)       │        │                     │
└────────────────────────────┘        │                     │
              ↑                        │                     │
┌────────────────────────────┐        │                     │
│ HttpAcpAdapter              │←HTTP/SSE→│ HttpAcpAdapter   │
│ - subscribeSse()            │        │ (server side)       │
│ - onSessionNotification()   │        │                     │
└────────────────────────────┘        │                     │
                                       └─────────────────────┘
              ↓                                  ↑
              │ keypress events                  │
              │ /edit / file completion          │
              ↓                                  ↓
┌────────────────────────────┐        ┌─────────────────────┐
│ 本地资源                    │        │ core (in-process)   │
│ - stdin keypress            │        │ ├─ Session          │
│ - $EDITOR spawn             │        │ ├─ MCP / LSP        │
│ - 剪贴板 OSC 52             │        │ ├─ Background       │
│ - 终端能力（OSC 11 主题）   │        │ └─ FileReadCache    │
└────────────────────────────┘        └─────────────────────┘
```

## 四、4 层各自详解

### 4.1 显示层（100% 兼容）

```ts
// packages/cli/src/ui/components/background-view/BackgroundTasksDialog.tsx
// 单进程和 daemon 模式都用同一份代码

export function BackgroundTasksDialog() {
  const { tasks, selectedTaskId, dispatch } = useBackgroundTaskView()
  
  return (
    <Box flexDirection="column">
      {tasks.map((task) => (
        <Box key={task.id}>
          <Text>[{task.kind}] {task.title}</Text>
          {task.kind === 'monitor' && <MonitorDetailBody task={task} />}
        </Box>
      ))}
    </Box>
  )
}
```

**这个组件不知道 tasks 从哪里来**——单进程模式下来自 `BackgroundTaskRegistry.publish()`，daemon 模式下来自 SSE event。组件代码 0 改动。

### 4.2 状态层（100% 兼容）

```ts
// packages/cli/src/ui/contexts/BackgroundTaskViewContext.tsx
interface BackgroundTaskViewValue {
  tasks: BackgroundTask[]              // ← 4 kinds 统一类型
  pillCount: { running, completed, failed, cancelled }
  selectedTaskId: string | null
  dispatch: (action: BackgroundTaskAction) => void
}

// Context shape 不变；仅 Provider 实现不同
const BackgroundTaskViewContext = createContext<BackgroundTaskViewValue>(...)
```

**Provider 切换**：

```tsx
// 单进程模式 Provider
<InProcessBackgroundTaskProvider>
  <App />
</InProcessBackgroundTaskProvider>

// daemon 模式 Provider
<HttpBackgroundTaskProvider adapter={httpAcpAdapter}>
  <App />
</HttpBackgroundTaskProvider>

// 但 <App /> 内部组件用 useBackgroundTaskView() 读 Context value 的代码完全相同
```

### 4.3 数据源层（替换，但有 adapter）

```ts
// 单进程模式 Provider 实现
function InProcessBackgroundTaskProvider({ children }) {
  const [tasks, setTasks] = useState([])
  
  useEffect(() => {
    const registry = config.getBackgroundTaskRegistry()
    const unsub = registry.subscribe((event) => {
      // event 来自 EventEmitter
      setTasks(prev => applyEvent(prev, event))
    })
    return unsub
  }, [])
  
  return <Context.Provider value={{ tasks, ... }}>{children}</Context.Provider>
}

// daemon 模式 Provider 实现
function HttpBackgroundTaskProvider({ adapter, children }) {
  const [tasks, setTasks] = useState([])
  
  useEffect(() => {
    const unsub = adapter.onSessionNotification((notif) => {
      // notif 来自 SSE event，但 shape 与单进程模式同
      if (notif.type === 'task_added') setTasks(prev => [...prev, notif.task])
      if (notif.type === 'task_status_changed') updateTask(notif.taskId, notif.status)
      // ...
    })
    return unsub
  }, [])
  
  return <Context.Provider value={{ tasks, ... }}>{children}</Context.Provider>
}
```

**关键点**：两种 Provider 的 React state 结构（tasks 数组的 entry shape）**完全相同**——因为 daemon 端用 ACP zod schema 序列化 SessionNotification，反序列化后就是与 in-process EventEmitter 同 shape 的对象。

### 4.4 本地依赖功能（5 类 case-by-case）

#### 4.4.1 文件路径补全（atCommandProcessor.ts）

```ts
// 单进程: 直接读本地 fs
const files = await fs.promises.readdir(workspaceRoot)

// daemon 同 host: 仍直接读本地 fs（最快）
//   workspace 路径在客户端能解析
//   节省 daemon 一次 RPC 往返

// daemon 跨 host: 走 daemon RPC
const res = await fetch(`${daemonUrl}/workspace/${wsId}/file?prefix=${prefix}`)
const files = await res.json()
```

**TUI 自动判断**：

```ts
function getFileCompletions(prefix: string) {
  const config = useConfig()
  if (config.daemon?.sameHost ?? true) {
    return readLocalFs(prefix)         // 同 host 走本地
  } else {
    return fetchDaemonFs(prefix)       // 跨 host 走 RPC
  }
}
```

#### 4.4.2 `/edit` 打开本地编辑器

```ts
// packages/cli/src/ui/editors/...
// 单进程和 daemon 模式都一样：spawn $EDITOR

// 即使 daemon 在远端，编辑器仍要跑在用户本地终端附近
spawn(process.env.EDITOR, [tempFilePath], { stdio: 'inherit' })

// 但文件本身在哪？
// - 同 host: temp file 在本地 /tmp，daemon 也能读
// - 跨 host: daemon download → 本地 temp → spawn editor → 上传回 daemon
```

**跨 host 完整流程**：

```ts
async function editFileViaDaemon(workspaceId: string, path: string) {
  // 1. 从 daemon 拉文件
  const content = await fetch(`${daemonUrl}/workspace/${workspaceId}/file?path=${path}`)
    .then(r => r.text())
  
  // 2. 写到本地 temp
  const tempPath = `/tmp/qwen-edit-${randomId()}`
  await fs.writeFile(tempPath, content)
  
  // 3. spawn 本地 editor
  await spawnSync(process.env.EDITOR, [tempPath], { stdio: 'inherit' })
  
  // 4. 读回修改后的内容
  const modified = await fs.readFile(tempPath, 'utf-8')
  
  // 5. 上传到 daemon（受 PR#3774 prior-read 守卫，确保走过 read 路径）
  await fetch(`${daemonUrl}/workspace/${workspaceId}/file`, {
    method: 'POST',
    body: JSON.stringify({ path, content: modified }),
  })
  
  // 6. 删本地 temp
  await fs.unlink(tempPath)
}
```

#### 4.4.3 剪贴板（OSC 52 / clipboard 命令）

```ts
// 终端 OSC 52 escape sequence，与 daemon 无关
process.stdout.write(`\x1b]52;c;${base64(text)}\x07`)

// 即使 TUI 远程连 daemon，也是在本地终端执行 OSC
// 完全 client-side，daemon 不参与
```

#### 4.4.4 键盘快捷键

```ts
// packages/cli/src/ui/contexts/KeypressContext.tsx
// 直接读 stdin，与 daemon 无关
useStdin().on('keypress', handler)

// daemon 模式: 同样在 TUI 进程内读 stdin
// 处理后通过 HTTP API 发命令到 daemon
```

#### 4.4.5 Git status 显示

```ts
// 状态行常显示 git branch / 修改文件数
// 单进程: 直接 git status
// daemon 模式:
//   - 同 host: 仍直接 git（节省 RPC）
//   - 跨 host: GET /workspace/:id/git/status
```

### 4.5 5 类本地依赖功能汇总

| 功能 | 单进程 | Daemon 同 host | Daemon 跨 host |
|---|---|---|---|
| 文件路径 Tab 补全 | 本地 fs | **本地 fs**（fast path）| daemon RPC |
| `/edit` 打开 $EDITOR | 直接 | **直接**（temp 在本地）| download → edit → upload |
| 剪贴板（OSC 52）| 终端能力 | 终端能力 | 终端能力 |
| 键盘快捷键 | stdin | stdin | stdin |
| Git status 显示 | 本地 git | **本地 git**（fast path）| daemon RPC |
| 终端主题检测（OSC 11）| 终端能力 | 终端能力 | 终端能力 |
| 大 paste 内容 | 本地处理 | 本地处理 + 上传 | 上传时 base64 |

**关键设计**：TUI 优先走**本地 fast path**（同 host），仅在跨 host 时回退到 daemon RPC。这避免了"明明 daemon 在本地仍走 HTTP"的不必要开销。

## 五、典型 TUI 启动流程

### 5.1 单进程模式（当前）

```bash
$ qwen
# 同一进程内启动 TUI + core + LLM 客户端
```

```
qwen process
├─ Ink TUI (React)
├─ core (Session / FileReadCache / MCP managers / ...)
└─ LLM HTTP client
```

### 5.2 Daemon 模式

```bash
# 终端 A: 启 daemon
$ qwen serve --port 5096
opencode-style: opencode serve listening on http://127.0.0.1:5096

# 终端 B: 启 TUI 客户端
$ qwen tui --connect http://localhost:5096
# 或
$ qwen --daemon                # 自动连本地 daemon
```

```
TUI process (lightweight)              daemon process
├─ Ink (React)              ←HTTP/SSE→ ├─ Session
├─ HttpAcpAdapter                       ├─ FileReadCache
├─ keypress / clipboard                 ├─ MCP / LSP
└─ 文件补全（如果同 host）              └─ LLM 调用
```

### 5.3 Daemon 自动启动（External 增强 / Stage 2 后）

参考 OpenCode 的 `createOpencodeServer()` 模式：

```bash
$ qwen
# 1. 检查 ~/.qwen/daemon.pid 是否有运行中 daemon
# 2. 如果没有 → 后台启 daemon → 等就绪
# 3. 启 TUI 连本地 daemon
# 用户体验: 与单进程 mode 命令一致，但底层走 daemon
```

## 六、多 TUI 客户端共 session（决策 §1 + §6 启用）

### 6.1 多 TUI 拓扑

```
                    daemon (sess-foo)
                       ↑↑↑
        ┌──────────────┼──────────────┐
       TUI A         TUI B          Web UI
      (CLI 终端 1)   (CLI 终端 2)    (浏览器)
```

### 6.2 实时同步行为

```
1. TUI A 用户输入 "请重构 src/foo.ts" → POST /session/sess-foo/prompt

2. daemon 接收 → Session.handlePrompt() 启动

3. daemon SSE 广播给所有订阅者:
     SSE event: { type: 'message_part', content: '我开始...' }
     
   所有 client 同时接收:
     - TUI A 的 SSE → 更新 React state → 屏幕实时显示
     - TUI B 的 SSE → 同样更新 → 屏幕实时显示
     - Web UI → 同样更新

4. daemon 决定调 Bash 触发 permission_request
   SSE event: { type: 'permission_request', requestId: 'r1', tool: 'Bash', ... }
   
   3 个 client 都通过 SSE 收到事件，弹 permission dialog:
     - TUI A: 终端 dialog 显示 "Allow Bash? y/n/x"
     - TUI B: 同样 dialog
     - Web UI: 浏览器对话框

5. 用户在 TUI B 上按 y
   POST /permission/r1 { allow: true, respondedBy: 'tui-b' }
   
   daemon resolve pending → 广播 permission_resolved:
     - TUI A: 自动关闭 dialog（"resolved by tui-b"）
     - TUI B: 关闭自己的 dialog
     - Web UI: 关闭对话框

6. daemon 继续执行 → SSE 广播 tool_result + message_part
```

### 6.3 焦点锁与多 client 协调

PR#3771 引入的 `ShellFocusContext` 焦点锁机制在 daemon 模式下需要重新设计：

| 场景 | 单进程 | Daemon |
|---|---|---|
| 多个 subagent 触发审批 | 焦点锁单 TUI 内串行 | 仍单 TUI 内串行（每个 TUI 独立焦点）|
| 多 TUI client 同时订阅 | N/A（只有一个 TUI）| 每个 TUI 独立显示 + first responder wins |

`ShellFocusContext` 是 client-side 概念，daemon 不感知。每个 TUI 自己管理本地焦点。

## 七、与 OpenCode TUI 对比

OpenCode 也有 TUI（参考 `packages/opencode/src/server/routes/instance/tui.ts`）：

| 维度 | OpenCode TUI | Qwen TUI（本设计）|
|---|---|---|
| 实现语言 | TypeScript（React + Ink）| **TypeScript（React + Ink，同款）** |
| 渲染层 | Ink | **Ink（同款）** |
| 连接方式 | HTTP + SSE | **HTTP + SSE/WebSocket（同款）** |
| 数据源 adapter | OpenAPI codegen client | **HttpAcpAdapter（复用 ACP zod）** |
| 多 TUI 共 session | 支持 | **支持（决策 §1 默认 single）** |
| 单进程 mode 兼容 | ❌（OpenCode 无非 daemon mode）| ✅ **完全兼容**（保留 stdio ACP / process mode）|
| 文件补全 fast path | ❌（总走 daemon）| ✅ **同 host 走本地 fs** |
| Daemon 自动启动 | ✓ `createOpencodeServer()` | External 增强 / Stage 2 后可加 |

**Qwen TUI 独有 2 项优势**：

1. **保留单进程 mode** —— 用户可选不启 daemon（小项目 / 离线 / IDE 集成 / CI 一次性），与 daemon mode 体验完全一致（同一组组件）
2. **本地 fast path** —— 同 host 时文件补全 / git status 走本地 fs，比 OpenCode 必走 daemon RPC 更快

## 八、迁移路径

### 8.1 用户视角

```
旧（仅单进程）:
  $ qwen
  → 启 qwen 进程：TUI + core + LLM 一体

新（默认仍单进程，daemon opt-in）:
  $ qwen                           # 仍单进程，零改动
  $ qwen serve                     # 显式启 daemon (Mode B headless)
  $ qwen --serve                   # CLI + HttpServer (Mode A, Stage 1.5)
  $ qwen --daemon=local            # 启 TUI 连本地 daemon (External 自动启动)
  $ qwen --daemon=remote.com:8080  # 跨 host 连 (External 远端 client)
  $ qwen tui --connect ...         # 仅 TUI 模式
```

### 8.2 开发者视角

`packages/cli/src/ui/components/` **0 行修改**——只需新写 Provider 实现：

| 文件 | Stage 2 改动 |
|---|---|
| `packages/cli/src/ui/components/*` | 0 行（已用 Context）|
| `packages/cli/src/ui/contexts/*Context.tsx` | 0 行（shape 不变）|
| `packages/cli/src/ui/providers/in-process/*` | 抽出现有 Provider 到此 |
| `packages/cli/src/ui/providers/http-daemon/*` | **新增**（~500-1000 行 Provider 集 + adapter）|
| `packages/cli/src/cli/cmd/serve.ts` | 新增（参考 OpenCode）|
| `packages/cli/src/cli/cmd/tui-connect.ts` | 新增 |

## 九、3 阶段路线图

```
Stage 1 (Mode B headless qwen serve, PR#3889): TUI 不动，仍单进程跑 ACP agent
  └─ TUI 体验与现状 100% 一致
  └─ daemon 在 ACP agent 子进程外面包了 HTTP 桥接，TUI 不感知

Stage 1.5 / Stage 2 (Mode A + daemon 完善): 新增 qwen tui --connect 命令
  └─ TUI 通过 HttpAcpAdapter 连 daemon
  └─ HttpBackgroundTaskProvider / HttpSessionProvider 等新 Provider
  └─ 单进程 qwen 命令保留作 reference
  └─ 多 TUI 共同一 daemon instance 的唯一 session（决策 §1 默认 single）
  └─ 本地 fast path（同 host 文件补全 / git）

External Phase 1 (对标 OpenCode): TUI 默认 daemon mode
  └─ qwen 命令优先尝试连本地 daemon
  └─ 失败回退到单进程
  └─ Daemon 自动启动机制（同 OpenCode createOpencodeServer）
  └─ 跨 host TUI 完整支持（含 /edit 远程文件协议）
```

## 十、TUI 兼容性测试矩阵

落地时必须保证以下场景在两种模式下行为一致：

| 测试场景 | 单进程 | Daemon |
|---|---|---|
| 用户输入 prompt → 看到 message_part 流 | ✓ | ✓ |
| Agent 调 Bash → permission dialog → 用户 approve | ✓ | ✓ |
| 4 kinds 后台任务（agent/shell/monitor/dream）pill + dialog | ✓ | ✓ |
| Subagent 输出实时显示（PR#3721 visual height bound）| ✓ | ✓ |
| Ctrl+C 取消 prompt | ✓ | ✓（daemon 端 task_stop）|
| Ctrl+E / Ctrl+F 三档切换 | ✓ | ✓ |
| 焦点锁并发审批 | ✓ | ✓（每 TUI 独立焦点 + first responder）|
| @文件路径补全 | 本地 fs | 本地（同 host）/ daemon RPC（跨 host）|
| `/edit` 打开 $EDITOR | 直接 | 同上 |
| `/clear` 清屏 | ✓ | ✓ |
| `/tasks` 列表 | ✓ | ✓ + monitor 行（PR#3801）|
| 终端主题检测（OSC 11）| ✓ | ✓（client 终端能力）|
| 多 TUI 共 session | N/A（单 TUI）| ✓（daemon 独有）|
| Daemon 重启后 TUI 自动重连 | N/A | ✓（SSE auto-reconnect）|

## 十一、关键挑战与设计

### 11.1 SSE 断线重连

```ts
class HttpAcpAdapter {
  private sse: EventSource
  private retryDelay = 1000
  
  async start() {
    this.sse = new EventSource(`${this.baseUrl}/session/${this.sessionId}/events`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    })
    
    this.sse.onerror = () => {
      this.sse.close()
      // 指数退避重连
      setTimeout(() => this.start(), this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, 30_000)
    }
    
    this.sse.onopen = () => {
      this.retryDelay = 1000  // 成功连接重置
      // 可选: 触发 LoadSession 重新拉取最新 transcript（处理断线期间的 missed events）
    }
  }
}
```

### 11.2 大 paste 内容处理

```ts
// 用户粘贴大段代码到 prompt
// 单进程: TUI 直接处理
// daemon 模式:
//   - 小内容(<10KB): HTTP body 直接送
//   - 大内容(>10KB): 先 POST /session/:id/attachment 获取 attachmentId
//     再 prompt body 引用 { type: 'attachment', id: attachmentId }
//   - 与 PR#3500 系列大 paste 自动外化设计协调
```

### 11.3 主题切换

```ts
// 主题状态在 TUI client 端（影响渲染颜色）
// daemon 不感知 theme

// PR#3460 已实现 OSC 11 自动检测
// daemon 模式下: TUI 检测自己的终端，daemon 仍传 raw text + tag，TUI 自己上色
```

## 十一·五、在 Web 浏览器渲染 TUI 的 3 条路线

**问题**：能否在浏览器里渲染 TUI？哪条路线对窄带宽最友好？

### 11.5.1 三条路线

| 路线 | 做法 | 视觉一致性 | 工作量 | a11y / 移动端 |
|---|---|:---:|:---:|:---:|
| **1. xterm.js + ANSI 流** | Ink 渲染的 ANSI 字节流通过 SSE/WS 转发；浏览器用 xterm.js 还原 | ✅ 100% | ~2-3d 单向（只读）/ +1w 加 PTY 输入 | ❌ |
| **2. React DOM port（同组件不同 renderer）** | 同一 React 组件树用 react-dom 渲染 | ✅ | ~数月（每个 Ink primitive 都要 DOM 等价物，类似 react-native-web）| ✅ |
| **3. 独立组件 + 共享事件流（Qwen 现状）** | `packages/web-ui/` 自己一套 React+DOM 组件，消费决策 §6 同一份 ACP 事件流 | ⚠️ 设计可不同 | 维护两套 UI（但每套独立演进）| ✅ |

### 11.5.2 窄带宽对比（核心结论）

**路线 3 比路线 1 节省 3-10× 带宽**。

**直观对比**（1000-token LLM 响应）：

| 路线 | 传输内容 | 原始大小 | gzip 后 |
|---|---|---|---|
| **路线 1（ANSI 流）** | 每 token 触发 Ink reconcile → 行级清除 + 重画 + 颜色码（每字符 ~50-100 bytes 包装） | ~50-100 KB | ~10-30 KB |
| **路线 3（ACP 结构化）** | `message_part` delta event（~30 bytes 框架 + 2-10 bytes content delta） | ~10-30 KB | **~3-10 KB** |

### 11.5.3 为什么 ANSI 流更胖

1. **冗余**——发送的是"怎么画"（光标定位 + 清行 + 重写 + 颜色码），不是"变了什么"
2. **Ink 流式响应触发频繁 reconcile**——每 token 一次 React 渲染 → 一次 ANSI patch 输出；如果该行变长还要换行重排
3. **不可丢弃**——丢一个 ANSI 帧 = 屏幕错位；客户端必须严格顺序消费
4. **聚合不友好**——SSE 中 ANSI 帧无语义边界，难做 batching / coalescing

### 11.5.4 路线 3 的额外带宽优势

- `message_part` delta 可被 web-ui 本地累积（不需要重发已显示的内容）
- 大 `tool_result`（如 10MB 文件）可加 `lazy: true` 让 client 按需 fetch（路线 1 必须全部传）
- `Last-Event-ID` 重连只补丢失的 events（路线 1 重连必须发 full screen redraw）
- 移动端可只订阅高优先级 event（如只要 `permission_request` + 跳过 `message_part`）

### 11.5.5 推荐

| 场景 | 推荐路线 |
|---|---|
| **窄带宽 / 移动 / 流量敏感**（典型生产场景）| **路线 3（现状）**——`web-ui/` 已经走这条 |
| **演示分享 / 投屏 / oncall 旁观**（视觉一致优先，只读为主）| 路线 1 旁路（Mode A 下让 Ink stdout tee 一份到 `event: tui_frame` SSE，浏览器用 xterm.js 只读还原；~2-3d 增量）|
| **重度 CLI 用户想完整可交互浏览器终端** | 路线 1 + WebSocket PTY 输入协议（~+1w；但路线 3 + 终端风格 web-ui 主题更划算）|
| **同一组件在 CLI 和 Web 100% 一致** | 路线 2——**不推荐**（每个 PR 维护两套 renderer 工程量不匹配收益）|

### 11.5.6 与 §03 §7 双部署模式的关系

- **Mode A（CLI + HttpServer）**：本地 TUI（in-process subscriber）+ 远端 web-ui（路线 3）共享同一 EventBus 同一 session；窄带宽友好天然成立
- **Mode B（Headless Daemon）**：所有 client 走 HTTP/SSE；web-ui = 路线 3；如要 xterm.js 旁路（路线 1）需另开 `tui_frame` event channel
- **路线 1 旁路最自然的位置**：Mode A 下 Ink 已经在跑 TUI 渲染，只需在 stdout 写入处 tee 一份到 SSE；Mode B 下 daemon 没跑 TUI，要专门启 headless Ink renderer，工作量翻倍

详见 [§03 §7 双部署模式](./03-architectural-decisions.md#7-daemon-部署模式clihttpserver-vs-headlesshttpserver)。

## 十一·六、现有 dual-output 与 Mode A 的对比

> Qwen Code 已有 [dual-output 功能](https://qwenlm.github.io/qwen-code-docs/zh/users/features/dual-output/)（`qwen --json-file <events.jsonl> --input-file <input.jsonl>`）—— TUI 在终端正常渲染，同时把所有事件写到 JSONL 文件、监控另一个 JSONL 文件读入命令。是否能用它做"多端共享同一 session"？

### 11.6.1 dual-output 机制

```bash
qwen --json-file /tmp/events.jsonl --input-file /tmp/input.jsonl
```

- **Sidecar 模式**：TUI 在终端正常渲染（stdout）；同时把 ACP 事件 JSONL 流式写到 `events.jsonl`
- **bidi 文件 I/O**：监控 `input.jsonl`，外部程序 append-only 写命令，TUI 读取执行
- **不是 server**——纯文件级 stdio bridging
- 事件类型：`session_start` / `stream_event` / `user` / `assistant` / `control_request` / `control_response`
- 命令类型：`submit` / `confirmation_response`

### 11.6.2 dual-output 能做到的"多端共享"

| 能力 | dual-output | 说明 |
|---|---|---|
| 多个外部程序同时读 events.jsonl | ✅ | Chat UI / VSCode / web 前端可并行 tail |
| 多个外部程序同时写 input.jsonl | ✅ | 任一端都能发 prompt / approve permission |
| Tool approval 抢答 | ⚠️ | 文档说"whichever approves first wins"——靠 file write 顺序，非协议保证 |
| 同步同一 session 状态 | ✅ | events.jsonl 是 canonical transcript |

### 11.6.3 dual-output 缺的协调能力（vs Mode A daemon HTTP/SSE）

| 能力 | dual-output | Mode A（[§03 §7](./03-architectural-decisions.md#7-daemon-部署模式clihttpserver-vs-headlesshttpserver)）|
|---|---|---|
| 跨机器（远端 client）| ❌ 仅同机本地文件 | ✅ HTTP 走任何网络 |
| Bearer token / 认证 | ❌ 任何能读文件的进程都能加入 | ✅（[§07](./07-permission-auth.md)）|
| First-responder permission vote 协议 | ❌ 文件 race | ✅ 协议级抢答 + 防双 approve（[§03 §6](./03-architectural-decisions.md#6-多-client-并发请求)）|
| Last-Event-ID 重连补漏 | ❌ 只能重读整个 jsonl | ✅ EventBus + ring replay（[§15](./15-high-availability.md)）|
| Fan-out backpressure / bounded queue | ❌ 文件无限追加 | ✅ subscriber bounded queue + evict（[§17](./17-client-coordination.md)）|
| 多端输入串行 / 排队 | ❌ 多 writer append 无原子保证 | ✅ session task queue 串行 |
| Heartbeat / 断连检测 | ❌ 文件读者断开 TUI 不知 | ✅ 15s heartbeat + AbortController |
| 跨 client capability 反向 RPC | ❌ | ✅（[§16](./16-remote-cli-mode.md)）|
| 多 session 路由 | ❌ 一对文件路径 = 一 session | ✅ orchestrator |

### 11.6.4 定位

**dual-output ≈ Mode A 的"穷人版"**：
- 提供"同机多端观察 + 输入同一 session"的最小可行实现
- 适合演示分享 / 同机 IDE 集成 / 测试自动化（jq pipeline）
- **不适合**真正的"多端协作"（手机 + 电脑 + 团队成员）

**Mode A HTTP/SSE**：
- 提供**协议级**的多端协作（fan-out + 抢答 + 重连 + 认证 + 跨网络）
- live collaboration 模型（与 Google Docs 多人编辑同构）

### 11.6.5 升级 dual-output 到真正多端共享 = 重写为 HTTP server

| 升级项 | 等价改动 |
|---|---|
| File I/O → HTTP/SSE | = Mode A 启动 Express server |
| 加 bearer token | = [§07 §1](./07-permission-auth.md) 鉴权 |
| 加 fan-out + bounded queue | = [§03 §6](./03-architectural-decisions.md#6-多-client-并发请求) EventBus |
| 加 Last-Event-ID 重连 | = [§15 §五](./15-high-availability.md) SSE 重连协议 |

→ 直接做 Mode A 即可，不需要"先升级 dual-output"。

### 11.6.6 互补而非替代

dual-output 和 Mode A 是**互补**关系：

| 场景 | 推荐方案 |
|---|---|
| 嵌入到现有 ChatUI（PTY 套壳）/ 测试自动化 / jq pipeline | **dual-output**（轻量、文件级、无新依赖）|
| 多端协作（手机 + 电脑 + WebUI 同时跑）| **Mode A**（`qwen --serve`）|
| 远端 daemon（服务器 / 容器）| **Mode B**（`qwen serve`）|

dual-output 的 `events.jsonl` 格式与 Mode A SSE 流的事件 schema 高度同源（都是 ACP 事件），**未来可考虑 dual-output 升级为"file 端口 + HTTP 端口"双输出**——保留文件路径给老用法，HTTP 端口给新用法，零迁移成本。

## 十一·七、Mode B 不渲染 TUI 是否减少 daemon 资源消耗

> 问题：daemon 不启 TUI（[§03 §7 Mode B](./03-architectural-decisions.md#7-daemon-部署模式clihttpserver-vs-headlesshttpserver)），把渲染交给远端 TUI / Web client，是否减少 qwen-code 对 CPU / 内存的消耗？

**简答：daemon 端节省 ~30% memory + ~5-15% streaming CPU + 200-500ms cold start，但总系统消耗不变——UI 工作转移到 client 端**。

### 11.7.1 TUI 渲染在 daemon 端的资源消耗

Qwen Code TUI 基于 Ink + React，在 daemon 进程中运行时持续消耗：

| 消耗项 | 估算 |
|---|---|
| Ink + React + chalk + theme 模块加载 | ~10-15MB heap |
| React component tree（components / contexts）| ~5-10MB |
| Ink internal state（virtual DOM / reconciler）| ~5-10MB |
| **Memory 小计（TUI 部分）** | **~20-30MB**（即 Mode A 比 Mode B 多消耗的部分）|
| 每 token 触发 React reconcile + ANSI patch 输出 | streaming 期间持续 CPU |
| stdin keypress 监听 + readline | 少量持续 |
| 终端宽度检测 / resize handler | 少量 |

### 11.7.2 Mode A vs Mode B 资源对比

| 维度 | Mode A（CLI + HttpServer）| Mode B（Headless）|
|---|---|---|
| **Memory baseline** | ~50-60MB | **~30-40MB**（省 Ink/React/theme）|
| **Streaming CPU** | 高——每 token reconcile + ANSI patch + HTTP fan-out | **低**——每 token 只 JSON.stringify + HTTP fan-out |
| **Module 加载时间** | ~1-3s（TUI 模块大）| **~0.8-2s** |
| **Cold start latency** | ~1-3s | **~0.8-2s**（省 200-500ms）|
| **stdin 监听** | ✅（耗 fd + I/O loop tick）| ❌ |
| **Idle CPU** | 极低（event loop sleeping）| 极低（同）|

**Mode B 在 daemon 端节省**：
- Memory ~20-30MB（占 Mode A daemon baseline 的 ~30-40%）
- Streaming CPU ~5-15%（具体取决于 LLM token 速率）
- Cold start 200-500ms

### 11.7.3 关键 caveat：总系统消耗不变

```
Mode A:  daemon (50-60MB, 含 TUI) + 0 client
         系统消耗：50-60MB + TUI CPU

Mode B:  daemon (30-40MB) + Web/远端 TUI client (50-100MB)
         系统消耗：80-140MB + UI CPU（在 client 端）
```

**UI 渲染的工作没消失，只是转移到 client 端**。Mode B 的 daemon 进程更瘦，但整个系统（daemon + client）总消耗反而**更高**——因为 client 端独立有自己的 V8 / 浏览器引擎。

### 11.7.4 真正"省"的场景

Mode B 节省 daemon 端资源**有实际意义**的场景：

| 场景 | 为什么 Mode B 更省 |
|---|---|
| **服务器 / 容器部署** | daemon 跑在受限内存配额（如 k8s pod 256MB limit）；client 在用户机器，内存不属于 daemon 配额 |
| **多 daemon instance**（Mode B 多 session）| N 个 daemon 各省 20-30MB → N=50 时省 1-1.5GB |
| **无人值守 daemon**（idle 长跑）| client 不连时 daemon 也在跑；省 TUI 内存 = 长期净节省 |
| **远端 client**（手机 / 浏览器 / IDE）| client 端 UI 必然存在；让 daemon 跑 TUI 是浪费 |
| **Cold start 敏感**（serverless / FaaS）| 启动时 200-500ms 差距重要 |

### 11.7.5 Mode A 不亏的场景

| 场景 | 为什么 Mode A 不亏 |
|---|---|
| **本地单用户 + 偶尔远端协作** | TUI 已经要跑（用户在终端看），多挂个 HTTP server 几乎免费（HTTP fan-out 的 CPU 远小于 TUI 渲染本身）|
| **演示 / 测试 / 调试** | 同时看 CLI + Web 视图最方便 |
| **client 数量少 / 间歇性接入** | Mode A 不需要永远跑 client，只有连上时才用 |

### 11.7.6 与资源池化（External SaaS）的协同

Mode B 多 session 部署时：

```
没池化：N daemon × 30-40MB = 1.5-2GB（N=50）
池化后：用户级 LSP/MCP/cache daemon 共享 → 单 daemon ~10-15MB
       N=50 时：50 × 12MB + 共享 50MB = 650MB（节省 ~70%）
```

**Mode B + 资源池化**是大规模 SaaS 的最省资源路径——daemon 进程只跑 LLM client + session state + HTTP server，所有"昂贵 daemon"（LSP / MCP / cache）走用户级共享。

### 11.7.7 推荐

| 用户 / 场景 | 推荐 |
|---|---|
| 本地单用户终端工作 | Mode A（`qwen --serve`），TUI 已经在跑，HTTP 几乎免费 |
| 服务器 / 容器 / 远端 daemon | Mode B（`qwen serve`），节省 daemon 端 ~30% memory |
| 大规模 SaaS（100+ session/机）| Mode B + External SaaS 资源池化路径 |
| 受限内存配额（k8s limit）| Mode B（必选）|

**结论**：Mode B 节省 daemon 端 ~30% memory + 200-500ms cold start，是 **daemon 端的局部优化**，不是系统级节省。真正价值在于：daemon 端资源紧张 / 部署在远端 / 多 session 实例化时，让 daemon 进程更瘦、cold start 更快、能跑更多实例。

---

## 十二、一句话总结

**TUI 的 Ink 组件 / React Context shape 单进程与 daemon 100% 兼容**（共用同一组 `packages/cli/src/ui/components/` + `contexts/`）—— 仅数据源层用 `HttpAcpAdapter` 替换 in-process Provider。**5 类本地依赖功能**（文件补全 / 编辑器 / 剪贴板 / 键盘 / git status）通过 client-side 处理 + 同 host fast path + 跨 host RPC 三层 fallback 优雅降级。**多 TUI 客户端共 session 是 daemon 模式的免费红利**（决策 §1 默认 `single` + §6 fan-out + first responder permission 自动启用）。**用户视角**：保留单进程命令兼容，daemon mode opt-in；Stage 2 后默认连 daemon 但失败回退单进程，与 OpenCode `createOpencodeServer` 同款。

---

[← 回到 README](./README.md) · [下一篇：实体模型与层级关系 →](./14-entity-model.md)
