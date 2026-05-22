# Qwen Code SDK

> 分析版本：v0.16.0 | 分析日期：2026-05-22

## 1. 概述

Qwen Code SDK 为开发者提供编程式接口来调用 Qwen Code 的 AI 编程能力。SDK 目前覆盖三种语言：TypeScript、Python 和 Java，均处于实验阶段（experimental）。

**核心定位：**

- 将 Qwen Code CLI 的交互能力封装为可编程 API
- 支持单轮/多轮对话、工具权限控制、MCP Server 集成
- 提供 process transport（子进程 stdin/stdout）和 daemon HTTP 两种连接方式
- 允许上层应用（IDE 插件、CI/CD 流水线、Web 服务）集成 Qwen Code 能力

**SDK 成熟度：**

| SDK | 包名 | 版本 | 状态 |
|-----|------|------|------|
| TypeScript | `@qwen-code/sdk` | 0.1.7 | 功能最全，支持 Daemon Client |
| Python | `qwen-code-sdk` | 0.1.0 | 核心流程对齐 TS SDK |
| Java (qwencode) | `com.alibaba:qwencode-sdk` | 0.0.3-alpha | stream-json 协议 |
| Java (acp-client) | `com.alibaba:acp-sdk` | 0.0.1-alpha | ACP JSON-RPC 协议 |

## 2. TypeScript SDK

### 2.1 核心接口

```typescript
// 入口函数
export function query(config: { prompt: string | AsyncIterable<SDKUserMessage>; options: QueryOptions }): Query;

// Query 实例方法
interface Query extends AsyncIterable<SDKMessage> {
  getSessionId(): string;
  isClosed(): boolean;
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  close(): Promise<void>;
}

// Daemon 模式
export class DaemonClient { /* HTTP client for `qwen serve` */ }
export class DaemonSessionClient { /* 绑定单个 daemon session */ }
```

**消息类型体系：**

- `SDKUserMessage` - 用户输入消息
- `SDKAssistantMessage` - AI 完整回复
- `SDKPartialAssistantMessage` - 流式部分回复
- `SDKSystemMessage` - 系统消息
- `SDKResultMessage` - 最终结果

**MCP 集成：**

- `tool()` - 定义自定义工具（Zod schema 类型推导）
- `createSdkMcpServer()` - 创建进程内嵌 MCP Server
- 支持外部 MCP Server（stdio/SSE/HTTP transport）

### 2.2 连接方式

**Process Transport（默认）：**

通过子进程 spawn `qwen` CLI，使用 `--input-format stream-json --output-format stream-json` 进行通信。从 v0.1.1 起 CLI 已内嵌打包，无需单独安装。

**Daemon HTTP Transport：**

通过 `DaemonClient` 连接运行中的 `qwen serve` 守护进程，走 HTTP + SSE 协议。支持跨客户端 attach、共享 MCP 池、网络可达。

```typescript
// Process 模式
const result = query({ prompt: 'Hello', options: { cwd: '/project' } });

// Daemon 模式
const daemon = new DaemonClient({ baseUrl: 'http://127.0.0.1:4170', token: '...' });
const session = await DaemonSessionClient.createOrAttach(daemon, { workspaceCwd: '/project' });
await session.prompt({ prompt: [{ type: 'text', text: 'Hello' }] });
```

### 2.3 使用示例

```typescript
import { query, isSDKAssistantMessage, isSDKResultMessage } from '@qwen-code/sdk';

const result = query({
  prompt: 'List files in current directory',
  options: {
    cwd: '/path/to/project',
    model: 'qwen-plus',
    permissionMode: 'auto-edit',
    allowedTools: ['Read', 'Bash(git *)'],
  },
});

for await (const message of result) {
  if (isSDKAssistantMessage(message)) {
    console.log(message.message.content);
  } else if (isSDKResultMessage(message)) {
    console.log('Done:', message.result);
  }
}
```

## 3. Python SDK

### 3.1 核心接口

```python
# 异步接口
async def query(prompt, options=None) -> Query

# 同步接口
def query_sync(prompt, options=None) -> SyncQuery

# Query 实例方法
class Query:
    async def close() -> None
    async def interrupt() -> None
    async def set_model(model: str) -> None
    async def set_permission_mode(mode: str) -> None
    async def supported_commands() -> list
    async def mcp_server_status() -> dict
    def get_session_id() -> str | None
```

**消息类型（TypedDict）：**

- `SDKUserMessage`, `SDKAssistantMessage`, `SDKSystemMessage`
- `SDKResultMessage`, `SDKPartialAssistantMessage`
- 配套 type guard: `is_sdk_assistant_message()`, `is_sdk_result_message()` 等

