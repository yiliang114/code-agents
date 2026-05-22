# Qwen Code 遥测系统（Telemetry）

> 分析版本：v0.16.0 | 分析日期：2026-05-22

## 1. 概述

Qwen Code 的遥测系统基于 OpenTelemetry（OTel）标准构建，提供三大信号（Traces、Logs、Metrics）的完整采集能力。系统同时集成了阿里云 RUM（Real User Monitoring）上报通道，形成「标准 OTLP 导出 + 阿里云 RUM 上报」的双通道架构。

核心设计目标：
- **Session 级别的全链路追踪**：以 sessionId 派生确定性 traceId，将整个会话的所有 span 归属于同一条 trace
- **分层 span 树**：Interaction → LLM Request / Tool → Tool Execution / Hook，完整还原每次交互的执行链路
- **隐私安全**：默认过滤敏感字段（prompt 内容、function_args、error 详情等），仅在显式开启时导出
- **零侵入降级**：当 SDK 未初始化时，所有 tracer/logger 调用均为 noop，不影响业务逻辑

源码位置：`packages/core/src/telemetry/`

## 2. OpenTelemetry SDK 集成

入口文件 `sdk.ts` 负责 NodeSDK 的初始化和关闭。

**协议支持**：
- gRPC（默认）：使用 `@opentelemetry/exporter-trace-otlp-grpc`，支持 GZIP 压缩
- HTTP/protobuf：使用 `@opentelemetry/exporter-trace-otlp-http`，支持 per-signal 独立 endpoint

**信号管线**：
| 信号 | Processor | Exporter |
|------|-----------|----------|
| Traces | `BatchSpanProcessor` | `OTLPTraceExporter` / `FileSpanExporter` |
| Logs | `BatchLogRecordProcessor` 或 `LogToSpanProcessor` | `OTLPLogExporter` / `FileLogExporter` |
| Metrics | `PeriodicExportingMetricReader`（10s 间隔） | `OTLPMetricExporter` / `FileMetricExporter` |

**LogToSpanProcessor 桥接**：当 logs endpoint 不可用但 traces endpoint 存在时，系统自动启用 `LogToSpanProcessor`，将 OTel Log Record 转换为 Span 导出。这解决了部分后端（如阿里云 ARMS）仅支持 Traces 不支持 Logs 的问题。

**Resource 属性**：
- `service.name`：固定为 `qwen-code`（可通过 `OTEL_SERVICE_NAME` 覆盖）
- `service.version`：CLI 版本号
- 用户自定义属性通过 `OTEL_RESOURCE_ATTRIBUTES` 或 settings 注入，RESERVED 字段（`service.version`、`session.id`）会被自动剥离

**生命周期**：
- `initializeTelemetry(config)` → SDK 启动 + 创建 session root context + 初始化 metrics
- `refreshSessionContext(sessionId)` → /clear、/resume 时刷新 traceId
- `shutdownTelemetry()` → 带 10s 超时的优雅关闭

## 3. Tracer 与 Span 设计

### Session-level Span（合成根）

`tracer.ts` 中的 `createSessionRootContext()` 通过 SHA-256 对 sessionId 做 hash 截断生成确定性 traceId（32 hex chars），创建一个合成 root span context。所有后续 span 均挂载于此 context 下，保证同一 session 的所有 span 共享一条 trace。

采样策略：当 `OTEL_TRACES_SAMPLER` 为 `parentbased_*`（排除 `always_off`）时，强制设置 `TraceFlags.SAMPLED`。

### Interaction Span（Turn 级别）

`session-tracing.ts` 中的 `startInteractionSpan()` / `endInteractionSpan()` 管理每一轮用户交互：

```
attributes: session.id, prompt_id, message_type, model, approval_mode, interaction.sequence
end attrs: interaction.duration_ms, turn_status (ok | error | cancelled)
```

使用 `AsyncLocalStorage` 维护 interaction context，支持并发安全。

### LLM Request Span

`startLLMRequestSpan()` / `endLLMRequestSpan()` 追踪每次 LLM API 调用：

```
attributes: model, prompt_id, gen_ai.request.model
end attrs: duration_ms, input_tokens, output_tokens, cached_input_tokens,
           ttft_ms, sampling_ms, output_tokens_per_second, attempt, retry_total_delay_ms
```

双重发射 OTel GenAI semantic conventions（`gen_ai.usage.*`、`gen_ai.server.time_to_first_token`）。

### Tool Span 层级

```
qwen-code.tool                    ← startToolSpan / endToolSpan
  ├─ qwen-code.tool.blocked_on_user  ← 等待用户审批的时间
  ├─ qwen-code.hook                  ← PreToolUse / PostToolUse hook 执行
  └─ qwen-code.tool.execution        ← 实际工具执行
```

`runInToolSpanContext()` 通过 `AsyncLocalStorage` + `otelContext.with()` 双重绑定，确保嵌套 span（HTTP 自动插桩、hook 子调用）正确继承 parent。

### TTL 安全网

所有活跃 span 通过 `WeakRef` + `strongSpans` Map 持有引用，每 60 秒执行一次 GC 扫描。超过 30 分钟未结束的 span 会被强制 end 并标记 `qwen-code.span.ttl_expired: true`。

