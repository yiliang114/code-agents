# Qwen Code Hooks 系统

> 分析版本：v0.16.0 | 分析日期：2026-05-22

## 1. 概述

Qwen Code Hooks 系统是一个事件驱动的扩展机制，允许用户在 AI Agent 执行生命周期的关键节点插入自定义逻辑。系统支持四种 Hook Runner 类型（Command、HTTP、Function、Prompt），通过统一的执行管道处理事件匹配、并行/顺序执行和结果聚合。

核心架构组件：

| 组件 | 职责 |
|------|------|
| `HookSystem` | 顶层协调器，统一入口 |
| `HookRegistry` | 从配置源加载、验证、管理 Hook 定义 |
| `HookPlanner` | 事件触发时匹配 Hook、创建执行计划 |
| `HookRunner` | 路由到具体 Runner 执行 Hook |
| `HookAggregator` | 聚合多个 Hook 输出为最终结果 |
| `HookEventHandler` | 构造事件输入、编排整个执行流程 |
| `SessionHooksManager` | 管理运行时动态注册的 Session 级 Hook |

源码位置：`packages/core/src/hooks/`

## 2. Hook 事件类型

```typescript
export enum HookEventName {
  PreToolUse = 'PreToolUse',           // 工具执行前
  PostToolUse = 'PostToolUse',         // 工具执行成功后
  PostToolUseFailure = 'PostToolUseFailure', // 工具执行失败后
  Notification = 'Notification',       // 通知发送时
  UserPromptSubmit = 'UserPromptSubmit', // 用户提交 prompt 时
  SessionStart = 'SessionStart',       // 新 session 启动时
  Stop = 'Stop',                       // Agent 即将结束响应前
  SubagentStart = 'SubagentStart',     // 子 Agent（Task tool）启动时
  SubagentStop = 'SubagentStop',       // 子 Agent 完成响应前
  PreCompact = 'PreCompact',           // 会话压缩前
  PostCompact = 'PostCompact',         // 会话压缩后
  SessionEnd = 'SessionEnd',           // session 结束时
  PermissionRequest = 'PermissionRequest', // 权限弹窗显示时
  StopFailure = 'StopFailure',         // API 错误导致 turn 结束时（替代 Stop）
  TodoCreated = 'TodoCreated',         // Todo 项被创建时（Qwen Code 特有）
  TodoCompleted = 'TodoCompleted',     // Todo 项完成时（Qwen Code 特有）
}
```

各事件的 Matcher 目标字段：

| 事件 | Matcher 匹配对象 | 示例 |
|------|-----------------|------|
| PreToolUse / PostToolUse / PostToolUseFailure / PermissionRequest | `toolName` | `"Bash"`, `"Write\|Edit"` |
| SubagentStart / SubagentStop | `agentType` | `"Bash"`, `"Explorer"` |
| PreCompact / PostCompact | `trigger` | `"manual"`, `"auto"` |
| SessionStart / SessionEnd | `trigger`（source/reason） | `"startup"`, `"clear"` |
| StopFailure | `error` | `"rate_limit"` |
| Notification | `notificationType` | `"permission_prompt"` |
| UserPromptSubmit / Stop / TodoCreated / TodoCompleted | 无 matcher（始终触发） | — |

## 3. Hook 执行管道

执行流程：`HookEventHandler.executeHooks()` → `HookPlanner` → `HookRunner` → `HookAggregator`

### 3.1 HookPlanner：创建执行计划

```typescript
export interface HookExecutionPlan {
  eventName: HookEventName;
  hookConfigs: HookConfig[];
  sequential: boolean;  // 任一 Hook 定义 sequential=true 则全部顺序执行
}
```

Planner 职责：
1. 从 Registry 获取该事件的所有 Hook
2. 通过 Matcher 过滤匹配的 Hook（支持 regex、`*` 通配符、`|` 分隔）
3. 去重（基于 `getHookKey` 生成唯一 key）
4. 确定执行策略（parallel 或 sequential）

### 3.2 HookRunner：路由执行

根据 `hookConfig.type` 路由到对应 Runner：
- `command` → 本地 Shell 命令（或 async 后台执行）
- `http` → HTTP POST 请求
- `function` → 直接调用 TypeScript 回调
- `prompt` → 发送给 LLM 进行单轮评估

执行模式：
- **并行执行** `executeHooksParallel()`：所有 Hook 同时运行
- **顺序执行** `executeHooksSequential()`：逐个运行，前一个 Hook 的输出可修改后续输入