**错误类型：**

- `ValidationError` - 参数校验失败
- `ControlRequestTimeoutError` - 控制操作超时
- `ProcessExitError` - CLI 进程非零退出
- `AbortError` - 请求被取消

### 3.2 连接方式

仅支持 Process Transport。通过 `asyncio.create_subprocess_exec` 启动 `qwen` CLI 子进程，使用 `stream-json` 协议通信。

```python
# 可执行文件路径自动检测，也可显式指定
options = {
    "path_to_qwen_executable": "qwen",  # 或绝对路径
    "cwd": "/path/to/project",
}
```

### 3.3 使用示例

```python
import asyncio
from qwen_code_sdk import query, is_sdk_result_message

async def main():
    async with query("Summarize this project.", {
        "cwd": "/path/to/project",
        "model": "qwen-plus",
        "permission_mode": "plan",
    }) as result:
        async for message in result:
            if is_sdk_result_message(message):
                print(message.get("result", ""))

asyncio.run(main())
```

同步版本：

```python
from qwen_code_sdk import query_sync, is_sdk_result_message

with query_sync("Say hello", {"path_to_qwen_executable": "qwen"}) as result:
    for message in result:
        if is_sdk_result_message(message):
            print(message.get("result", ""))
```

## 4. Java SDK

Java SDK 存在两个并行模块：

### 4.1 qwencode-sdk（stream-json 协议）

面向 Qwen Code CLI 的 `stream-json` 协议，API 风格更简洁。

**核心接口：**

```java
// 简单查询（静态方法）
List<String> QwenCodeCli.simpleQuery(String prompt);
List<String> QwenCodeCli.simpleQuery(String prompt, TransportOptions options);

// 带流式回调
QwenCodeCli.simpleQuery(prompt, options, new AssistantContentSimpleConsumers() {
    void onText(Session session, TextAssistantContent content);
    void onThinking(Session session, ThinkingAssistantContent content);
    void onToolUse(Session session, ToolUseAssistantContent content);
    void onToolResult(Session session, ToolResultAssistantContent content);
});

// Session 管理
Session session = QwenCodeCli.newSession(options);
session.interrupt();
session.setModel("qwen-plus");
session.setPermissionMode(PermissionMode.AUTO_EDIT);
session.close();
```

**TransportOptions 配置：**

- `model`, `cwd`, `permissionMode`, `env`
- `allowedTools`, `excludeTools`, `coreTools`
- `turnTimeout`, `messageTimeout`
- `includePartialMessages`, `resumeSessionId`

### 4.2 acp-sdk（ACP JSON-RPC 协议）

面向 Agent Client Protocol (ACP) 的 JSON-RPC 协议，功能更底层。

**核心接口：**

```java
// 创建客户端
AcpClient client = new AcpClient(
    new ProcessTransport(new ProcessTransportOptions()
        .setCommandArgs(new String[]{"qwen", "--acp", "-y"})));

// Session 管理
Session session = client.newSession();
Session session = client.loadSession(loadParams);

// 发送 Prompt（事件驱动回调）
client.sendPrompt(contentBlocks, new AgentEventConsumer()
    .setContentEventConsumer(...)
    .setTerminalEventConsumer(...)
    .setPermissionEventConsumer(...)
    .setFileEventConsumer(...));

client.close();
```

### 4.3 连接方式

两个模块均使用 Process Transport，通过 `ProcessBuilder` 启动 CLI 子进程。通信协议不同：

- `qwencode-sdk`: `--input-format stream-json --output-format stream-json`
- `acp-sdk`: `--acp` 标志启用 ACP JSON-RPC over stdio

### 4.4 使用示例

```java
// qwencode-sdk 简单查询
TransportOptions options = new TransportOptions()
    .setModel("qwen3-coder-flash")
    .setPermissionMode(PermissionMode.AUTO_EDIT)
    .setCwd("./");

List<String> result = QwenCodeCli.simpleQuery("List project files", options);
result.forEach(System.out::println);
```

## 5. SDK 与 ACP Bridge 的关系

SDK 与 CLI 之间存在两套通信协议：

| 协议 | 使用者 | 传输格式 | 启动方式 |
|------|--------|----------|----------|
| stream-json | TS SDK, Python SDK, Java qwencode-sdk | NDJSON (每行一个 JSON) | `qwen --input-format stream-json` |
| ACP (Agent Client Protocol) | Java acp-sdk, Daemon Client | JSON-RPC 2.0 over stdio/HTTP | `qwen --acp` 或 `qwen serve` |

**stream-json 协议** 更轻量，消息类型包括 user/assistant/system/result/partial 五种，适合简单集成场景。