## 4. Metrics 指标

`metrics.ts` 定义了完整的指标体系，分为核心指标和性能监控指标两大类：

**核心 Counter**：
| 指标名 | 说明 |
|--------|------|
| `qwen-code.tool.call.count` | 工具调用次数（按 function_name、success、decision 分维度） |
| `qwen-code.api.request.count` | API 请求次数（按 model、status_code 分维度） |
| `qwen-code.token.usage` | Token 用量（按 model、type=input/output/thought/cache 分维度） |
| `qwen-code.session.count` | 会话启动次数 |
| `qwen-code.file.operation.count` | 文件操作次数 |

**核心 Histogram**：
| 指标名 | 说明 |
|--------|------|
| `qwen-code.tool.call.latency` | 工具调用耗时（ms） |
| `qwen-code.api.request.latency` | API 请求耗时（ms） |

**性能监控指标**（需 telemetry enabled 才激活）：startup duration、memory/cpu usage、tool queue depth、tool execution breakdown、token efficiency、performance score/regression detection。

**Arena 指标**：`arena.session.count/duration`、`arena.agent.count/duration/tokens`、`arena.result.selected`。

**Auto-Memory 指标**：`memory.extract/dream/recall` 的 count + duration。

`session.id` 在 metrics 上默认不附加（防止高基数），需通过 `QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID` 显式启用。

## 5. Sanitize（敏感字段过滤）

`sanitize.ts` 提供 `sanitizeHookName()` 函数，从完整命令字符串中提取安全的命令名：

- 移除文件路径中可能包含的用户名
- 移除可能包含 credentials / API keys 的命令参数
- 示例：`"/home/user/.hooks/check.sh --token=xyz"` → `"check.sh"`

`LogToSpanProcessor` 内部维护 `SENSITIVE_ATTRIBUTE_KEYS` 集合（`error`、`prompt`、`function_args`、`response_text`），默认从转换后的 span 中剥离这些字段，仅当 `includeSensitiveSpanAttributes: true` 时才保留。

`detailed-span-attributes.ts` 中的所有 `addXxxAttributes()` 函数都受 `config.getTelemetryIncludeSensitiveSpanAttributes()` 门控，未开启时完全不写入 prompt/tool input/output 等内容。内容写入时还会执行 60KB 截断保护。

## 6. File Exporters（本地落盘）

`file-exporters.ts` 实现了三个文件导出器，用于 `telemetryOutfile` 模式：

- `FileSpanExporter`：将 span 以 JSON 格式 append 到指定文件
- `FileLogExporter`：将 log record 以 JSON 格式 append 到指定文件
- `FileMetricExporter`：将 ResourceMetrics 以 JSON 格式 append 到指定文件

均继承自 `FileExporter` 基类，使用 `fs.createWriteStream({ flags: 'a' })` 追加写入。适用于本地调试场景。

## 7. Session Tracing

`session-tracing.ts` 是 Qwen Code 特有的会话级追踪层，核心能力：

1. **分层 span 管理**：通过 `interactionContext` 和 `toolContext` 两个 AsyncLocalStorage 实例维护 span 树关系
2. **Parent 解析策略**（`resolveParentContext()`）：显式 ALS parent → 活跃 OTel span → session root → active context fallback
3. **Span 生命周期追踪**：`activeSpans`（WeakRef）+ `strongSpans`（强引用）双 Map 结构，防止 GC 回收活跃 span
4. **Error 截断**：`truncateSpanError()` 限制 error 字符串最大 1024 chars，并正确处理 surrogate pair 切割，避免 OTLP/gRPC collector 拒绝无效 UTF-8

导出的 span 类型及名称（`constants.ts`）：
- `qwen-code.interaction` — 每轮用户交互
- `qwen-code.llm_request` — LLM API 调用
- `qwen-code.tool` — 工具调用（含审批等待）
- `qwen-code.tool.execution` — 工具实际执行
- `qwen-code.tool.blocked_on_user` — 等待用户审批
- `qwen-code.hook` — Hook 执行

## 8. UI Telemetry

`uiTelemetry.ts` 提供面向前端 UI 的实时指标聚合服务 `UiTelemetryService`，是一个 EventEmitter 单例：

**聚合维度**：
- **按模型**：每个 model 的 API 请求/错误数、延迟、token 用量（prompt/candidates/cached/thoughts），再按 source（subagent name）细分
- **按工具**：总调用数/成功/失败/延迟/decisions，再按工具名细分
- **文件统计**：totalLinesAdded / totalLinesRemoved

**事件流**：通过 `addEvent()` 接收 `EVENT_API_RESPONSE` / `EVENT_API_ERROR` / `EVENT_TOOL_CALL` 三类事件，实时更新 `SessionMetrics`，触发 `'update'` 事件驱动 UI 刷新。

此服务独立于 OTel SDK，即使 telemetry 未开启也能为 UI 提供 cost/usage 展示。

## 9. Tool Call Decision 追踪

`tool-call-decision.ts` 定义了工具调用决策枚举及映射：