### 3.3 HookAggregator：结果聚合

聚合策略按事件类型区分：

| 事件 | 聚合策略 |
|------|----------|
| PreToolUse / PostToolUse / Stop / UserPromptSubmit / SubagentStop / TodoCreated / TodoCompleted | OR 逻辑：任一 `block`/`deny` 则阻断 |
| PermissionRequest | deny 优先，message 拼接，interrupt 取 true |
| StopFailure | Fire-and-forget，忽略所有输出和错误 |
| 其他 | 简单合并（后者覆盖前者，additionalContext 拼接） |

OR 逻辑规则：
- 任一 `decision === 'block' | 'deny'` → 最终 `block`
- `continue === false` 优先于 `true`
- `reason` 字段用 `\n` 拼接
- `additionalContext` 拼接

## 4. Hook Runner 类型

### 4.1 Shell Hook（Command Runner）

**配置接口：**
```typescript
interface CommandHookConfig {
  type: 'command';
  command: string;           // Shell 命令
  timeout?: number;          // 默认 60000ms
  env?: Record<string, string>;
  async?: boolean;           // 异步执行（非阻塞）
  shell?: 'bash' | 'powershell';
  statusMessage?: string;
}
```

**执行机制：**
- 通过 `stdin` 传入 JSON 格式的 `HookInput`
- 环境变量自动注入：`QWEN_PROJECT_DIR`、`CLAUDE_PROJECT_DIR`、`GEMINI_PROJECT_DIR`
- 命令中支持 `$CLAUDE_PROJECT_DIR` / `$GEMINI_PROJECT_DIR` 占位符替换

**Exit Code 语义：**
| Exit Code | 含义 |
|-----------|------|
| 0 | 成功，stdout 解析为 JSON 或纯文本 |
| 1 | 非阻断错误（Non-blocking），继续执行 |
| 2 | 阻断错误（Blocking），stderr 作为 deny reason |

**Async Hook：** 设置 `async: true` 后，Hook 在后台执行，立即返回 `{continue: true}`，通过 `AsyncHookRegistry` 跟踪状态。

### 4.2 HTTP Hook（httpHookRunner）

**配置接口：**
```typescript
interface HttpHookConfig {
  type: 'http';
  url: string;                       // 支持环境变量插值
  headers?: Record<string, string>;  // 支持环境变量插值
  allowedEnvVars?: string[];         // 允许插值的环境变量白名单
  timeout?: number;                  // 秒，默认 600s
  once?: boolean;                    // 每事件只执行一次
  if?: string;                       // 条件表达式
}
```

**执行流程：**
1. 环境变量插值（URL + Headers）
2. URL 白名单验证（`UrlValidator`）
3. DNS 解析 + SSRF 防护（`ssrfGuard`）
4. 发送 POST 请求（body = HookInput JSON）
5. 解析响应（JSON → HookOutput，纯文本 → systemMessage）

**错误处理策略：** Non-2xx 状态码、超时、连接失败均为非阻断错误（`success: true, continue: true`）。

**输出限制：** 响应体截断上限 10,000 字符。

### 4.3 Function Hook（functionHookRunner）

**配置接口：**
```typescript
interface FunctionHookConfig {
  type: 'function';
  callback: FunctionHookCallback;
  errorMessage: string;
  timeout?: number;      // 默认 5000ms
  id?: string;
  onHookSuccess?: (result: HookExecutionResult) => void;
}

type FunctionHookCallback = (
  input: HookInput,
  context?: FunctionHookContext,
) => Promise<HookOutput | boolean | undefined>;
```

**返回值语义：**
- `true` → 成功，继续
- `false` → 阻断，使用 `errorMessage` 作为原因
- `HookOutput` 对象 → 精细控制
- `undefined` → 等同于 `{continue: true}`

**执行特性：** 使用 `Promise.race` 实现超时和 AbortSignal 取消。

### 4.4 Prompt Hook（promptHookRunner）

**配置接口：**
```typescript
interface PromptHookConfig {
  type: 'prompt';
  prompt: string;       // 模板，$ARGUMENTS 替换为 HookInput JSON
  model?: string;       // 默认使用用户当前模型
  timeout?: number;     // 秒，默认 30s
}
```

