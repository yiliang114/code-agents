# Qwen Code MCP 集成

> 分析版本：v0.16.0 | 分析日期：2026-05-22

## 1. 概述

MCP (Model Context Protocol) 是 Qwen Code 中用于扩展 AI 能力的核心协议层。通过 MCP，用户可以将外部工具服务（如数据库、浏览器自动化、代码平台等）以标准化方式接入 Qwen Code，使 LLM 能动态发现并调用这些工具。

MCP 在 Qwen Code 中的角色：

- **工具扩展**：允许第三方服务通过标准协议暴露工具给 LLM 调用
- **Prompt 扩展**：MCP Server 可同时暴露 prompt 模板供用户使用
- **资源读取**：支持通过 MCP 协议读取远程资源（resources/read）
- **动态发现**：启动时自动连接配置的 MCP Server 并发现可用工具

核心代码位于 `packages/core/src/tools/mcp-client.ts` 和 `packages/core/src/tools/mcp-tool.ts`。

## 2. MCP Server 配置

### 2.1 MCPServerConfig Schema

MCP Server 配置定义在 `packages/core/src/config/config.ts` 中：

```typescript
export class MCPServerConfig {
  constructor(
    // stdio 传输
    readonly command?: string,
    readonly args?: string[],
    readonly env?: Record<string, string>,
    readonly cwd?: string,
    // SSE 传输
    readonly url?: string,
    // Streamable HTTP 传输
    readonly httpUrl?: string,
    readonly headers?: Record<string, string>,
    // WebSocket 传输（预留）
    readonly tcp?: string,
    // 通用配置
    readonly timeout?: number,
    readonly trust?: boolean,
    readonly description?: string,
    readonly includeTools?: string[],
    readonly excludeTools?: string[],
    readonly extensionName?: string,
    // OAuth 配置
    readonly oauth?: MCPOAuthConfig,
    readonly authProviderType?: AuthProviderType,
    // Service Account 配置
    readonly targetAudience?: string,
    readonly targetServiceAccount?: string,
    // SDK 内嵌类型
    readonly type?: 'sdk',
    readonly discoveryTimeoutMs?: number,
  ) {}
}
```

### 2.2 三种传输方式

| 传输方式 | 配置字段 | 适用场景 |
|---------|---------|---------|
| **stdio** | `command`, `args`, `env`, `cwd` | 本地进程，最常用 |
| **SSE** | `url` | 远程 Server-Sent Events |
| **Streamable HTTP** | `httpUrl`, `headers` | 远程 HTTP 流式传输（推荐） |

配置示例（settings.json）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": { "NODE_ENV": "production" }
    },
    "remote-api": {
      "httpUrl": "https://mcp.example.com/api",
      "headers": { "X-API-Key": "..." },
      "timeout": 30000
    },
    "legacy-sse": {
      "url": "https://mcp.example.com/sse",
      "trust": true
    }
  }
}
```

### 2.3 环境变量注入

stdio 传输会将 `process.env` 与配置的 `env` 合并注入子进程。在 Windows 上会自动执行 PATH 环境变量归一化（合并 `PATH` + `Path` 为单一 `PATH`）。

```typescript
const env = {
  ...normalizePathEnvForWindows({ ...process.env }),
  ...(mcpServerConfig.env || {}),
};
```

### 2.4 工具过滤

每个 Server 支持 `includeTools` 和 `excludeTools` 过滤：

- `excludeTools` 优先级高于 `includeTools`
- `includeTools` 支持函数名前缀匹配（如 `"tool_name("` 匹配带参数的工具声明）

## 3. MCP 工具动态加载

### 3.1 发现流程

```
Config.initialize()
  → McpClientManager.discoverAllMcpTools()
    → 对每个 mcpServer 并行:
      → connectToMcpServer() // 建立 transport 连接
      → discoverTools()      // 获取工具列表
      → discoverPrompts()    // 获取 prompt 列表
      → toolRegistry.registerTool(DiscoveredMCPTool)
