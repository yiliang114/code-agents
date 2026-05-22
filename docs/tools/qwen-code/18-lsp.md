# Qwen Code LSP 集成

> 分析版本：v0.16.0 | 分析日期：2026-05-22

## 1. 概述

Code Agent 需要 LSP（Language Server Protocol）集成的核心原因：

- **精确代码导航**：通过 Go to Definition / Find References 实现比 grep 更精确的符号跳转
- **语义理解**：获取类型信息、函数签名、文档注释（hover），而非纯文本匹配
- **诊断能力**：实时获取编译错误和 lint 警告，辅助 Agent 进行代码修复
- **调用链分析**：通过 Call Hierarchy 分析函数调用关系，理解代码影响范围
- **多语言统一接口**：一套 LSP 接口支持 TypeScript、Python、Java、Go 等任意语言

Qwen Code 实现了完整的 Native LSP Client，可以在 CLI 模式下独立管理语言服务器进程，不依赖 IDE。

## 2. LSP 架构

```
┌─────────────────────────────────────────────────────────┐
│                     LspTool (Agent 调用入口)              │
│  packages/core/src/tools/lsp.ts                         │
└──────────────────────────┬──────────────────────────────┘
                           │ LspClient interface
┌──────────────────────────▼──────────────────────────────┐
│                   NativeLspClient (Adapter)               │
│  packages/core/src/lsp/NativeLspClient.ts                │
└──────────────────────────┬──────────────────────────────┘
                           │ delegates to
┌──────────────────────────▼──────────────────────────────┐
│                   NativeLspService                        │
│  packages/core/src/lsp/NativeLspService.ts               │
│  - discoverAndPrepare(): 配置发现与合并                    │
│  - start() / stop(): 服务器生命周期                       │
│  - definitions/references/hover/...: 请求分发              │
└───────┬──────────────────┬──────────────────┬───────────┘
        │                  │                  │
┌───────▼───────┐  ┌───────▼───────┐  ┌──────▼──────────┐
│LspServerManager│  │LspConfigLoader │  │LspResponse      │
│ 进程生命周期    │  │ 配置加载与合并  │  │Normalizer       │
│ 启动/停止/重启  │  │ .lsp.json      │  │ 响应标准化       │
└───────┬────────┘  │ extension cfg  │  └─────────────────┘
        │           └────────────────┘
┌───────▼────────────────────────────┐
│       LspConnectionFactory          │
│  - stdio (spawn 子进程)             │
│  - tcp (TCP socket)                 │
│  - socket (Unix socket)             │
│  JSON-RPC 通信层                    │
└─────────────────────────────────────┘
```

### 2.1 LspServerManager（服务器生命周期管理）

**文件**：`packages/core/src/lsp/LspServerManager.ts`

核心职责：
- 管理多个 LSP 服务器实例的 Map（`serverHandles: Map<string, LspServerHandle>`）
- `startAll()` / `stopAll()`：批量启停所有配置的服务器
- **Workspace Trust 校验**：未信任的工作区拒绝启动 LSP 服务器
- **命令存在性检查**：通过 spawn `--version` 验证服务器命令是否可用
- **路径安全检查**：阻止相对路径逃逸工作区（如 `../../malicious`）
- **崩溃自动重启**：配置 `restartOnCrash: true` 后，进程退出时自动重启（最多 `maxRestarts` 次，默认 3 次）
- **TypeScript 服务器预热**：自动找到一个 `.ts/.tsx` 文件发送 `textDocument/didOpen`，触发 tsserver 项目加载
- **启动锁**：通过 `startingPromise` 防止并发启动同一服务器

### 2.2 LspConfigLoader（配置加载）

**文件**：`packages/core/src/lsp/LspConfigLoader.ts`

配置来源与优先级（高优先级覆盖低优先级）：
1. **Extension 配置**：通过 `extension.config.lspServers` 声明
2. **用户配置**：工作区根目录下的 `.lsp.json` 文件

关键方法：
- `loadUserConfigs()`：解析 `.lsp.json`
- `loadExtensionConfigs(extensions)`：从已激活的 extension 中提取 LSP 配置
- `mergeConfigs()`：合并配置，用户配置覆盖同名 extension 配置
- `collectExtensionToLanguageOverrides()`：收集文件扩展名到语言 ID 的映射

注意：内置预设（built-in presets）已禁用，LSP 服务器必须通过 `.lsp.json` 或 extension 显式配置。

### 2.3 LspConnectionFactory（连接工厂）

**文件**：`packages/core/src/lsp/LspConnectionFactory.ts`

