# 遥测 (Telemetry) 架构 Deep-Dive

> AI Agent 收集什么数据、如何上报、用户如何控制？本文基于 Claude Code（v2.1.89 源码分析）和 Qwen Code（v0.16.0 开源）的源码分析，对比两者在遥测 (Telemetry) 架构、事件体系和隐私控制方面的差异。

---

## 1. 架构总览

| 维度 | Claude Code | Qwen Code |
|------|------------|-----------|
| **遥测框架** | 自定义 1P Logger + OpenTelemetry | QwenLogger（RUM）+ OpenTelemetry |
| **上报端点** | Anthropic 内部 API + Datadog | 阿里云 RUM + OTLP（可配置，支持 gRPC / HTTP 双协议） |
| **事件数量** | ~656 个 `tengu_*` 事件 | ~50 个事件类型 |
| **采样策略** | 按事件类型动态采样（GrowthBook） | 批量刷新（1,000 条 / 60 秒） |
| **调试追踪** | Perfetto（Chrome Trace，ant-only） | 层级 Span 树（interaction → llm_request → tool，v0.16.0 新增） |
| **PII 保护** | 元数据禁止原始字符串 | 选择性 prompt 日志控制 + 敏感属性 opt-in（v0.16.0） |
| **禁用方式** | `DISABLE_TELEMETRY=true` | `QWEN_TELEMETRY_ENABLED=false` |

---

## 2. Claude Code：双通道遥测

### 2.1 事件日志通道（1P Event Logging）

```typescript
// 源码: services/analytics/firstPartyEventLogger.ts
// 使用 @opentelemetry/sdk-logs 的 LoggerProvider + BatchLogRecordProcessor
// 自定义 Exporter: FirstPartyEventLoggingExporter
// 端点: ${BASE_API_URL}/api/event_logging/batch
// 批量配置通过 GrowthBook 动态控制（tengu_1p_event_batch_config）
```

**事件类型**（~656 个唯一 `tengu_*` 前缀，源码 `grep -roh` 统计；含动态构造事件名时约 782 个）：

| 类别 | 示例 |
|------|------|
| Agent 生命周期 | `tengu_agent_created`, `tengu_agent_tool_selected`, `tengu_agent_tool_completed` |
| API 交互 | `tengu_api`, `tengu_api_error`, `tengu_api_cache_breakpoints` |
| 工具执行 | `tengu_tool_*`, `tengu_streaming_tool_execution_used` |
| 会话管理 | `tengu_session_*`, `tengu_compact_*` |
| Feature Flag | `tengu_amber_flint`, `tengu_amber_prism` |
| 安全 | `tengu_cancel`, `tengu_pre_stop_hooks_cancelled` |
| UI | `tengu_brief_mode_toggled`, `tengu_conversation_forked` |

**PII 保护**：

```typescript
// 源码: services/analytics/index.ts
// 元数据类型标注: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
// → 开发者必须显式声明元数据不含代码或文件路径
// → 类型系统阻止意外记录敏感信息
```

### 2.2 Perfetto 调试追踪（ant-only）

```typescript
// 源码: utils/telemetry/perfettoTracing.ts
// 格式: Chrome Trace Event (JSON)，在 ui.perfetto.dev 或 chrome://tracing 查看
// 启用: CLAUDE_CODE_PERFETTO_TRACE=1 或 CLAUDE_CODE_PERFETTO_TRACE=<path>
// 输出: ~/.claude/traces/trace-<session-id>.json
// 事件上限: 100K 条（超出时淘汰最老的 50%，约 30MB）
```

**Perfetto 追踪捕获**：

| 捕获内容 | 详情 |
|----------|------|
| Agent 层级 | 父子 swarm 关系 |
| API 请求 | TTFT、TTLT、prompt 长度、cache 统计 |
| 工具执行 | 名称、耗时、token 用量 |
| 用户等待 | 输入等待时间 |
| Speculation | 推测执行标记 |

### 2.3 采样 (Sampling) 与降级 (Fallback)

```typescript
// 按事件采样 (Sampling): GrowthBook tengu_event_sampling_config（每事件 0-1 概率）
// 第三方 Provider: 自动禁用分析（Bedrock/Vertex/Foundry）
// 测试环境: NODE_ENV === 'test' 时禁用
// 隐私模式: isTelemetryDisabled() 检查
```

