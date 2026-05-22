# Codex MCP Server Deep-Dive —— 把 Codex 暴露给"别的 LLM"调用

> **核心问题**：Codex 是 4 家 Code Agent 中**唯一同时是 MCP 客户端 + MCP 服务端**的。它为什么暴露 MCP server？暴露了什么？谁是真正的用户？这跟 Claude / Qwen / OpenCode 的"只做 MCP 客户端"路线哲学差异在哪？
>
> 返回 [对比文档总览](./README.md)
>
> **配套文章**：
> - [ACP 支持 Deep-Dive](./acp-support-deep-dive.md) —— Qwen / OpenCode 选 ACP（IDE↔Agent）的路线
> - [SDK / ACP / Daemon 架构 Deep-Dive](./sdk-acp-daemon-architecture-deep-dive.md) —— 4 家程序化接口全景

## 零、TL;DR

**Codex 暴露 MCP Server 不是为用户用的，是为"别的 LLM agent"用的**——把 Codex 整个会话引擎包装成 MCP 工具，让 Claude / Gemini / 任何 MCP-aware 的上游模型把 Codex 当 subagent 调用。

| 维度 | Codex（独家） | Claude / Qwen / OpenCode |
|---|---|---|
| **作为 MCP 客户端**（接外部 MCP server） | ✅（`codex-mcp` crate ~3000 LOC） | ✅ 全员都做 |
| **作为 MCP 服务端**（被外部 LLM 调用） | ✅ **唯一**（`mcp-server` crate ~2400 LOC + `app-server` crate） | ❌ **全员不做** |

**关键技术细节**：Codex 实际上有**两个不同的 server binary**——`codex mcp-server`（标准 MCP，2 个工具）和 `codex app-server`（MCP-like 私有协议，full v2 RPCs，OpenAI VS Code 扩展用的就是这个）。官方文档把两者命名容易混淆，本文澄清。

## 一、Codex 的两个 Server Binary（必须澄清）

这是最容易被混淆的一点。Codex 有**两套独立的 server 接口**：

| 接口 | Binary | 协议 | 暴露内容 | 目标用户 |
|---|---|---|---|---|
| **`codex mcp-server`** | `codex-mcp-server` | **标准 MCP**（JSON-RPC over stdio NDJSON） | 2 个 MCP tools：`codex` + `codex-reply` | 任何 MCP-aware LLM / 工具 |
| **`codex app-server`** | `codex-app-server` | **MCP-like 私有协议**（"Similar to MCP, JSON-RPC 2.0 with the jsonrpc:2.0 header omitted") | full v2 RPCs（thread/turn/account/config/model 全控制平面） | OpenAI 自家 VS Code 扩展、深度集成场景 |

> **官方文档警告**：[`codex-rs/docs/codex_mcp_interface.md`](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md) 标题是 "Codex MCP Server Interface"，但列出的 v2 RPC（`thread/start` / `turn/start` 等）实际来自 **app-server-protocol**（14873 LOC）——属于 `app-server` 而非 `mcp-server`。文档把两者混在一起描述（标 "experimental"），但代码上 `mcp-server` 的 `message_processor.rs` 把 v2 自定义请求 dispatch 到 `CustomRequest`，**返回 "method not found"**。Today's reality：MCP server 只有 2 tools；v2 控制平面在 app-server 上。

### 两者的关系

```
                     ┌──────────────────────┐
其他 LLM (Claude) ──▶│  codex mcp-server    │──▶ 2 tools
                     │  (标准 MCP)          │
                     └──────────────────────┘
                              │
                              │ in-process
                              ▼
                     ┌──────────────────────┐
                     │  Codex 会话引擎       │
                     │  (ThreadManager 等)  │
                     └──────────▲───────────┘
                                │
                                │ in-process
                     ┌──────────┴───────────┐
OpenAI VS Code  ────▶│  codex app-server    │──▶ full v2 RPCs
深度集成 client      │  (MCP-like 私有)     │   (stdio/ws/unix)
                     └──────────────────────┘
```

两个 server 共享同一个 Codex 引擎，但对外提供不同接口层次。下文重点讲 `codex mcp-server`（真正的 MCP server），最后简单提 `codex app-server` 作为补充。

## 二、`codex mcp-server` 详解（标准 MCP，2 个工具）

### 启动方式

```bash
codex mcp-server                  # 直接启动，stdio NDJSON
codex-mcp-server                  # 等价二进制名
codex-mcp-server --strict-config  # 严格配置校验

# 用 MCP inspector 调试：
npx @modelcontextprotocol/inspector codex mcp-server
```