支持三种 transport：
- **stdio**：spawn 子进程，通过 stdin/stdout 通信（最常用）
- **tcp**：通过 TCP socket 连接远程/本地服务器
- **socket**：通过 Unix socket 文件连接

内部实现了完整的 **JSON-RPC 2.0** 协议：
- `Content-Length` header 解析
- 请求/响应 ID 匹配（pendingRequests Map）
- 15 秒请求超时（`DEFAULT_LSP_REQUEST_TIMEOUT_MS`）
- stderr 输出捕获（保留最后 8KB 用于错误诊断）

## 3. 支持的 LSP 能力

| 操作 | LSP Method | 用途 |
|------|-----------|------|
| goToDefinition | `textDocument/definition` | 跳转到符号定义 |
| findReferences | `textDocument/references` | 查找所有引用 |
| hover | `textDocument/hover` | 获取类型/文档信息 |
| documentSymbol | `textDocument/documentSymbol` | 文件内所有符号 |
| workspaceSymbol | `workspace/symbol` | 工作区符号搜索 |
| goToImplementation | `textDocument/implementation` | 接口/抽象方法实现 |
| prepareCallHierarchy | `textDocument/prepareCallHierarchy` | 准备调用层次项 |
| incomingCalls | `callHierarchy/incomingCalls` | 谁调用了此函数 |
| outgoingCalls | `callHierarchy/outgoingCalls` | 此函数调用了谁 |
| diagnostics | `textDocument/diagnostic` | 单文件诊断 |
| workspaceDiagnostics | `workspace/diagnostic` | 全工作区诊断 |
| codeActions | `textDocument/codeAction` | 快速修复/重构建议 |

此外还发送以下通知：
- `textDocument/didOpen`：打开文件时通知服务器
- `initialized`：初始化完成通知
- `workspace/didChangeWorkspaceFolders`：工作区目录变更
- `workspace/didChangeConfiguration`：设置变更

## 4. NativeLspClient / NativeLspService

### NativeLspService

**文件**：`packages/core/src/lsp/NativeLspService.ts`

完整的 LSP 服务实现，核心特性：

- **文档管理**：`openedDocuments` Map 追踪每个服务器打开的文档，避免重复 `didOpen`
- **延迟重试机制**：对慢速服务器（如 jdtls、clangd），首次请求返回空结果时延迟 2 秒后重试
- **workspace symbol 预热**：首次搜索前自动打开一个文件触发服务器索引构建
- **TypeScript "No Project" 错误处理**：检测到 tsserver 返回 "No Project" 时强制重新预热
- **applyWorkspaceEdit**：本地文件系统编辑（按逆序应用 TextEdit 数组）

### NativeLspClient

**文件**：`packages/core/src/lsp/NativeLspClient.ts`

纯粹的 Adapter 模式，将 `LspClient` 接口的每个方法委托给 `NativeLspService`。额外提供：
- `getServerStatus()`：返回所有服务器的状态快照
- `getStatusSnapshot()`：详细状态（含 PID、stderr、重启次数等）

## 5. LspResponseNormalizer（响应标准化）

**文件**：`packages/core/src/lsp/LspResponseNormalizer.ts`

不同 LSP 服务器的响应格式差异很大，Normalizer 统一处理：

- **Location 标准化**：处理 `uri` / `targetUri` / `target.uri` 等变体
- **Symbol Kind**：数字 SymbolKind 转为可读字符串（如 `5` -> `"Class"`）
- **Hover Contents**：统一 `string` / `MarkedString` / `MarkupContent` / `Array` 格式
- **DocumentSymbol 树展平**：递归收集嵌套的 DocumentSymbol children
- **Call Hierarchy**：保留 `rawKind` 数字用于后续服务器通信
- **Diagnostic Severity**：数字转字符串（`1` -> `"error"`）
- **CodeAction**：处理 Command vs CodeAction 两种返回格式
- **WorkspaceEdit**：标准化 `changes` 和 `documentChanges` 两种编辑格式

## 6. LSP Tool（Agent 可调用的 LSP 工具）

**文件**：`packages/core/src/tools/lsp.ts`

以统一 Tool 形式暴露给 Agent，支持 12 种操作。Tool 定义中明确标注：

> "ALWAYS use LSP as the PRIMARY tool for code intelligence queries when available. Do NOT use grep_search or glob first."

参数设计：
- `operation`（必填）：操作类型
- `filePath`：绝对或相对路径
- `line` / `character`：1-based 位置（内部转为 0-based）
- `query`：workspace symbol 搜索词
- `callHierarchyItem`：Call Hierarchy 的上下文 item（JSON）
- `limit`：结果数量限制
- `serverName`：指定查询特定服务器

