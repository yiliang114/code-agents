# Code Agent 配置系统设计

> 分析日期：2026-05-22
> 涉及项目：Claude Code (Anthropic)、Qwen Code (fork from Google Jules / Gemini CLI)

## 1. 配置的层次与作用域

Code Agent 的配置需要处理多层优先级和多种作用域：

```
环境变量 (最高优先级, runtime override)
  ↓
用户全局配置 (~/.qwen/settings.json)
  ↓
项目配置 (<project>/.qwen/settings.json)
  ↓
代码内置默认值 (最低优先级)
```

这种分层允许：
- 用户有全局偏好（如 model 选择、auth 配置）
- 项目有特定约束（如 permission 限制、hook 配置）
- 临时调试通过环境变量覆盖

## 2. 核心配置项分类

### 2.1 内存与压缩相关配置

这是与 OOM 问题和运行时稳定性最密切相关的配置组。

#### Chat Compression Settings

```typescript
interface ChatCompressionSettings {
  contextPercentageThreshold?: number;  // 触发压缩的 context window 占比
  imageTokenEstimate?: number;          // 压缩前 media stripping 的 token 估算
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `chatCompression.contextPercentageThreshold` | `0.7` | 当 prompt token 达到 context window 的 70% 时触发自动压缩 |
| `chatCompression.imageTokenEstimate` | `1600` | 每个 inline image 估算的 token 数（用于 media stripping） |

**环境变量覆盖**：
- `QWEN_IMAGE_TOKEN_ESTIMATE` — 覆盖 imageTokenEstimate

#### Clear Context On Idle Settings

```typescript
interface ClearContextOnIdleSettings {
  toolResultsThresholdMinutes?: number;  // 空闲多久后清理
  toolResultsNumToKeep?: number;         // 保留最近 N 个 tool result
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `clearContextOnIdle.toolResultsThresholdMinutes` | `60` | 空闲超过 60 分钟后开始清理旧 tool results（-1 禁用） |
| `clearContextOnIdle.toolResultsNumToKeep` | `5` | 保留最近的 5 个 tool result 不被清理 |

**环境变量覆盖**：
- `QWEN_MC_KEEP_RECENT` — 覆盖 toolResultsNumToKeep

#### 硬编码常量（不可配置，改动需要代码变更）

| 常量 | 值 | 位置 | 说明 |
|------|-----|------|------|
| `COMPRESSION_TOKEN_THRESHOLD` | `0.7` | chatCompressionService.ts | 默认触发阈值 |
| `COMPRESSION_PRESERVE_THRESHOLD` | `0.3` | chatCompressionService.ts | 压缩后保留最近 30% 历史 |
| `MIN_COMPRESSION_FRACTION` | `0.05` | chatCompressionService.ts | 可压缩部分 <5% 时跳过 |
| `TOOL_ROUND_RETAIN_COUNT` | `2` | chatCompressionService.ts | 保留最近 2 轮完整 tool round |
| `HIGH_HEAP_PRESSURE_THRESHOLD` | `0.85` | memoryDiagnostics.ts | heap 占比超过 85% 告警 |
| `DEFAULT_TOKEN_LIMIT` | `131072` | tokenLimits.ts | 默认 context window 128K |

### 2.2 Memory（记忆系统）相关配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 记忆存储模式 | Global | `QWEN_CODE_MEMORY_LOCAL=1` 切换为项目本地存储 |
| 记忆根目录 | `~/.qwen` | `QWEN_CODE_MEMORY_BASE_DIR` 覆盖 |
| Dream 最小间隔 | 24 小时 | 两次 dream 的最小间隔 |
| Dream 最小 session 数 | 5 | 累积至少 5 个 session 才触发 dream |
| Recall 最大文档数 | 5 | 最多检索 5 个相关记忆 |
| Index 最大行数 | 200 | MEMORY.md 超过 200 行截断 |
| Index 最大字节 | 25000 | MEMORY.md 超过 25KB 截断 |
| Body 截断长度 | 1200 | recall 时每个记忆 body 最多 1200 字符 |
| Scan 最大文件数 | 200 | 最多扫描 200 个 topic 文件 |

### 2.3 Telemetry 配置

```typescript
interface TelemetrySettings {
  enabled?: boolean;
  outfile?: string;
  logPrompts?: boolean;
  includeSensitiveSpanAttributes?: boolean;
  otlpEndpoint?: string;
  otlpProtocol?: 'grpc' | 'http/protobuf';
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `telemetry.enabled` | `true` | 是否开启 telemetry |
| `telemetry.outfile` | undefined | 本地落盘路径（设置后不走远程 OTLP） |
| `telemetry.logPrompts` | `false` | 是否记录完整 prompt/response（敏感） |
| `telemetry.includeSensitiveSpanAttributes` | `false` | 是否包含敏感 span 属性 |
| `telemetry.otlpEndpoint` | undefined | OTLP 远程 collector 地址 |

### 2.4 Auth 与 Provider 配置

```typescript
interface AuthSettings {
  selectedType: 'openai' | 'qwen-oauth' | 'gemini' | 'vertex-ai' | 'anthropic';
  openai?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  };
}
```

Provider 选择链路决定了请求改写行为（参见 [Provider 行为文档](../qwen-code-provider-behavior/README.md)）。

### 2.5 Permission 与 Safety 配置

```typescript
interface PermissionSettings {
  allowedTools?: string[];           // 白名单工具
  deniedTools?: string[];            // 黑名单工具
  bashAllowedCommands?: string[];    // 允许的 bash 命令模式
  bashDeniedCommands?: string[];     // 禁止的 bash 命令模式
}
```

## 3. 配置与 OOM 问题的关系

OOM 问题的核心发现之一是：**配置缺失或配置不当会放大内存压力**。

### 3.1 Context Window Size 的关键性

```
contextWindowSize = resolvedModelLimit(model) || DEFAULT_TOKEN_LIMIT (128K)
```

如果模型没有被正确识别（如 DeepSeek 等 OpenAI-compatible 模型），会 fallback 到 128K。

128K 的 70% = 90K tokens 就触发压缩，对于实际有更大窗口的模型来说：
- 压缩频率不必要地高
- 更多 `structuredClone()` 调用
- OOM 风险增大

**修复方向**：三层阈值 + 绝对值兜底（见 [auto-compaction-threshold-redesign](../qwen-code-memory-investigation/auto-compaction-threshold-redesign.md)）。

### 3.2 Heap Limit 与配置

Node.js 默认 heap limit：
- 64-bit 系统：约 2GB（V8 自动决定，通常 1.5-2GB）
- 明确设置：`NODE_OPTIONS=--max-old-space-size=4096`

Code Agent 没有在入口脚本中主动设置 `--max-old-space-size`，依赖 Node.js 默认行为。这意味着：
- macOS：默认约 2GB
- Linux：默认约 2-4GB（取决于可用内存）
- Windows：默认约 2GB

用户报告的 OOM 几乎都在默认 heap limit 附近（2GB 或 4GB）。

### 3.3 Microcompaction 的保守默认值

默认 60 分钟空闲才触发清理，对于持续工作的长会话来说：
- 如果用户一直在对话（无 60 分钟空闲），microcompaction 永远不会触发
- 大量 tool result 持续累积
- 只靠 token-based compression 兜底

## 4. 配置验证与容错

### 4.1 数值类型的 Resolution 策略

```typescript
function resolveNumber(
  envValue: string | undefined,      // 最高优先级
  settingsValue: number | undefined, // 次优先级
  defaultValue: number,              // 兜底
  { minInclusive }: { minInclusive: number }
): number
```

所有数值配置都经过统一的 resolution：
1. 环境变量 > settings > default
2. 无效值（NaN, Infinity, 负数）自动 fallthrough 到下一级
3. 最终保证返回有效值

### 4.2 Settings 文件的合并

项目 settings 不完全覆盖用户 settings，而是深度合并（deep merge）。这允许：
- 用户全局设置 model 偏好
- 项目只覆盖 permission（不影响 model 选择）

## 5. Hooks 系统

Hooks 是配置系统中唯一能实现"自动化行为"的机制。

```json
{
  "hooks": {
    "PreToolCall": [
      {
        "matcher": "shell",
        "command": "echo 'About to run shell command'"
      }
    ],
    "PostToolCall": [...],
    "PreCompact": [...],
    "PostCompact": [...],
    "SessionStart": [...]
  }
}
```

| Hook 事件 | 触发时机 | 典型用途 |
|-----------|---------|---------|
| `PreToolCall` | 工具调用前 | 安全检查、审计日志 |
| `PostToolCall` | 工具调用后 | 结果验证 |
| `PreCompact` | 压缩前 | 保存压缩前状态 |
| `PostCompact` | 压缩后 | 通知、日志 |
| `SessionStart` | 会话开始 | 环境初始化 |

### 5.1 Hooks 与 Memory/Compression 的交互

- `PreCompact` hook 可以在压缩前保存当前 history 的 snapshot
- `PostCompact` hook 可以触发 memory extraction（确保压缩前的重要信息被记住）
- `SessionStart` hook 可以加载项目特定的 context

## 6. 配置的运行时可变性

部分配置是会话级别不可变的，部分是可以运行时调整的：

| 配置 | 可变性 | 说明 |
|------|--------|------|
| Auth/Provider | 不可变 | 会话开始时确定，中途不能切换 |
| Model | 可变 | `/model` 命令可以切换 |
| Compression threshold | 不可变 | 编译时常量 |
| Microcompaction settings | 不可变 | 启动时读取 |
| Permission | 运行时可提升 | 用户可以逐次授权 |
| Telemetry | 不可变 | 启动时确定 |
| Memory 功能 | 可变 | 可以运行时触发 /dream, /forget |

## 7. 设计经验

### 7.1 "配置越少越好"原则

暴露过多配置项给用户的问题：
- 大多数用户不会去调整
- 错误的配置值可能导致不可预期的行为
- 维护成本高（每个配置都要文档、验证、测试）

Qwen Code 的做法：大部分参数作为代码常量，只有**确实有合理不同取值**的才暴露为配置。

### 7.2 环境变量用于调试，Settings 用于持久偏好

```
NODE_OPTIONS=--max-old-space-size=4096    ← 临时调试
QWEN_CODE_MEMORY_TIMELINE=1              ← 临时诊断