```

核心函数 `discoverTools` 的工作流程：

1. 通过 `@google/genai` 的 `mcpToTool()` 获取 `CallableTool` 包装
2. 读取 `functionDeclarations` 提取工具 schema
3. 额外调用 `mcpClient.listTools()` 获取 annotations（readOnlyHint 等）
4. 根据 `includeTools/excludeTools` 过滤
5. 创建 `DiscoveredMCPTool` 实例并注册

### 3.2 工具命名规则

MCP 工具在 LLM 端的名称格式为 `mcp__<serverName>__<toolName>`，经过字符清理：

```typescript
function generateValidName(name: string) {
  let validToolname = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
  if (validToolname.length > 63) {
    validToolname = validToolname.slice(0, 28) + '___' + validToolname.slice(-32);
  }
  return validToolname;
}
```

### 3.3 DiscoveredMCPTool 类

每个发现的 MCP 工具被封装为 `DiscoveredMCPTool`，继承自 `BaseDeclarativeTool`。关键特性：

- `shouldDefer = true`：工具通过 ToolSearch 延迟加载，避免初始 tool-declaration 过大
- `canUpdateOutput = true`：支持流式进度更新（progress notifications）
- `searchHint = "mcp ${serverName}"`：辅助模糊匹配

### 3.4 执行路径

工具执行有两条路径：

1. **Direct Client 路径**（优先）：使用原始 MCP SDK Client，支持 `onprogress` 回调实现实时进度通知
2. **CallableTool 路径**（回退）：通过 `@google/genai` 的 mcpToTool 包装调用，不支持进度通知

### 3.5 断线重连

当 MCP tool 执行失败时，`DiscoveredMCPToolInvocation` 内置最多 3 次重连尝试：

```typescript
private static readonly MAX_RECONNECT_RETRIES = 3;
```

重连过程：通过 `toolRegistry.discoverToolsForServer()` 重新发现该 Server 的工具，然后用新的 client 实例重试调用。

## 4. MCP Auth 层

### 4.1 Auth Provider 类型

```typescript
export enum AuthProviderType {
  DYNAMIC_DISCOVERY = 'dynamic_discovery',
  GOOGLE_CREDENTIALS = 'google_credentials',
  SERVICE_ACCOUNT_IMPERSONATION = 'service_account_impersonation',
}
```

### 4.2 OAuth Provider

文件：`packages/core/src/mcp/oauth-provider.ts`

`MCPOAuthProvider` 实现完整的 OAuth 2.0 Authorization Code + PKCE 流程：

1. **OAuth Discovery**：从 MCP Server URL 自动发现 OAuth 配置（RFC 9728 Protected Resource Metadata + RFC 8414 Authorization Server Metadata）
2. **Dynamic Client Registration**：无 client_id 时自动注册客户端（client_name: `"Qwen Code MCP Client"`）
3. **PKCE Flow**：生成 code_verifier/code_challenge，启动本地 HTTP Server（端口 7777）接收回调
4. **Token Refresh**：支持 refresh_token 自动续期
5. **Browser Launch**：安全打开浏览器完成授权

OAuth 配置接口：

```typescript
export interface MCPOAuthConfig {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  audiences?: string[];
  redirectUri?: string;
  tokenParamName?: string;
  registrationUrl?: string;
}
```

### 4.3 Google Auth Provider

文件：`packages/core/src/mcp/google-auth-provider.ts`

基于 Google Application Default Credentials (ADC) 的认证提供者，实现 `OAuthClientProvider` 接口。仅允许连接以下域名：

- `*.googleapis.com`
- `*.luci.app`

使用 `google-auth-library` 的 `GoogleAuth` 获取 access token，无需用户交互。

### 4.4 SA Impersonation Provider

文件：`packages/core/src/mcp/sa-impersonation-provider.ts`

Service Account 模拟认证，通过 IAM Credentials API 为目标 Service Account 生成 ID Token：

```
POST https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{SA}:generateIdToken
```

需要配置：
- `targetServiceAccount`：目标 SA 邮箱
- `targetAudience`：OAuth Client ID（格式：`CLIENT_ID.apps.googleusercontent.com`）

Token 带有 5 分钟缓冲的缓存机制，解析 JWT `exp` 字段判断过期。

### 4.5 Token Storage

Token 存储采用分层架构：

```
MCPOAuthTokenStorage (入口)
  └─ HybridTokenStorage
       ├─ KeychainTokenStorage (优先 - 系统 keychain)
       └─ FileTokenStorage (回退 - 加密文件)