---

## 3. Qwen Code：RUM + OTLP 双通道

### 3.1 QwenLogger（RUM 通道）

```typescript
// 源码: qwen-code/packages/core/src/telemetry/qwen-logger/qwen-logger.ts
// 类型: 单例 RUM (Real User Monitoring) Logger
// 端点: gb4w8c3ygj-default-sea.rum.aliyuncs.com（阿里云 RUM）
// 批量: 默认 1,000 条 / 60 秒刷新
// 队列: FixedDeque（溢出时丢弃最老事件）
// v0.16.0 变化: readSourceInfo() 新增支持 QWEN_HOME 自定义路径，
//   同时兼容遗留 ~/.qwen/source.json（#2953）；移除 tool_token_count 上报（#3727）
```

**事件类型**（~50 种）：

| 类别 | 事件 |
|------|------|
| 会话 | `session_start`, `session_end` |
| 用户操作 | `new_prompt`, `retry`, `slash_command`, `user_feedback` |
| 工具 | `tool_call#<name>`, `file_operation#<name>`, `tool_output_truncated` |
| API | `api_request`, `api_response`, `api_cancel`, `api_error` |
| 错误 | `invalid_chunk`, `malformed_json_response`, `loop_detected` |
| 扩展 | `extension_install`, `extension_uninstall`, `extension_update` |
| Arena | `arena_session_started`, `arena_agent_completed` |
| Hook | `hook_call#<event_name>` |
| 压缩 | `chat_compression` |

### 3.2 OpenTelemetry 通道

```typescript
// 源码: qwen-code/packages/core/src/telemetry/sdk.ts
// 3 种 Exporter（v0.16.0，移除 Console Exporter）:
// 1. OTLP gRPC   — OTLPTraceExporter + GZIP 压缩
// 2. OTLP HTTP   — OTLPTraceExporter[Http]（v0.16.0 新增 per-signal 端点路由）
// 3. File        — FileSpanExporter（本地文件）
//
// Processor: BatchSpanProcessor, BatchLogRecordProcessor, LogToSpanProcessor（新增）
// 检测: HttpInstrumentation（HTTP 请求自动追踪）
// 诊断日志: 改为写 debug log 而非 console，避免 UI 污染（#3986）
// shutdown 上限: 10 秒（#3813）
```

**遥测目标**（v0.16.0）：

| 目标 | 用途 |
|------|------|
| `TelemetryTarget.LOCAL` | 本地 OTEL Collector |
| `TelemetryTarget.GCP` | Google Cloud |
| ~~`TelemetryTarget.QWEN`~~ | **已移除**（#4061 移除 dead 代码） |

### 3.3 层级 Span 树（v0.16.0 新增）

v0.16.0 新增 `session-tracing.ts`（883 行），建立完整的层级 Trace 结构：

```
session（根）
  └─ interaction（每次用户 prompt）
       ├─ llm_request（每次 API 调用）
       └─ tool（每次工具调用）
            ├─ tool.execution（实际执行子 span）
            ├─ tool.blocked_on_user（等待用户审批）
            └─ hook（Hook 执行）
```

**关键新 Span 函数**：

| 函数 | PR | 说明 |
|------|----|------|
| `startInteractionSpan` / `endInteractionSpan` | #4071 | 每轮对话根 span |
| `startLLMRequestSpan` / `endLLMRequestSpan` | #4071 | API 调用子 span |
| `startToolSpan` / `endToolSpan` | #4071/#4126 | 工具调用子 span |
| `startToolBlockedOnUserSpan` | #3731 | 权限等待阶段子 span |
| `startHookSpan` / `endHookSpan` | #3731 | Hook 执行子 span |

**敏感属性 opt-in**（#3893/#4097）：设置 `QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES=true` 后，span 记录 user prompt、system prompt、tool schema、model output、tool input/result 等敏感内容（明确 opt-in，默认关闭）。

**traceId/spanId 注入 debug log**（#3847）：debug log 行自动附加当前 span context，可与 OTEL 后端关联。

### 3.4 OTLP HTTP per-signal 端点路由（v0.16.0 新增）