源码：[`codex-rs/mcp-server/`](https://github.com/openai/codex/tree/main/codex-rs/mcp-server)（~2400 LOC + tests）。

### 暴露的 2 个工具

| 工具 | 描述 | 输入 schema 关键字段 | 返回 |
|---|---|---|---|
| **`codex`** | Run a Codex session | `prompt`（必需）+ `model` / `cwd` / `approval-policy` / `sandbox` / `config` / `base-instructions` / `developer-instructions` | `{ threadId, content }` |
| **`codex-reply`** | Continue a Codex conversation by `conversationId` | `conversationId` + `prompt` | `{ threadId, content }` |

源码：[`codex-rs/mcp-server/src/codex_tool_config.rs:111-262`](https://github.com/openai/codex/blob/main/codex-rs/mcp-server/src/codex_tool_config.rs)。

### 典型 `codex` 工具调用

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "codex",
    "arguments": {
      "prompt": "implement OAuth callback in routes/auth.ts",
      "model": "gpt-5.2-codex",
      "cwd": "/path/to/repo",
      "approval-policy": "on-failure",
      "sandbox": "workspace-write"
    }
  }
}
```

返回：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "structured_content": {
      "threadId": "th_xxx",
      "content": "<final assistant message>"
    }
  }
}
```

### Approval 回调（server → client）

Codex 在执行需要审批的操作时（运行 shell / 写文件），会**反向调 client**：

| 反向请求 | 用途 |
|---|---|
| `applyPatchApproval` | 写文件审批 |
| `execCommandApproval` | 执行 shell 审批 |

这要求上游 LLM 实现 MCP **客户端反向请求处理**——能力较新，不是所有 MCP client 都支持。

源码：`codex-rs/mcp-server/src/exec_approval.rs` (147 LOC) + `patch_approval.rs` (142 LOC)。

### Event stream（notification）

执行中通过 MCP notification 推流：

| Notification | 内容 |
|---|---|
| `codex/event` | Codex 内部事件（对应 `core/src/protocol.rs` 的 `EventMsg`），含 `_meta.requestId` |
| `fuzzyFileSearch/sessionUpdated` / `sessionCompleted` | 旧 fuzzy search 兼容 |

## 三、为什么做这件事（4 个核心用例）

### ① 让别的 LLM 把 Codex 当代码专家 subagent 调用

最典型场景。Claude / Gemini / GPT-4 主导对话和决策，遇到需要**实际改代码**的子任务时，把任务转给 Codex（带 GPT-5-codex 的代码能力）：

```
用户 ──▶ Claude（主导，做架构 / 解释 / 协调）
              │
              │ 调 MCP "codex" tool
              ▼
         Codex 子会话（GPT-5-codex 改代码、跑测试、应用 patch）
              │
              ▼
         返回 threadId + final content 给 Claude
              │
              ▼
         Claude 继续解释 / 协调下一步
```

这是 **LLM 互相借专长** 的范式——Claude 不擅长某些代码任务，但 Claude 会**调 Codex 来做**。MCP 标准化了"agent 调 agent"的接口。

### ② 多 agent orchestration 框架原生支持

langgraph / autogen / crewai / langroid 等多 agent 框架本来就需要让一个 LLM 调另一个 LLM 的能力。Codex MCP server **省去框架专门接 Codex 的胶水代码**——直接当成普通 MCP server 接入即可，框架原生支持。

这跟 OpenAI 让 Codex "**可以被 OpenAI 生态外的工具消费**"的战略对齐——不要求用户用 OpenAI 自家 SDK。

### ③ 脚本 / 自动化里嵌入 Codex 调用

工程师写 shell / Python / n8n 工作流时，可以把 Codex 当一个**子进程黑盒**：

```bash
# Shell：一行起 Codex 做任务并拿结果
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"codex","arguments":{"prompt":"refactor src/api.ts",
                                              "sandbox":"workspace-write"}}}' \
  | codex mcp-server \
  | jq '.result.structured_content.content'
```

比走 SDK（要装 `openai-codex-app-server-sdk` Python 包等）简单，比对接 app-server v1/v2 协议（17K+ LOC schema）友好得多。

### ④ IDE 没集成 Codex？用 MCP 接入