**ACP 协议** 更完整，支持 session/new、session/load、prompt 等 JSON-RPC method，支持文件系统操作回调、终端操作回调、权限回调等双向通信，适合需要深度集成的 IDE/平台场景。

TypeScript SDK 的 `DaemonClient` 是 ACP 协议的 HTTP 实现，连接 `qwen serve` 守护进程。

## 6. 认证与安全

### 认证方式

所有 SDK 支持两种认证类型：

- **`openai`（默认）：** 通过 `OPENAI_API_KEY` 环境变量传递 API Key，兼容 OpenAI 格式
- **`qwen-oauth`：** Qwen OAuth 设备流认证，凭据存储在 `~/.qwen/`，需要周期性刷新

```typescript
// TypeScript
query({ prompt: '...', options: { authType: 'openai', env: { OPENAI_API_KEY: '...' } } });

// Python
query("...", { "auth_type": "openai", "env": { "OPENAI_API_KEY": "..." } })
```

### 权限控制

SDK 提供四级权限模式（`default` / `plan` / `auto-edit` / `yolo`），优先级链为：

```
deny > ask > allow > 默认行为
```

- `excludeTools` - 完全禁止的工具（最高优先级）
- `allowedTools` - 自动批准的工具（跳过回调）
- `canUseTool` - 自定义权限回调函数
- `permissionMode` - 全局默认策略

### Daemon 认证

DaemonClient 使用 Bearer token 进行认证，通过 `QWEN_SERVER_TOKEN` 环境变量配置：

```typescript
new DaemonClient({ baseUrl: 'http://127.0.0.1:4170', token: process.env['QWEN_SERVER_TOKEN'] });
```

## 7. 与 Claude Code SDK 的对比

| 维度 | Qwen Code SDK | Claude Code SDK |
|------|---------------|-----------------|
| 入口函数 | `query()` | `query()` |
| 协议 | stream-json / ACP | stream-json |
| Transport | Process + Daemon HTTP | Process |
| 内嵌 MCP Server | 支持（TS SDK） | 支持 |
| 多语言 SDK | TypeScript + Python + Java | TypeScript 为主 |
| 权限模式 | default/plan/auto-edit/yolo | 类似 |
| Daemon 模式 | `qwen serve` + DaemonClient | 无 |
| CLI 内嵌 | v0.1.1 起内嵌 | 需独立安装 |
| ACP 协议 | 独有，支持 IDE/平台深度集成 | 无 |
| Session 恢复 | resume / continue_session | resume / continue |
| 包体积 | 内嵌 CLI bundle | 依赖外部 CLI |

Qwen Code SDK 在架构上参考了 Claude Code SDK 的 stream-json 协议设计，但额外引入了 ACP (Agent Client Protocol) 协议栈，支持更丰富的双向通信（文件操作回调、终端回调、权限回调），以及 Daemon 模式的长连接管理。

## 8. 相关代码索引

| 模块 | 路径 |
|------|------|
| TypeScript SDK 入口 | `packages/sdk-typescript/src/index.ts` |
| TypeScript Query 实现 | `packages/sdk-typescript/src/query/Query.ts` |
| TypeScript Transport | `packages/sdk-typescript/src/transport/ProcessTransport.ts` |
| TypeScript Daemon Client | `packages/sdk-typescript/src/daemon/DaemonClient.ts` |
| TypeScript DaemonSessionClient | `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts` |
| TypeScript MCP 工具 | `packages/sdk-typescript/src/mcp/tool.ts` |
| TypeScript MCP Server 创建 | `packages/sdk-typescript/src/mcp/createSdkMcpServer.ts` |
| Python SDK 入口 | `packages/sdk-python/src/qwen_code_sdk/__init__.py` |
| Python Query 实现 | `packages/sdk-python/src/qwen_code_sdk/query.py` |
| Python Transport | `packages/sdk-python/src/qwen_code_sdk/transport.py` |
| Python 类型定义 | `packages/sdk-python/src/qwen_code_sdk/types.py` |
| Java qwencode-sdk 入口 | `packages/sdk-java/qwencode/src/main/java/com/alibaba/qwen/code/cli/QwenCodeCli.java` |
| Java qwencode Session | `packages/sdk-java/qwencode/src/main/java/com/alibaba/qwen/code/cli/session/Session.java` |
| Java acp-sdk Client | `packages/sdk-java/client/src/main/java/com/alibaba/acp/sdk/AcpClient.java` |
| Java acp-sdk Transport | `packages/sdk-java/client/src/main/java/com/alibaba/acp/sdk/transport/Transport.java` |
| Java acp-sdk Session | `packages/sdk-java/client/src/main/java/com/alibaba/acp/sdk/session/Session.java` |