```typescript
// 源码: telemetry/sdk.ts
// 支持 per-signal 端点覆盖（优先级：QWEN_ 变量 > OTEL_ 标准变量 > settings.json）:
// QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT / OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
// QWEN_TELEMETRY_OTLP_LOGS_ENDPOINT   / OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
// QWEN_TELEMETRY_OTLP_METRICS_ENDPOINT/ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
//
// 自动追加 v1/traces、v1/logs、v1/metrics 路径（标准 OTLP HTTP 路由）
```

### 3.5 自定义 Resource Attributes 与 Metric Cardinality 控制（v0.16.0 新增）

```typescript
// 源码: telemetry/config.ts + telemetry/resource-attributes.ts（#4367）
// OTEL_RESOURCE_ATTRIBUTES 环境变量 或 settings.telemetry.resourceAttributes 自定义标签
// RESERVED 键（service.version, session.id）强制过滤 + 警告日志
// OTEL_SERVICE_NAME 覆盖 service.name
//
// Metric session ID cardinality 控制（#4367）：
// QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID=true 才在 metric 标签中包含 session.id
// 默认关闭，防止高基数导致 TSDB 膨胀
```

### 3.6 RUM 事件协议

```typescript
// 源码: qwen-code/packages/core/src/telemetry/qwen-logger/event-types.ts
// RUM 事件层级:
// RumViewEvent     — 页面/视图导航
// RumActionEvent   — 用户交互
// RumResourceEvent — API/网络调用
// RumExceptionEvent — 错误
// 每类含 snapshot (JSON 序列化详细指标)
```

---

## 4. 隐私控制对比

| 维度 | Claude Code | Qwen Code |
|------|------------|-----------|
| **全局禁用** | `DISABLE_TELEMETRY=true` | `QWEN_TELEMETRY_ENABLED=false` |
| **非必要流量** | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true` | — |
| **Prompt 日志** | 禁止（类型系统强制） | `telemetryLogPromptsEnabled()` 控制 |
| **敏感 span 属性** | — | opt-in（`QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES`，默认关闭） |
| **3P Provider** | 自动禁用分析 | — |
| **MDM 控制** | ✅ 策略可关闭遥测 | ❌ |
| **采样** | 按事件动态（GrowthBook） | 全量批刷 |
| **自定义资源标签** | — | ✅ `OTEL_RESOURCE_ATTRIBUTES` / `settings.telemetry.resourceAttributes`（v0.16.0） |
| **Metric session 基数** | — | `QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID`，默认 false（v0.16.0） |

---

## 5. 关键源码文件

### Claude Code

| 文件 | 职责 |
|------|------|
| `services/analytics/index.ts` | `logEvent()` 中央入口 + 队列 |
| `services/analytics/firstPartyEventLogger.ts` | 1P 事件日志（OTLP LoggerProvider） |
| `services/analytics/growthbook.ts` | Feature Flag + 采样配置 |
| `services/analytics/config.ts` | 禁用条件判断 |
| `utils/telemetry/perfettoTracing.ts` | Perfetto Chrome Trace |

### Qwen Code

| 文件 | 职责 |
|------|------|
| `packages/core/src/telemetry/qwen-logger/qwen-logger.ts` | RUM Logger 单例 |
| `packages/core/src/telemetry/qwen-logger/event-types.ts` | RUM 事件协议 |
| `packages/core/src/telemetry/sdk.ts` | OTLP Exporter 配置（v0.16.0 新增 HTTP per-signal 路由、LogToSpanProcessor） |
| `packages/core/src/telemetry/config.ts` | 隐私控制 + 目标选择 + resource attributes 解析（v0.16.0 扩展） |
| `packages/core/src/telemetry/session-tracing.ts` | 层级 Span 树（v0.16.0 新增，883 行） |
| `packages/core/src/telemetry/detailed-span-attributes.ts` | 敏感 span 属性（v0.16.0 新增，opt-in） |
| `packages/core/src/telemetry/metrics.ts` | Metric 定义（含 session.id cardinality 控制） |

> **免责声明**: 以上分析基于 2026 年 Q1 初稿，2026-05-22 对照 v0.16.0 复核。Claude Code v2.1.89；Qwen Code v0.16.0。v0.15.0→v0.16.0 间遥测架构有实质变化：新增层级 Span 树（session-tracing.ts）、移除 TelemetryTarget.QWEN、新增 HTTP per-signal 端点路由、新增 resource attributes 自定义与 metric cardinality 控制、移除 tool_token_count 上报。
