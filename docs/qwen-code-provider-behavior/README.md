# Qwen Code Provider Behavior Notes

本文记录 Qwen Code 在 OpenAI-compatible 通道下，不同 provider 的识别方式、请求改写行为和设计取舍。内容基于 `QwenLM/qwen-code` 的 `origin/main`，时间点为 2026-05-20，已包含 PR [#4157](https://github.com/QwenLM/qwen-code/pull/4157)。

## 一句话结论

`modelProviders.openai` 只决定走 OpenAI-compatible runtime；进入这个 runtime 后，Qwen Code 还会根据 `baseUrl`、`authType`、`model` 再选择更细的 provider class，例如 DashScope、DeepSeek、OpenRouter、ModelScope、MiniMax、Mistral 或 Default。

这些 provider 的目的不是换一套 SDK，而是在真正发请求前做 provider-specific wire shape 修正：补 header、补 metadata、改请求字段、删不兼容字段、启用特殊响应解析等。

## Provider 选择链路

入口在：

```text
packages/core/src/core/openaiContentGenerator/index.ts
```

判断顺序是：

```text
DashScope
DeepSeek
OpenRouter
ModelScope
MiniMax
Mistral
Default
```

顺序很重要。某个配置一旦命中前面的 provider，后面的 provider 就不会再检查。

需要区分两层概念：

```text
auth/runtime 层：
  openai / qwen-oauth / gemini / vertex-ai / anthropic

OpenAI-compatible provider 层：
  DashScope / DeepSeek / OpenRouter / ModelScope / MiniMax / Mistral / Default
```

`/connect provider` 配置的是 runtime/auth 层，最终会写入类似：

```json
{
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "modelProviders": {
    "openai": [
      {
        "baseUrl": "https://example.com/v1",
        "models": ["some-model"]
      }
    ]
  }
}
```

目前 `providerType: "dashscope"` 不是主线支持的显式配置。OpenAI-compatible provider 主要仍由 `baseUrl` / `authType` / `model` 推断。

## 通用请求构建流程

OpenAI-compatible 请求大致经历以下步骤：

1. Gemini-style request 被转换成 OpenAI chat completions request。
2. pipeline 加入通用采样参数、reasoning 配置、stream options、tools。
3. provider 的 `buildRequest()` 对请求做专属改写。
4. pipeline 处理禁用 reasoning 的通用逻辑。
5. `enableOpenAILogging` 捕获 provider 改写后的 request body。
6. OpenAI SDK 发起请求。
7. response 被 converter 转回 Gemini-style response，再进入 UI 和统计。

所以，provider 差异主要体现在第 3 步；`enableOpenAILogging` 适合看“最终请求体是否带上 provider 注入字段”，但 header 和底层原始 HTTP body 仍要结合 SDK 行为理解。

## 行为矩阵

| Provider | 识别条件 | 主要请求行为 | 主要响应/解析行为 |
| --- | --- | --- | --- |
| Default | 其他都不命中 | 加 `User-Agent`；应用输出 token 默认值；合并 `extra_body`；qwen3 模型会把历史里的 `reasoning_content` 镜像到 `reasoning` | 使用通用 OpenAI response converter |
| DashScope | `authType=qwen-oauth`；无 `baseUrl`；DashScope 官方域名；`*.alibaba-inc.com` / `*.aliyun-inc.com`；或精确匹配 `DASHSCOPE_PROXY_BASE_URL` | 加 `X-DashScope-*` header；加 `metadata.sessionId/promptId/channel`；按配置加 `cache_control`；视觉模型加 `vl_high_resolution_images`；合并 `extra_body` | 仍走通用 converter；缓存统计是否显示取决于响应 usage 字段是否能被 converter 映射 |
| DeepSeek | host 是 `api.deepseek.com` 或子域名；或 model 名包含 `deepseek` | message content part 扁平化为字符串；assistant 历史补 `reasoning_content`；官方 DeepSeek host 才把 `reasoning.effort` 改成 `reasoning_effort` | 默认 temperature 为 0；禁用 thinking 时，官方 DeepSeek host 会发送 `thinking: { type: "disabled" }` |
| OpenRouter | `baseUrl` 包含 `openrouter.ai` | 加 `HTTP-Referer` 和 `X-OpenRouter-Title` | 使用通用 converter |
| ModelScope | `baseUrl` 包含 `modelscope` | 非流式请求删除 `stream_options`，避免后端不接受 | 使用通用 converter |
| MiniMax | host 为 `api.minimaxi.com` / `api.minimax.io` 或其子域名 | 继承 Default 请求行为 | 启用 `<think>` / `<thinking>` 标签解析，把 tagged thinking 识别成 thought 内容 |
| Mistral | host 为 `api.mistral.ai` 或子域名；或 model 名包含 mistral/mixtral/codestral/ministral/pixtral/magistral/devstral | 出站前删除历史消息里的非标准 `reasoning_content` | 使用通用 converter |

## DashScope 的特殊性

DashScope provider 是目前差异最大的 OpenAI-compatible provider。命中后会做几类额外操作。

### 1. 请求头

DashScope 会在默认 `User-Agent` 之外添加：

```text
X-DashScope-CacheControl: enable
X-DashScope-UserAgent: QwenCode/<version> (...)
X-DashScope-AuthType: <authType>
```

这些 header 不会出现在普通 Default provider 中。

### 2. 请求体 metadata

DashScope 会在 request body 中加入：

```json
{
  "metadata": {
    "sessionId": "...",
    "promptId": "...",
    "channel": "..."
  }
}
```

`sessionId` 来自 CLI config，`promptId` 是当前用户 prompt 的 id，`channel` 存在时才会带。

这也是 DataWorks 自定义域名问题的核心：如果 `baseUrl` 没有被识别为 DashScope provider，请求就会走 Default provider，自然不会带这些 DashScope-only metadata。

### 3. 显式缓存 cache_control

当 `generationConfig.enableCacheControl` 没有显式关掉时，DashScope provider 会给请求加 `cache_control: { type: "ephemeral" }`：

```text
非流式：
  只标记 system message

流式：
  标记 system message
  标记最后一条 message
  标记最后一个 tool definition
```

这只是告诉 DashScope “这些内容可缓存”。是否返回缓存命中，仍取决于服务端实际缓存策略和 usage 返回。

### 4. DataWorks / 内部域名

PR #4157 合入后，DashScope provider 识别规则增加了内部域名：

```text
*.alibaba-inc.com
*.aliyun-inc.com
```

因此类似下面的 `baseUrl` 会被识别为 DashScope provider：

```text
https://pre-dw.alibaba-inc.com/...
https://pre-bff.dw.alibaba-inc.com/...
https://model-gateway.aliyun-inc.com/...
```

注意它匹配的是子域名。裸域名 `https://alibaba-inc.com/...` 和 `https://aliyun-inc.com/...` 不会命中。

### 5. DASHSCOPE_PROXY_BASE_URL

`DASHSCOPE_PROXY_BASE_URL` 是一个环境变量兜底：如果请求的 `baseUrl` 与这个环境变量完全匹配，Qwen Code 也会按 DashScope provider 处理。

它和 `baseUrl` 的区别是：

```text
baseUrl:
  当前模型实际请求的 endpoint。

DASHSCOPE_PROXY_BASE_URL:
  一个额外的识别提示，告诉 qwen-code “这个具体 endpoint 虽然域名不像 DashScope，但底下就是 DashScope-compatible”。
```

它不会替代 `baseUrl`，只是参与 provider 判断。

## DeepSeek 的设计细节

DeepSeek provider 有两个层级的判断：

```text
isDeepSeekProvider:
  host 命中 api.deepseek.com，或 model 名包含 deepseek。

isDeepSeekHostname:
  只接受 api.deepseek.com 或其子域名。
```

这是防御性设计。model 名包含 `deepseek` 可以说明消息格式需要按 DeepSeek 类模型处理，例如 self-hosted DeepSeek 可能也不接受 content part array，所以可以做 content flatten。

但 `reasoning_effort`、`thinking: { type: "disabled" }` 是 DeepSeek 官方 API 的 wire shape。self-hosted OpenAI-compatible 后端未必接受这些字段，所以只有 hostname 真的是 DeepSeek 官方域名时才发送。

## Mistral / ModelScope / MiniMax 的取舍

这些 provider 的差异比较小，但都是为了解决“OpenAI-compatible 不等于完全兼容”的问题。

ModelScope 不接受非流式请求里的 `stream_options`，所以非流式时删除。

Mistral 不接受历史消息里的 `reasoning_content`，所以只在出站请求边界删除，内部历史仍保留。

MiniMax 会把 `<think>` / `<thinking>` 这类文本标签解析成 thought 内容。这是响应解析差异，不是请求体差异。

## 为什么不把所有字段都直接透传

OpenAI-compatible endpoint 的共同部分只是 Chat Completions 主干，不代表每个 provider 都接受其他 provider 的扩展字段。

典型风险：

```text
DashScope metadata / cache_control:
  非 DashScope 后端可能忽略，也可能 400。

DeepSeek reasoning_effort / thinking:
  self-hosted DeepSeek 或严格 OpenAI 后端可能不接受。

Mistral reasoning_content:
  Mistral 明确可能拒绝。

ModelScope stream_options:
  非流式时可能拒绝。
```

所以 qwen-code 的整体设计是：

```text
默认路径尽量保守；
只有识别出 provider 后，才发送该 provider 明确需要或可接受的扩展字段；
对不确定的 custom endpoint，优先通过 baseUrl / 环境变量等机制显式识别，而不是盲目透传。
```

这也是之前 DataWorks 域名 case 的本质：接口底层是 DashScope，但 qwen-code 如果无法从 `baseUrl` 识别出来，就只能按普通 OpenAI-compatible 处理。

## 缓存统计和 UI 显示

需要分清三个层面：

```text
请求层：
  是否发送了 X-DashScope-CacheControl、metadata、cache_control。

响应层：
  服务端 usage 是否返回 cached_tokens、cache_read_input_tokens、cache_creation 等字段。

展示层：
  qwen-code converter / stats UI 是否把这些字段映射并显示出来。
```

DashScope provider 只能保证请求层行为。缓存命中数字来自响应层；UI 是否出现 “Cached” 或中文缓存字样，则取决于 converter 和 stats command 当前支持哪些 usage 字段。

一个常见现象是：后端返回了某些缓存字段，但 qwen-code 只映射了其中一部分；或者后端只返回 `cached_tokens: 0`，没有返回 `cache_creation` 等字段。这时 UI 可能看不到显式缓存字样，但不能直接说明 cache_control 没有发送。

排查时建议按顺序看：

```bash
ls -lt ~/.qwen/logs ~/.qwen/debug
rg '"cache_control"|"metadata"|"cached_tokens"|"cache_read_input_tokens"|"cache_creation"' ~/.qwen/logs ~/.qwen/debug
```

如果开了 `enableOpenAILogging`，重点看 request body 里是否已经有 provider 注入后的字段：

```text
metadata
cache_control
stream_options
reasoning_effort
thinking
```

如果 request body 没有 DashScope 字段，优先怀疑 provider 没命中；如果 request body 有 DashScope 字段，但 response usage 没有缓存字段，优先看服务端和模型缓存策略。

## 添加新 provider 时的原则

新增 provider 逻辑时，尽量遵守几个原则：

1. 检测条件优先用 URL hostname，不用简单字符串包含，避免 path 伪装和误命中。
2. provider-specific body 参数只在高置信条件下发送。
3. model-name fallback 适合做“模型格式”修正，不一定适合发送“服务商 API 扩展字段”。
4. custom endpoint 如果无法靠域名稳定识别，应提供显式 opt-in 或环境变量兜底。
5. `extra_body` / `samplingParams` 是用户 escape hatch，但不应该替代 provider 对通用问题的内建兼容处理。
6. 日志捕获要放在 provider 改写之后、SDK 调用之前，才方便排查真实出站 request body。

## 快速判断一个配置会走哪个 provider

可以按这个顺序脑内模拟：

```text
1. authType 是 qwen-oauth？没有 baseUrl？DashScope。
2. baseUrl hostname 是 DashScope 官方域名、内部 Alibaba 域名，或等于 DASHSCOPE_PROXY_BASE_URL？DashScope。
3. baseUrl hostname 是 api.deepseek.com，或 model 含 deepseek？DeepSeek。
4. baseUrl 含 openrouter.ai？OpenRouter。
5. baseUrl 含 modelscope？ModelScope。
6. baseUrl hostname 是 MiniMax 官方域名或其子域名？MiniMax。
7. baseUrl hostname 是 Mistral 官方域名，或 model 含 Mistral 系列 marker？Mistral。
8. 否则 Default。
```

对 DataWorks 这类域名，在包含 #4157 的版本里，`pre-dw.alibaba-inc.com` / `pre-bff.dw.alibaba-inc.com` 会在第 2 步命中 DashScope。