**执行流程：**
1. 将 `$ARGUMENTS` 替换为 HookInput JSON
2. 调用 LLM（temperature=0，maxOutputTokens=500）
3. 解析响应为 `{ok: boolean, reason?: string, additionalContext?: string}`
4. `ok=true` → allow，`ok=false` → block

**容错策略：** JSON 解析失败或 LLM 调用失败均 fail-open（默认允许）。

## 5. 安全机制

### 5.1 SSRF Guard（ssrfGuard.ts）

阻止 HTTP Hook 访问内部网络地址：

| 地址范围 | 处理 |
|----------|------|
| `127.0.0.0/8`、`::1` | **允许**（本地开发 Hook 常用） |
| `10.0.0.0/8` | 阻断 |
| `172.16.0.0/12` | 阻断 |
| `192.168.0.0/16` | 阻断 |
| `169.254.0.0/16` | 阻断（云 metadata） |
| `100.64.0.0/10` | 阻断（CGNAT / 阿里云 metadata） |
| `fc00::/7`、`fe80::/10` | 阻断 |
| IPv4-mapped IPv6 | 提取内嵌 IPv4 后检查 |

实现方式：请求前进行 DNS 解析，验证所有解析 IP 不在阻断范围。

### 5.2 URL Validator（urlValidator.ts）

双层验证：
1. **黑名单检查**：阻断 `metadata.google.internal`、`169.254.169.254`、`metadata.azure.internal` 等
2. **白名单匹配**：URL 必须匹配 `settings.json` 中配置的 `allowedHttpHookUrls` 模式（支持 `*` 通配符）

### 5.3 Trusted Hooks（trustedHooks.ts）

项目级 Hook 信任管理：
- 存储路径：`~/.qwen/trusted_hooks.json`
- 基于 `{projectPath: [hookKey1, hookKey2]}` 结构
- 首次运行项目 Hook 时提示用户确认信任
- `getUntrustedHooks()` 返回未信任的 Hook 列表

### 5.4 Stop Hook Cap（stopHookCap.ts）

防止 Stop/SubagentStop Hook 无限循环延长 turn：

```typescript
const DEFAULT_STOP_HOOK_BLOCK_CAP = 8;   // 默认最多阻断 8 次
const MAX_STOP_HOOK_BLOCK_CAP = 100;     // 绝对上限
const STOP_HOOK_BLOCK_CAP_ENV = 'QWEN_CODE_STOP_HOOK_BLOCK_CAP'; // 环境变量覆盖
```

连续阻断次数达到 cap 后，强制结束 turn 并附加警告信息。

### 5.5 环境变量插值安全（envInterpolator.ts）

- 仅白名单内变量可被插值（`allowedEnvVars` 字段）
- 阻断 prototype pollution 向量（`__proto__`、`constructor` 等）
- Header 值净化：移除 `\r\n\x00` 防止 CRLF 注入

## 6. Session Hooks Manager

`SessionHooksManager` 管理运行时动态注册的 Session 级 Hook，主要用于 SDK 集成和 Skill 系统。

**存储结构：** `Map<sessionId, Map<HookEventName, SessionHookEntry[]>>`

**核心 API：**
```typescript
// 注册 Function Hook
addFunctionHook(sessionId, event, matcher, callback, errorMessage, options?): string

// 注册 Command/HTTP Hook
addSessionHook(sessionId, event, matcher, hook, options?): string

// 移除 Hook
removeFunctionHook(sessionId, event, hookId): boolean
removeHook(sessionId, hookId): boolean

// 查询
getHooksForEvent(sessionId, event): SessionHookEntry[]
getMatchingHooks(sessionId, event, target): SessionHookEntry[]
hasHooksForEvent(event, sessionId?): boolean
```

**Matcher 匹配优先级：**
1. `*` → 匹配所有
2. `|` 分隔的替代项（如 `Write|Edit|Read`）
3. Regex 语法（如 `^Bash.*`）
4. 精确匹配（fallback）

## 7. Skill Hooks（registerSkillHooks）

Skill 可在其 frontmatter 中声明 Hooks，Skill 被调用时自动注册为 Session Hook。

```typescript
function registerSkillHooks(
  sessionHooksManager: SessionHooksManager,
  sessionId: string,
  skill: SkillConfig,
): number  // 返回注册数量
```

**特性：**
- 仅支持 Command 和 HTTP 类型（不支持 Function）
- 自动注入 `QWEN_SKILL_ROOT` 环境变量指向 Skill 目录
- 随 Session 结束自动清理