```typescript
enum ToolCallDecision { ACCEPT, REJECT, MODIFY, AUTO_ACCEPT }
```

`getDecisionFromOutcome()` 将用户的 `ToolConfirmationOutcome`（ProceedOnce / ProceedAlways* / ModifyWithEditor / Cancel）映射为标准化的 decision 标签，供 metrics 和 logs 使用。

## 10. 配置项

`config.ts` 中的 `resolveTelemetrySettings()` 按优先级合并配置：**CLI args > 环境变量 > settings.json**。

| 配置项 | 环境变量 | 说明 |
|--------|----------|------|
| enabled | `QWEN_TELEMETRY_ENABLED` | 是否启用 OTel 遥测 |
| target | `QWEN_TELEMETRY_TARGET` | `local` / `gcp` |
| otlpEndpoint | `QWEN_TELEMETRY_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP 导出地址 |
| otlpProtocol | `QWEN_TELEMETRY_OTLP_PROTOCOL` | `grpc` / `http` |
| otlpTracesEndpoint | `QWEN_TELEMETRY_OTLP_TRACES_ENDPOINT` | 独立 traces 地址（仅 HTTP） |
| otlpLogsEndpoint | `QWEN_TELEMETRY_OTLP_LOGS_ENDPOINT` | 独立 logs 地址（仅 HTTP） |
| otlpMetricsEndpoint | `QWEN_TELEMETRY_OTLP_METRICS_ENDPOINT` | 独立 metrics 地址（仅 HTTP） |
| logPrompts | `QWEN_TELEMETRY_LOG_PROMPTS` | 是否记录 prompt 文本 |
| includeSensitiveSpanAttributes | `QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES` | 是否导出敏感 span 属性 |
| outfile | `QWEN_TELEMETRY_OUTFILE` | 本地文件导出路径 |
| metrics.includeSessionId | `QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID` | metrics 是否携带 session.id |
| resourceAttributes | `OTEL_RESOURCE_ATTRIBUTES` | 自定义 Resource 属性 |

## 11. 与 Claude Code Telemetry 的对比

| 维度 | Claude Code | Qwen Code |
|------|-------------|-----------|
| OTel SDK | 相同 `@opentelemetry/sdk-node` 基础 | 相同，增加了 HTTP protocol 支持和 per-signal endpoint |
| traceId 生成 | sessionId → SHA-256 → 32 hex | 相同策略（继承自 Claude Code） |
| Span 层级 | interaction / api_call | interaction / llm_request / tool / tool.execution / tool.blocked_on_user / hook |
| Log→Span 桥接 | 有 LogToSpanProcessor | 继承并增强（buffer overflow 保护、sensitive 字段过滤） |
| RUM 上报 | 无 | 新增 `QwenLogger` 上报至阿里云 RUM |
| 性能监控 | 基础 metrics | 完整性能监控体系（startup/memory/cpu/regression detection） |
| Arena 指标 | 无 | 新增 Arena session/agent/result 指标 |
| Auto-Memory 指标 | 无 | 新增 memory extract/dream/recall 指标 |
| Hook span | 无 | 新增 `qwen-code.hook` span 类型 |
| Tool blocked span | 无 | 新增 `qwen-code.tool.blocked_on_user` 精确追踪审批等待时间 |
| GenAI semconv | 无 | 双重发射 `gen_ai.usage.*` / `gen_ai.server.time_to_first_token` |

## 12. 相关代码索引

| 文件 | 职责 |
|------|------|
| `sdk.ts` | OTel NodeSDK 初始化/关闭、exporter 选择 |
| `tracer.ts` | `withSpan()`、`startSpanWithContext()`、session root context |
| `session-tracing.ts` | 分层 span 管理（interaction/llm/tool/hook） |
| `session-context.ts` | session root context 存取 |
| `trace-id-utils.ts` | `deriveTraceId()`、`randomSpanId()` |
| `metrics.ts` | 全部 Counter/Histogram 定义及 record 函数 |
| `loggers.ts` | 所有 `logXxx()` 函数（OTel Log + QwenLogger 双写） |
| `config.ts` | `resolveTelemetrySettings()` 配置合并 |
| `constants.ts` | SERVICE_NAME、EVENT_* 常量、SPAN_* 名称 |
| `file-exporters.ts` | FileSpanExporter / FileLogExporter / FileMetricExporter |
| `log-to-span-processor.ts` | Log Record → Span 桥接处理器 |
| `sanitize.ts` | `sanitizeHookName()` 敏感信息剥离 |
| `detailed-span-attributes.ts` | 敏感 span 属性（prompt/tool input/output）的条件写入 |
| `uiTelemetry.ts` | UI 实时指标聚合服务 |
| `tool-call-decision.ts` | 工具调用 decision 枚举及映射 |
| `qwen-logger/qwen-logger.ts` | 阿里云 RUM 上报通道（QwenLogger 单例） |
| `qwen-logger/event-types.ts` | RUM 事件类型定义 |
| `resource-attributes.ts` | Resource 属性解析/校验/合并 |
| `types.ts` | 所有 telemetry 事件的 TypeScript 类型定义 |