Cursor / Cline / Continue 等 **已有的 IDE 扩展生态都已经接 MCP**（不接 ACP）。Codex 通过 MCP server 自动获得"被所有 MCP-aware IDE 集成"的能力——**不需要 Codex 团队为每个 IDE 写专属插件**。这跟 Qwen 选 ACP 是同一类问题的不同解法（详 §六）。

## 四、`codex app-server` 补充（OpenAI 自家深度集成）

源码：[`codex-rs/app-server/`](https://github.com/openai/codex/tree/main/codex-rs/app-server)。Binary：`codex-app-server`。

### Transport 多样性（4 家中独家）

```bash
codex app-server                                            # stdio (default)
codex app-server --listen ws://127.0.0.1:8765               # WebSocket (experimental)
codex app-server --listen unix:///$CODEX_HOME/...sock       # Unix socket via HTTP Upgrade
codex app-server --listen off                               # 不暴露本地传输
```

这是 4 家中 **transport 选项最丰富的**。Claude/Qwen/OpenCode 的对应物（NDJSON SDK / ACP / HTTP daemon）都是单 transport。

### 暴露的 RPC 类别

| 类别 | 方法 |
|---|---|
| **Thread 管理** | `thread/start` / `thread/resume` / `thread/fork` / `thread/read` / `thread/list` |
| **Turn 控制** | `turn/start` / `turn/steer` / `turn/interrupt` |
| **Account** | `account/read` / `account/login/start` / `account/login/cancel` / `account/logout` / `account/rateLimits/read` |
| **Config** | `config/read` / `config/value/write` / `config/batchWrite` |
| **Catalog** | `model/list` / `app/list` / `collaborationMode/list` |

这就是 **OpenAI VS Code 扩展用的协议**——比 MCP server 的 2 个 tools 富表达得多，但**协议是私有的**（不是标准 MCP）。

### app-server 与 MCP 的差异

| | MCP（标准） | app-server（私有） |
|---|---|---|
| JSON-RPC 2.0 header | `"jsonrpc": "2.0"` 显式 | **省略**（节省字节） |
| Transport | stdio | stdio / WebSocket / Unix socket |
| 方法形态 | 限定 `initialize` / `tools/*` / `resources/*` / `prompts/*` 等 | 自定义任意（`thread/start` 等） |
| 标准化兼容 | ✅ 所有 MCP client 都能连 | ❌ 需专属 client |

**为什么 OpenAI 自家集成不走 MCP？** ——MCP 的工具调用模型（`tools/call`）表达不了"细粒度 thread/turn 控制"。MCP 适合"调一个函数拿结果"，app-server 适合"完整对话引擎控制台"。

## 五、与其他 3 家"是否暴露 self-as-MCP"对比

```bash
$ grep -rln "expose.*MCP\|McpServer\|mcp-server" claude-code/ qwen-code/ opencode/ \
       --include="*.ts" --include="*.tsx" --include="*.rs"
# (返回结果只跟"消费 MCP server"相关，没有任何 expose-self-as-MCP 实现)
```

| 工具 | MCP 客户端 | MCP 服务端（暴露 self） | 替代方案 |
|---|:---:|:---:|---|
| **Claude Code** | ✅ `/mcp` 命令管理 | ❌ | 私有 NDJSON SDK（双向控制），自家 IDE 扩展 |
| **Codex** | ✅ `codex mcp` 管理 | ✅ **唯一** | + 自家 app-server 协议（VS Code 扩展） |
| **Qwen Code** | ✅ MCP server 管理 | ❌ | ACP agent + httpAcpBridge（详 [ACP Deep-Dive](./acp-support-deep-dive.md)） |
| **OpenCode** | ✅ MCP 集成 | ❌ | ACP agent + HTTP daemon（OpenAPI 13525 行）|

**Codex 是 4 家中唯一同时是 MCP 客户端 + 服务端的**。

### 哲学差异（呼应 ACP Deep-Dive §五）

| 工具 | 协议选择 | 自我定位 | 集成对象 |
|---|---|---|---|
| **Claude Code** | 私有 NDJSON + MCP 客户端 | "我是 IDE 的深度伙伴" | 接 IDE，私有协议 |
| **Qwen Code** | ACP + MCP 客户端 | "我是 IDE 标准生态的开放参与者" | 接 IDE，开放协议 |
| **OpenCode** | ACP + HTTP daemon + MCP 客户端 | "我是 IDE 和 web 通用 agent" | 接 IDE 和 web |
| **Codex** 🌟 | **MCP server + MCP 客户端 + 自家 app-server** | **"我是被别的 LLM 调用的代码专家工具 + 自家 IDE 的引擎"** | 接**其他 LLM**（MCP）+ 接 IDE（app-server）|

**Codex 的根本差异**：
- ACP 解决"**人 → IDE → Agent**"路径（用户为中心）
- MCP 当 Codex 用法解决"**Agent → Agent**"路径（LLM 互相调用为中心）

OpenAI 选 MCP server 不是技术限制——是**产品定位**：希望 Codex 成为"LLM 工具链里的代码执行专家"，而不是"另一个被嵌入 IDE 的 chat agent"。

Anthropic 推 MCP 时是希望 Claude 可以调任何工具（**Claude 是 caller**），Codex 反向用 MCP 让自己**被任何 LLM 调用**（**Codex 是 callee**）——一个把 MCP "调用方/被调用方"角色颠倒的用法。

## 六、当前局限 + 未来方向

### 局限

| 项 | 现状 |
|---|---|
| **MCP server 暴露面窄** | 仅 2 tools（`codex` / `codex-reply`），不是完整 thread/turn 控制 |
| **v2 RPCs 在 MCP 上不可用** | 官方文档 `codex_mcp_interface.md` 列了 v2，实际 mcp-server 只 dispatch 标准 MCP 请求 |
| **Approval 反向请求** | `applyPatchApproval` / `execCommandApproval` 要求 client 实现反向能力，主流 MCP client 支持不齐 |
| **状态 experimental** | 文档明标 "experimental and subject to change without notice" |

### 可能方向

1. **MCP server 加更多 tools** —— 比如 `codex-list-threads` / `codex-fork-thread` / `codex-interrupt`，逐步把 app-server 控制能力**翻译成 MCP tools 形态**
2. **v2 RPCs over MCP** —— 真正实现 `codex_mcp_interface.md` 描述的"v2 通过 MCP 暴露"愿景
3. **HTTP MCP transport** —— 当前只 stdio，将来可能加 HTTP（参 Anthropic MCP HTTP transport spec）

## 七、相关文档

- [ACP 支持 Deep-Dive](./acp-support-deep-dive.md) —— Qwen / OpenCode 选 ACP 的另一条路；本文与该篇形成"agent 接 LLM vs agent 接 IDE"的形态对照
- [SDK / ACP / Daemon 架构 Deep-Dive](./sdk-acp-daemon-architecture-deep-dive.md) —— 4 家程序化接口全景，含 Codex `app-server` 在 SDK 层的位置
- [Codex 工具组对比](./claude-code-vs-qwen-code-builtin-tools.md) —— Codex 工具能力的另一面
- [信息展示轴 Deep-Dive](./info-display-axis-deep-dive.md) —— Codex `Plan` mode / `Goal` 4 态等 UI 元素

## 八、相关源码

| 文件 | 用途 |
|---|---|
| `codex-rs/mcp-server/src/main.rs` | `codex-mcp-server` binary 入口 |
| `codex-rs/mcp-server/src/codex_tool_config.rs` | 2 个 MCP tool 的 schema 定义（438 LOC） |
| `codex-rs/mcp-server/src/codex_tool_runner.rs` | tool 执行逻辑（433 LOC） |
| `codex-rs/mcp-server/src/message_processor.rs` | MCP 请求 dispatch（610 LOC） |
| `codex-rs/mcp-server/src/exec_approval.rs` / `patch_approval.rs` | 反向 approval 实现 |
| `codex-rs/app-server/` | 独立的 app-server 实现 |
| `codex-rs/app-server-protocol/src/protocol/v2/` | full v2 控制平面 schema（14873 LOC） |
| `codex-rs/docs/codex_mcp_interface.md` | 官方文档（experimental，描述 mcp-server + 部分 app-server 内容） |
| `codex-rs/cli/src/main.rs:138` | `codex mcp-server` subcommand 定义 |
| `codex-rs/cli/src/mcp_cmd.rs` | `codex mcp` 客户端管理子命令（不要混淆！）|

---

> **数据来源**：Codex 2026-05-17 源码核实。`codex-rs/mcp-server/` 共 2918 LOC（src + tests），`codex-rs/codex-mcp/` 共 3030 LOC（src + tests），`codex-rs/app-server-protocol/src/protocol/v2/` 共 14873 LOC（含 3638 LOC tests）。文档时点：[`codex-rs/docs/codex_mcp_interface.md`](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md) 144 LOC，仍标 "experimental"。