## 8. 配置格式与示例

Hook 配置在 `settings.json` 中的结构：

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",           // 可选，不填匹配所有
        "sequential": false,          // 可选，是否顺序执行
        "hooks": [
          {
            "type": "command",
            "command": "python3 validate.py",
            "timeout": 10000,
            "name": "bash-validator"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "http",
            "url": "https://api.example.com/hooks/post-edit",
            "headers": { "Authorization": "Bearer $MY_TOKEN" },
            "allowedEnvVars": ["MY_TOKEN"],
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Check if the task is complete based on: $ARGUMENTS",
            "timeout": 20,
            "name": "completion-checker"
          }
        ]
      }
    ]
  }
}
```

**配置源优先级（数字越小优先级越高）：**
1. Project（`.qwen/settings.json`）
2. User（`~/.qwen/settings.json`）
3. System
4. Extensions

**Hook 输入/输出基础类型：**
```typescript
interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  timestamp: string;
}

interface HookOutput {
  continue?: boolean;         // false 则停止执行
  stopReason?: string;        // continue=false 时的原因
  suppressOutput?: boolean;   // 是否抑制输出
  systemMessage?: string;     // 系统消息
  decision?: 'ask' | 'block' | 'deny' | 'approve' | 'allow';
  reason?: string;
  hookSpecificOutput?: Record<string, unknown>;
}
```

## 9. 与 Claude Code Hooks 的对比

| 特性 | Claude Code | Qwen Code |
|------|-------------|-----------|
| Hook 类型 | Command | Command + HTTP + Function + Prompt |
| Matcher 语法 | 字符串精确匹配 | Regex + `\|` 分隔 + `*` 通配符 |
| 异步 Hook | 不支持 | 支持（`async: true`） |
| Prompt Hook（LLM 评估） | 不支持 | 支持（单轮 LLM 调用判定） |
| Session Hook（运行时注册） | 不支持 | 支持（SDK/Skill 动态注册） |
| SSRF 防护 | ssrfGuard | ssrfGuard（对齐 Claude Code）+ UrlValidator 双层 |
| Stop Hook Cap | 有 | 有（默认 8 次，最大 100） |
| Todo 事件 | 不支持 | TodoCreated / TodoCompleted（两阶段：validation + postWrite） |
| Subagent 事件 | SubagentStop | SubagentStart + SubagentStop |
| PermissionRequest 事件 | 有 | 有（支持 updatedInput、updatedPermissions） |
| 环境变量插值 | 有 | 有（白名单 + CRLF 净化 + prototype pollution 防护） |
| 信任管理 | trusted_hooks.json | trusted_hooks.json（对齐） |
| Hook 执行阶段 | 无 | HookPhase（validation / postWrite）用于 Todo 事件 |

## 10. 相关代码索引

| 文件 | 说明 |
|------|------|
| `hooks/types.ts` | 所有类型定义、事件枚举、输出类 |
| `hooks/hookSystem.ts` | 顶层 HookSystem 类 |
| `hooks/hookRegistry.ts` | 配置加载与验证 |
| `hooks/hookPlanner.ts` | Matcher 匹配与执行计划 |
| `hooks/hookRunner.ts` | Command Runner + 路由分发 |
| `hooks/hookAggregator.ts` | 多结果聚合策略 |
| `hooks/hookEventHandler.ts` | 事件触发编排 |
| `hooks/httpHookRunner.ts` | HTTP Hook 执行器 |
| `hooks/functionHookRunner.ts` | Function Hook 执行器 |
| `hooks/promptHookRunner.ts` | Prompt Hook（LLM）执行器 |
| `hooks/sessionHooksManager.ts` | 运行时 Session Hook 管理 |
| `hooks/registerSkillHooks.ts` | Skill Hook 注册 |
| `hooks/ssrfGuard.ts` | SSRF IP 地址阻断 |
| `hooks/urlValidator.ts` | URL 白名单 + 黑名单验证 |
| `hooks/trustedHooks.ts` | 项目 Hook 信任管理 |
| `hooks/envInterpolator.ts` | 环境变量安全插值 |
| `hooks/stopHookCap.ts` | Stop Hook 循环防护 |
| `hooks/asyncHookRegistry.ts` | 异步 Hook 状态跟踪 |
| `hooks/combinedAbortSignal.ts` | AbortSignal + Timeout 组合 |
| `hooks/index.ts` | 模块导出汇总 |
