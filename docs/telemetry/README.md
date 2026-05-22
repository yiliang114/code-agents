# Code Agent Telemetry 使用指南

> 分析日期：2026-05-20
> 适用项目：Qwen Code / 基于 OpenTelemetry 的 Code Agent

本文整理 Code Agent 场景下 Telemetry 的使用建议，重点是：**默认用于链路和性能分析，敏感内容只适合临时、本地、受控排查**。

## 1. 日常应该怎么用

日常线上建议只开启结构化观测，不开启敏感字段：

```json
{
  "telemetry": {
    "enabled": true,
    "logPrompts": false,
    "includeSensitiveSpanAttributes": false
  }
}
```

这种模式主要用来回答：

- 一条用户消息总耗时是多少
- 中间调用了几次 LLM
- 每次 LLM request 耗时、token、模型是什么
- 调用了哪些 tool call
- 每个 tool call 耗时、成功/失败、错误类型是什么
- 哪一步最慢，是模型慢、工具慢、还是失败/重试导致慢

这类分析通常不需要完整 prompt、文件内容、tool result、模型输出。

## 2. 默认结构化数据能看到什么

默认非敏感模式下，重点字段通常是：

| 字段 | 维度 | 说明 |
|------|------|------|
| `session.id` / `sessionId` | 会话 | 会话维度唯一标识 |
| `prompt_id` | 用户输入 | 一轮用户输入维度 |
| `call_id` / `callId` | 工具调用 | 单个工具调用维度 |
| `response_id` | 模型响应 | 模型响应维度 |
| `trace_id` / `span_id` | 链路 | trace 后端里的链路维度 |
| `tool.name` / `function_name` | 工具 | 工具名 |
| `duration_ms` | 耗时 | 单步耗时 |
| `success` / `status` / `error_type` | 状态 | 成功失败和错误类型 |
| `model` | 模型 | 使用的模型 |
| `input_tokens` / `output_tokens` / cache tokens | token | token 消耗 |
| `content_length` | 大小 | 工具结果大小 |

这些字段足够做 waterfall、瓶颈定位、失败率统计、token 成本分析。

## 3. 不开敏感字段时的限制

不开敏感字段时，通常只能看到"发生了什么类型的动作"，不能完整还原"动作具体处理了什么内容"。

例如能看到：

- 调用了 `read_file`，参数里可能有 path
- 耗时 120ms，成功
- 返回内容长度 4000

但不一定能看到：

- 文件完整内容
- Bash 完整 stdout/stderr
- grep 完整结果
- 模型完整回复
- 用户完整 prompt
- tool result 的完整 payload

所以如果要做完整行为复盘，通常要结合多个数据源：

| 数据源 | 能看到什么 |
|--------|-----------|
| telemetry outfile | 链路、耗时、span、tool input/result（可能截断） |
| `chats/<sessionId>.jsonl` | 会话历史、functionCall/functionResponse、assistant/user turn |
| 工具/业务系统日志 | 原始 stdout/stderr、服务日志、CI 日志等 |

> **注意**：`outfile` 不是严格无损黑匣子。长 prompt、长 tool result、长 model output 都可能截断；部分工具输出也可能在进入 telemetry 之前已经被系统裁剪。

## 4. 敏感排查模式

临时排查时可以打开敏感字段：

```json
{
  "telemetry": {
    "enabled": true,
    "outfile": ".qwen/debug-telemetry.log",
    "logPrompts": true,
    "includeSensitiveSpanAttributes": true
  }
}
```

**这个模式不能默认开**，原因是它可能记录：

- 用户原始 prompt / system prompt / model output
- tool_input / tool_result
- read_file 读到的文件内容
- Bash 命令和 stdout/stderr
- 代码、路径、token、API key、环境变量等敏感信息

性能影响：序列化更重、文件更大、上传/flush 更慢、后端查询更慢。长任务、大文件读取、大 stdout/stderr 场景尤其明显。

## 5. OTLP 远程投递 vs outfile 本地落盘

### 5.1 远程 OTLP 投递

```json
{
  "telemetry": {
    "enabled": true,
    "otlpEndpoint": "http://collector.example.com:4317",
    "otlpProtocol": "grpc"
  }
}
```

数据流向：

```
span / log / metric 产生
  -> OTel SDK 内存队列
  -> batch / 周期性 flush
  -> OTLP exporter
  -> collector / backend
```