```

- **Service Name**：`qwen-code-oauth`
- **强制文件存储**：设置 `QWEN_CODE_FORCE_ENCRYPTED_FILE_STORAGE=true`
- **存储结构**：

```typescript
interface OAuthCredentials {
  serverName: string;
  token: OAuthToken;
  clientId?: string;
  tokenUrl?: string;
  mcpServerUrl?: string;
  updatedAt: number;
}
```

## 5. Chrome MCP Integration

> 注：`packages/mcp-chrome-integration/` 目录在当前代码库中不存在。Chrome 浏览器集成可能通过外部 MCP Server 实现（如 puppeteer MCP Server），并非内嵌在 Qwen Code 包中。

SDK TypeScript 包（`packages/sdk-typescript/src/mcp/`）提供了面向 SDK 嵌入式 MCP Server 的工具：

- `SdkControlServerTransport`：SDK 内进程通信 transport
- `createSdkMcpServer`：创建内嵌 MCP Server 实例
- `tool.ts`：SDK 工具定义辅助函数（基于 Zod schema）

SDK 内嵌 Server 通过 `type: 'sdk'` 配置标识，使用 `SdkControlClientTransport` 进行 JSON-RPC 消息路由，无需子进程。

## 6. MCP Prompts

### 6.1 Prompt Registry

文件：`packages/core/src/prompts/prompt-registry.ts`

`PromptRegistry` 管理从 MCP Server 发现的 prompt：

```typescript
class PromptRegistry {
  registerPrompt(prompt: DiscoveredMCPPrompt): void;
  getAllPrompts(): DiscoveredMCPPrompt[];
  getPrompt(name: string): DiscoveredMCPPrompt | undefined;
  getPromptsByServer(serverName: string): DiscoveredMCPPrompt[];
  removePromptsByServer(serverName: string): void;
}
```

### 6.2 Prompt 发现与调用

发现过程：检查 Server 的 `prompts` capability，调用 `prompts/list` 获取可用 prompt 列表。

调用过程：通过 `prompts/get` 请求获取 prompt 内容，传入参数实例化模板。

```typescript
export type DiscoveredMCPPrompt = Prompt & {
  serverName: string;
  invoke: (params: Record<string, unknown>) => Promise<GetPromptResult>;
};
```

重名处理：如果 prompt 名称冲突，自动重命名为 `${serverName}_${promptName}`。

## 7. 安全与权限

### 7.1 Permission 分类

MCP 工具的权限规则格式为 `mcp__<serverName>__<toolName>`，支持三级决策：

| 条件 | 权限决策 |
|------|---------|
| `trust: true` 且 workspace 为信任目录 | `allow`（自动执行） |
| 工具标注 `readOnlyHint: true` | `allow`（自动执行） |
| 其他所有 MCP 工具 | `ask`（需用户确认） |

### 7.2 Tool Annotations

MCP 工具的 Annotations 影响权限和分类：

```typescript
interface McpToolAnnotations {
  readOnlyHint?: boolean;     // 只读工具，自动放行
  destructiveHint?: boolean;  // 破坏性操作提示
  idempotentHint?: boolean;   // 幂等性提示
  openWorldHint?: boolean;    // 开放世界访问提示
}
```

`readOnlyHint: true` 的工具被归类为 `Kind.Read`，其余为 `Kind.Other`。

### 7.3 沙箱限制

MCP Server 运行在独立子进程中（stdio 模式）。安全措施包括：

- 环境变量隔离：仅注入显式配置的 `env`
- 工作目录校验：`cwd` 必须存在，否则拒绝启动
- OAuth token 不记录到日志（仅输出 SHA-256 fingerprint 前 8 位）
- 输出截断：`truncateToolOutput` 防止超长响应影响 context

### 7.4 Budget 限制（守护模式）

`McpClientManager` 支持 MCP client 数量预算机制：

- `QWEN_SERVE_MCP_CLIENT_BUDGET`：最大并发 client 数
- `QWEN_SERVE_MCP_BUDGET_MODE`：`enforce`（硬限）/ `warn`（告警）/ `off`（关闭）
- 采用双阈值滞回：75% 触发警告，37.5% 解除

## 8. 与 Claude Code MCP 的对比

| 维度 | Qwen Code | Claude Code |
|------|-----------|-------------|
| 传输协议 | stdio / SSE / Streamable HTTP / SDK内嵌 | stdio / SSE |
| 工具发现 | 启动时并行发现 + ToolSearch 延迟加载 | 启动时全量加载 |
| Auth | OAuth 2.0 PKCE + Google ADC + SA Impersonation | OAuth 2.0 PKCE |
| 权限模型 | trust / readOnlyHint / ask 三级 | allow / deny 规则 |
| 进度通知 | 支持 onprogress 实时流式进度 | 不支持 |
| 断线重连 | 内置 3 次自动重连 | 手动重连 |
| Client 预算 | 支持 enforce/warn 模式限制并发数 | 无此机制 |
| Prompt 支持 | 完整的 prompts/list + prompts/get | 不支持 MCP prompts |
| Token 存储 | Keychain + 加密文件 Hybrid 方案 | Keychain 优先 |
| 工具命名 | `mcp__server__tool`（最长 63 字符） | `mcp__server__tool` |

## 9. 相关代码索引

| 文件 | 说明 |
|------|------|
| `packages/core/src/tools/mcp-client.ts` | MCP Client 核心：连接、发现、传输创建 |
| `packages/core/src/tools/mcp-tool.ts` | MCP Tool 抽象：执行、重连、输出转换 |
| `packages/core/src/tools/mcp-client-manager.ts` | Client 生命周期管理、健康监控、Budget 守卫 |
| `packages/core/src/mcp/oauth-provider.ts` | OAuth 2.0 + PKCE 完整流程 |
| `packages/core/src/mcp/google-auth-provider.ts` | Google ADC 认证 |
| `packages/core/src/mcp/sa-impersonation-provider.ts` | Service Account ID Token 生成 |
| `packages/core/src/mcp/oauth-token-storage.ts` | Token 持久化入口 |
| `packages/core/src/mcp/oauth-utils.ts` | OAuth Discovery 工具（RFC 8414/9728） |
| `packages/core/src/mcp/token-storage/` | 分层 Token 存储（Keychain / 加密文件） |
| `packages/core/src/mcp/constants.ts` | 常量定义（client name、端口等） |
| `packages/core/src/config/config.ts` | `MCPServerConfig` 类定义 |
| `packages/core/src/prompts/prompt-registry.ts` | Prompt 注册中心 |
| `packages/core/src/prompts/mcp-prompts.ts` | Prompt 查询辅助函数 |
| `packages/core/src/permissions/types.ts` | 权限规则类型（含 MCP 格式说明） |
| `packages/cli/src/commands/mcp.ts` | CLI `/mcp` 子命令入口 |
| `packages/cli/src/commands/mcp/add.ts` | `qwen mcp add` 命令 |
| `packages/cli/src/commands/mcp/remove.ts` | `qwen mcp remove` 命令 |
| `packages/cli/src/commands/mcp/list.ts` | `qwen mcp list` 命令 |
| `packages/cli/src/commands/mcp/reconnect.ts` | `qwen mcp reconnect` 命令 |
| `packages/cli/src/ui/components/mcp/` | MCP 管理 UI 组件（Health Pill 等） |
| `packages/sdk-typescript/src/mcp/` | SDK 内嵌 MCP Server 支持 |