settings.json: { "model": "qwen-max" }   ← 持久偏好
```

### 7.3 Provider 识别的"失败安全"设计

当 provider 无法被精确识别时，fallback 到 `Default` provider class（最保守的请求格式），而不是报错退出。这确保了：
- 任何 OpenAI-compatible endpoint 都至少能尝试调用
- 未知 provider 不会阻断用户工作流

### 7.4 Permission 的"默认拒绝 + 逐次授权"

安全的默认态是拒绝所有有副作用的操作（写文件、执行命令等），通过以下机制放宽：
1. `settings.json` 中的 allowlist（持久化授权）
2. 运行时用户确认（单次授权）
3. 特殊模式如 YOLO mode（全量授权，仅限开发环境）

## 8. 配置系统与 Claude Code 的对比

| 维度 | Claude Code | Qwen Code |
|------|------------|-----------|
| 配置文件位置 | `~/.claude/settings.json` | `~/.qwen/settings.json` |
| 项目级配置 | `<project>/.claude/settings.json` | `<project>/.qwen/settings.json` |
| Context 文件 | `CLAUDE.md` | `QWEN.md` / `AGENTS.md` |
| Hooks | `settings.json` hooks section | `settings.json` hooks section |
| Permission | allowlist + runtime confirm | allowlist + runtime confirm |
| 压缩配置 | 内部常量为主 | `chatCompression` settings + 内部常量 |
| 模型切换 | `/model` command | `/model` command |
| Auth | `selectedType` | `selectedType` |

主要差异：Qwen Code 由于支持多 provider（OpenAI-compatible），在 auth 和 provider 识别方面有更复杂的配置层次。

## 9. 相关代码索引

| 文件 | 说明 |
|------|------|
| `packages/core/src/config/config.ts` | 核心配置类型定义 |
| `packages/core/src/config/settings.ts` | Settings 加载与合并逻辑 |
| `packages/core/src/core/tokenLimits.ts` | 模型 context window 大小映射 |
| `packages/core/src/services/chatCompressionService.ts` | 压缩相关常量 |
| `packages/core/src/services/compactionInputSlimming.ts` | Slimming 配置解析 |
| `packages/core/src/services/microcompaction/microcompact.ts` | Microcompaction 配置 |
| `packages/cli/src/utils/memoryDiagnostics.ts` | 诊断阈值常量 |
| `packages/core/src/memory/paths.ts` | Memory 路径配置 |
| `packages/core/src/hooks/` | Hooks 系统实现 |