特征：
- span/log 通常批量发送，metrics 通常周期性发送
- 进程退出时尝试 flush
- 网络失败、远端不可用、进程被 kill 时，尾部数据可能丢失
- 如果开启敏感字段，敏感内容会直接出网

### 5.2 outfile 本地落盘

```json
{
  "telemetry": {
    "enabled": true,
    "outfile": ".qwen/debug-telemetry.log"
  }
}
```

特征：
- 设置 `outfile` 后，通常不走远程 OTLP
- 文件里追加 span/log/metric 的 JSON 对象
- 更适合排查问题，但不是标准可直接导入所有平台的 OTLP 文件
- 上传前建议先做格式转换、脱敏、压缩和加密

### 5.3 怎么选

| 场景 | 推荐方式 | 敏感字段 |
|------|---------|---------|
| 日常线上观测 | `otlpEndpoint` → localhost collector → 远端 | 关闭 |
| 临时深度排查 | `outfile` 本地落盘 → sanitizer → 上传 | 按需开启 |
| 生产环境默认 | `otlpEndpoint` + 非敏感模式 | 关闭 |

### 5.4 关键风险

如果同时开启 `logPrompts: true` + `includeSensitiveSpanAttributes: true` 并配置远程 `otlpEndpoint`，以下内容可能直接出网：

- 用户 prompt / system prompt / model output
- tool_input / tool_result / 文件内容
- Bash stdout/stderr
- API key、token、路径、代码等

**生产默认应避免这种组合。**

## 6. 推荐的生产架构

### 日常线上

```
Agent / Qwen Code
  -> localhost OpenTelemetry Collector / sidecar
  -> 远端观测系统
```

配置：

```
logPrompts=false
includeSensitiveSpanAttributes=false
```

### 深度排查

```
Agent / Qwen Code
  -> 本地 raw debug outfile
  -> 本地 sanitizer 进程
  -> 脱敏 / 裁剪 / 摘要化 / 加密
  -> OSS 或内部分析平台
```

上传前应删除或摘要化的字段：

| 应删除/摘要化 | 应保留 |
|--------------|--------|
| `prompt` | `session.id` |
| `request_text` | `prompt_id` |
| `response_text` | `call_id` |
| `new_context` | `response_id` |
| `system_prompt` | `trace_id` / `span_id` |
| `tool_input` | `tool.name` |
| `tool_result` | `duration_ms` |
| `function_args` | `success` / `error_type` |
| stdout / stderr | `model` |
| 文件内容 | token counts |
| 真实用户/租户/项目/路径 | content length / 时间戳 |

## 7. Agent 角色与 Subagent 配合

如果有不同 agent 角色（main / planner / worker / reviewer / subagent），建议把角色信息作为低敏 metadata 上报：

```
agent_role       — 角色类型
subagent_name    — 子 agent 名称
agent_id         — agent 实例 ID
source           — 来源标识
tenant_hash      — 租户哈希（非明文）
user_hash        — 用户哈希（非明文）
```

可用于分析：

- 哪类角色最慢
- 哪类角色 tool call 最多
- 哪类角色失败率高
- subagent 是否放大了 LLM/tool 调用次数
- 同一轮里 main 与 subagent 的耗时占比

> **注意**：不要直接上传真实用户名、客户名、项目名，需要做 hash 或枚举化。

## 8. 推荐的排查流程

1. 只对目标 session / 目标机器 / 短时间窗口打开 debug 配置
2. 复现问题
3. 立刻关闭 `includeSensitiveSpanAttributes` 和 `logPrompts`
4. 下载 `.qwen/debug-telemetry.log` 与对应 `chats/<sessionId>.jsonl`
5. 本地或受控环境分析
6. 如需上传平台，先做脱敏/压缩/加密/格式转换
7. 上传后删除远程 raw 文件，并设置 OSS 生命周期自动清理

## 总结

- **默认 telemetry** 适合做性能和链路分析
- **敏感字段** 只适合临时、本地、受控地做深度行为复盘
- **生产默认不应全开**
- `otlpEndpoint` 适合日常实时观测（关闭敏感字段）
- `outfile` 适合临时深度排查（开启敏感字段时优先本地落盘）
- 敏感字段开启时，优先选择 `outfile + sanitizer`，不要直接远程裸投