Tool 特性：
- `shouldDefer: true`：按需加载（通过 ToolSearch 发现）
- 自动检查 LSP 是否启用/初始化
- 输出格式化为人类可读的 `file:line:col [server]` 形式
- workspaceSymbol 自动追加 top match 的引用列表

## 7. 配置格式

### .lsp.json（工作区根目录）

```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "transport": "stdio",
    "env": { "TSS_LOG": "-level verbose" },
    "initializationOptions": {},
    "settings": {},
    "extensionToLanguage": { ".tsx": "typescriptreact" },
    "workspaceFolder": ".",
    "startupTimeout": 15000,
    "shutdownTimeout": 5000,
    "restartOnCrash": true,
    "maxRestarts": 3,
    "trustRequired": true
  },
  "python": {
    "command": "pylsp",
    "args": [],
    "transport": "stdio"
  }
}
```

### Extension LSP 配置

Extension 在 `config.lspServers` 中声明：
- 字符串值：指向 JSON 文件路径
- 对象值：内联 LSP 配置

支持变量插值：`${extensionPath}`、`${workspacePath}`、`${pathSeparator}`

### 超时常量

| 常量 | 默认值 | 说明 |
|------|--------|------|
| `DEFAULT_LSP_STARTUP_TIMEOUT_MS` | 10000ms | 服务器启动超时 |
| `DEFAULT_LSP_REQUEST_TIMEOUT_MS` | 15000ms | 单次请求超时 |
| `DEFAULT_LSP_WARMUP_DELAY_MS` | 150ms | TypeScript 预热等待 |
| `DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS` | 200ms | didOpen 后等待索引 |
| `DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS` | 2000ms | 慢服务器重试延迟 |
| `DEFAULT_LSP_WORKSPACE_SYMBOL_WARMUP_DELAY_MS` | 1500ms | workspace symbol 预热 |
| `DEFAULT_LSP_COMMAND_CHECK_TIMEOUT_MS` | 2000ms | 命令存在性检查超时 |

## 8. 与 Claude Code LSP 的对比

| 维度 | Qwen Code | Claude Code |
|------|-----------|-------------|
| 运行模式 | Native CLI（自管理进程） | 依赖 IDE（VS Code）提供 LSP |
| 服务器管理 | 内建 LspServerManager | 委托给 VS Code Extension Host |
| 配置方式 | `.lsp.json` + Extension | IDE 内置 + 用户 settings |
| Transport | stdio / tcp / socket | 主要通过 IDE 内部 IPC |
| 预热策略 | 主动找文件 warmup tsserver | IDE 自动触发 |
| 重启机制 | `restartOnCrash` + 计数 | IDE 自行管理 |
| 信任模型 | workspace trust 校验 | IDE 级别 trust |
| 响应标准化 | LspResponseNormalizer | 无需（IDE 已标准化） |
| Tool 集成 | 统一 LspTool（12 种操作） | 类似统一工具 |
| Call Hierarchy | 完整支持 incoming/outgoing | 支持 |
| Code Actions | 支持（含 applyWorkspaceEdit） | 支持 |
| Diagnostics | Pull 模式（主动拉取） | Push 模式（IDE 推送） |

核心差异：Qwen Code 需要在无 IDE 的 CLI 环境中独立完成整个 LSP 通信链路，因此实现了完整的进程管理、JSON-RPC 协议栈和响应标准化层。

## 9. 相关代码索引

| 文件 | 职责 |
|------|------|
| `packages/core/src/lsp/types.ts` | 所有 LSP 类型定义（618 行） |
| `packages/core/src/lsp/constants.ts` | 超时常量、SymbolKind 映射表 |
| `packages/core/src/lsp/LspConfigLoader.ts` | 配置加载与合并 |
| `packages/core/src/lsp/LspConnectionFactory.ts` | JSON-RPC 连接工厂 |
| `packages/core/src/lsp/LspServerManager.ts` | 服务器生命周期管理 |
| `packages/core/src/lsp/LspResponseNormalizer.ts` | 响应格式标准化 |
| `packages/core/src/lsp/NativeLspService.ts` | 核心服务实现（1381 行） |
| `packages/core/src/lsp/NativeLspClient.ts` | LspClient Adapter |
| `packages/core/src/tools/lsp.ts` | Agent 调用的 LSP Tool（1228 行） |
| `packages/core/src/lsp/NativeLspService.test.ts` | 单元测试 |
| `packages/core/src/lsp/NativeLspService.integration.test.ts` | 集成测试 |
| `packages/core/src/lsp/__e2e__/lsp-e2e-test.ts` | 端到端测试 |
