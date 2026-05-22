# Qwen Code Provider 系统

> 分析版本：v0.16.0 | 分析日期：2026-05-22

## 1. 概述（多 Provider 架构）

Qwen Code 采用多 Provider 架构，支持同时配置和切换多种 LLM 服务提供商。与 Claude Code 仅绑定 Anthropic 单一 Provider 不同，Qwen Code 将 Provider 抽象为两层：

- **配置层（Provider Presets）**：定义 Provider 的元数据、baseUrl、模型列表、环境变量名等，位于 `packages/core/src/providers/presets/`
- **运行时层（OpenAI Compatible Provider）**：在请求发送前根据 baseUrl/model 动态识别 Provider 类型，注入 Provider 特定的 headers、body 改写、响应解析策略，位于 `packages/core/src/core/openaiContentGenerator/provider/`

所有 Provider 统一使用 OpenAI Chat Completions 兼容协议通信（AuthType.USE_OPENAI），少数场景支持 Anthropic/Gemini 协议。

## 2. Provider 配置模型

### Provider 接口定义

核心接口 `ProviderConfig` 定义于 `packages/core/src/providers/types.ts`：

```typescript
export interface ProviderConfig {
  id: string;                    // 唯一标识符，如 'coding-plan'
  label: string;                 // UI 显示名称
  description: string;           // 描述文字
  protocol: AuthType;            // 通信协议，通常为 AuthType.USE_OPENAI
  baseUrl?: string | BaseUrlOption[];  // 固定 URL / 多区域选项 / undefined（用户自由输入）
  envKey: string | ((protocol: AuthType, baseUrl: string) => string);  // 环境变量 key
  models?: ModelSpec[];          // 预定义模型列表
  modelsEditable?: boolean;      // 用户是否可编辑模型列表
  modelNamePrefix: string | ((baseUrl: string) => string);  // 模型展示名前缀
  protocolOptions?: AuthType[];  // 协议选项（Custom Provider 专用）
  showAdvancedConfig?: boolean;  // 是否展示高级配置
  validateApiKey?: (key: string, baseUrl: string) => string | null;
  ownsModel?: (model: ProviderModelConfig) => boolean;  // 判断模型归属
  uiGroup?: string;             // UI 分组：'alibaba' | 'third-party' | 'custom'
}
```

### 配置 Schema

每个模型通过 `ModelSpec` 定义：

```typescript
export interface ModelSpec {
  id: string;                        // 模型 ID，如 'qwen3.5-plus'
  contextWindowSize?: number;        // 上下文窗口大小
  enableThinking?: boolean;          // 是否启用 thinking/reasoning
  modalities?: InputModalities;      // 支持的输入模态（image/video/audio/pdf）
  description?: string;              // 模型描述
}
```

安装计划通过 `ProviderInstallPlan` 描述，包含环境变量设置、模型列表合并策略、认证类型切换等。

## 3. 内置 Provider Presets

Provider 注册表定义于 `all-providers.ts`，按展示顺序排列：

### 3.1 Coding Plan（阿里云百炼 Coding 套餐）

| 属性 | 值 |
|------|-----|
| ID | `coding-plan` |
| envKey | `BAILIAN_CODING_PLAN_API_KEY` |
| baseUrl | 中国（`coding.dashscope.aliyuncs.com/v1`）/ 国际（`coding-intl.dashscope.aliyuncs.com/v1`） |
| 模型 | qwen3.5-plus, qwen3.6-plus, glm-5, kimi-k2.5, MiniMax-M2.5, qwen3-coder-plus 等 |
| 特点 | 面向个人开发者，含周免费额度；apiKey 以 `sk-sp-` 开头 |

### 3.2 Token Plan（阿里云百炼 Token 套餐）

| 属性 | 值 |
|------|-----|
| ID | `token-plan` |
| envKey | `BAILIAN_TOKEN_PLAN_API_KEY` |
| baseUrl | `token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`（固定） |
| 模型 | qwen3.6-plus, deepseek-v3.2, glm-5, MiniMax-M2.5 |
| 特点 | 面向团队/企业，按量付费 |

### 3.3 Standard API Key（阿里云百炼标准 Key）

| 属性 | 值 |
|------|-----|
| ID | `alibabaStandard` |
| envKey | `DASHSCOPE_API_KEY` |
| baseUrl | 北京 / 新加坡 / 美东 / 香港 四个区域 |
| 模型 | qwen3.6-plus, glm-5.1, deepseek-v4-pro, deepseek-v4-flash |
| 特点 | 使用已有百炼 API Key 直接接入 |

### 3.4 DeepSeek

| 属性 | 值 |
|------|-----|
| ID | `deepseek` |
| envKey | `DEEPSEEK_API_KEY` |
| baseUrl | `https://api.deepseek.com`（固定） |
| 模型 | deepseek-v4-pro（thinking）, deepseek-v4-flash |
| 特点 | 第三方 Provider；运行时层有独立 body 改写逻辑 |

### 3.5 OpenRouter

| 属性 | 值 |
|------|-----|
| ID | `openrouter` |
| envKey | `OPENROUTER_API_KEY` |
| baseUrl | `https://openrouter.ai/api/v1`（固定） |
| 模型 | z-ai/glm-4.5-air:free, openai/gpt-oss-120b:free |
| 特点 | ownsModel 通过 hostname + envKey 双重验证 |

### 3.6 ModelScope

| 属性 | 值 |
|------|-----|
| ID | `modelscope` |
| envKey | `MODELSCOPE_API_KEY` |
| baseUrl | `https://api-inference.modelscope.cn/v1`（固定） |
| 模型 | deepseek-ai/DeepSeek-V4-Flash, Qwen/Qwen3.5-397B-A17B, ZhipuAI/GLM-5.1 |
| 特点 | 非流式请求时移除 `stream_options` 参数 |

### 3.7 MiniMax

| 属性 | 值 |
|------|-----|
| ID | `minimax` |
| envKey | `MINIMAX_API_KEY` |
| baseUrl | 国际（`api.minimax.io/v1`）/ 中国（`api.minimaxi.com/v1`） |
| 模型 | MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5, MiniMax-M2.5-highspeed |
| 特点 | 使用 tagged thinking 解析模式 |

### 3.8 Idealab（阿里内部）

| 属性 | 值 |
|------|-----|
| ID | `idealab` |
| envKey | `IDEALAB_API_KEY` |
| baseUrl | `https://idealab.alibaba-inc.com/api/openai/v1`（固定） |
| 模型 | Qwen3.6-Plus-DogFooding, bailian/deepseek-v4-pro, bailian/kimi-k2.6 |
| 特点 | 阿里内部 LLM 服务，DogFooding 专用 |

### 3.9 Z.AI（智谱）

| 属性 | 值 |
|------|-----|
| ID | `zai` |
| envKey | `ZAI_API_KEY` |
| baseUrl | Standard API（`api.z.ai/api/paas/v4`）/ Coding Plan（`api.z.ai/api/coding/paas/v4`） |
| 模型 | GLM-5.1, GLM-5, GLM-5-Turbo |
| 特点 | 支持标准 Key 和 Coding Plan 两种接入方式 |

### 3.10 Custom Provider

| 属性 | 值 |
|------|-----|
| ID | `custom-openai-compatible` |
| envKey | `generateCustomEnvKey(protocol, baseUrl)` — 动态生成 |
| baseUrl | 用户自由输入 |
| 模型 | 用户自定义 |
| 特点 | 支持 OpenAI/Anthropic/Gemini 三种协议；envKey 通过 SHA-256 hash 生成确保唯一性；ownsModel 通过 `QWEN_CUSTOM_API_KEY_` 前缀匹配 |

## 4. Provider 识别链路

运行时 Provider 检测由 `determineProvider()` 函数实现（`openaiContentGenerator/index.ts`），按固定优先级顺序匹配：

```
1. DashScope   → isDashScopeProvider()
2. DeepSeek    → isDeepSeekProvider()
3. MiMo        → isMiMoProvider()
4. OpenRouter  → isOpenRouterProvider()
5. ModelScope  → isModelScopeProvider()
6. MiniMax     → isMiniMaxProvider()
7. Mistral     → isMistralProvider()
8. Default     → 兜底
```

各 Provider 的检测逻辑：

| Provider | hostname 匹配 | model name 匹配 | authType 匹配 |
|----------|---------------|-----------------|----------------|
| DashScope | `dashscope*.aliyuncs.com`, `*.alibaba-inc.com`, `*.aliyun-inc.com`, 或 proxy 匹配 | - | `QWEN_OAUTH` 直接命中 |
| DeepSeek | `api.deepseek.com` | model 包含 `deepseek` | - |
| MiMo | `*.xiaomimimo.com` | model 以 `mimo-` 开头 | - |
| OpenRouter | baseUrl 包含 `openrouter.ai` | - | - |
| ModelScope | baseUrl 包含 `modelscope` | - | - |
| MiniMax | `api.minimaxi.com`, `api.minimax.io`, 或 `*.minimaxi.com`/`*.minimax.io` | - | - |
| Mistral | `api.mistral.ai` | model 包含 mistral/mixtral/codestral/ministral/pixtral/magistral/devstral | - |

**重要：** DashScope 优先级最高。没有 baseUrl 时默认走 DashScope。`QWEN_OAUTH` authType 直接匹配 DashScope。

## 5. 请求改写行为

### 通用请求构建流程（DefaultOpenAICompatibleProvider）

1. 设置 `User-Agent: QwenCode/{version} ({platform}; {arch})`
2. 应用 output token limit（capped default 8K，已知模型 cap 到模型上限）
3. 对 Qwen3 系列模型：mirror `reasoning_content` → `reasoning` 字段
4. 合并 `extra_body` 配置

### Provider-specific 改写

| Provider | Headers | Body 改写 | 响应解析 |
|----------|---------|-----------|----------|
| **DashScope** | `X-DashScope-CacheControl: enable`, `X-DashScope-UserAgent`, `X-DashScope-AuthType` | 添加 `cache_control` 到 system/last message 和 tools；vision 模型加 `vl_high_resolution_images: true`；注入 `metadata`（sessionId, promptId, channel） | 默认 |
| **DeepSeek** | 默认 | 将 `reasoning.effort` 转换为 `reasoning_effort`（仅 DeepSeek hostname）；flatten content parts 为纯文本；确保 assistant 消息有 `reasoning_content` | 默认 |
| **MiMo** | 默认 | 确保 assistant 消息有 `reasoning_content`；`splitToolMedia: true` | 默认 |
| **OpenRouter** | `HTTP-Referer: https://github.com/QwenLM/qwen-code.git`, `X-OpenRouter-Title: Qwen Code` | 默认 | 默认 |
| **ModelScope** | 默认 | 非流式时删除 `stream_options` | 默认 |
| **MiniMax** | 默认 | 默认 | `taggedThinkingTags: true`（解析 tagged thinking 格式） |
| **Mistral** | 默认 | 删除 `reasoning_content` 字段（Mistral 拒绝非标准字段） | 默认 |

## 6. Qwen OAuth2 认证

### OAuth2 Device Flow + PKCE

Qwen Code 实现了基于 RFC 8628 Device Authorization Grant + RFC 7636 PKCE 的认证流程：

```
┌─────────┐                    ┌──────────────┐                  ┌─────────┐
│  Client │                    │ chat.qwen.ai │                  │ Browser │
└────┬────┘                    └──────┬───────┘                  └────┬────┘
     │  1. generatePKCEPair()         │                               │
     │  2. POST /device/code          │                               │
     │     {client_id, scope,         │                               │
     │      code_challenge, S256}     │                               │
     │────────────────────────────────>│                               │
     │  {device_code, user_code,      │                               │
     │   verification_uri_complete}   │                               │
     │<────────────────────────────────│                               │
     │  3. open(verification_uri)     │                               │
     │────────────────────────────────────────────────────────────────>│
     │  4. Poll POST /token           │                               │
     │     {grant_type=device_code,   │  5. User authorizes           │
     │      device_code,              │<──────────────────────────────│
     │      code_verifier}            │                               │
     │────────────────────────────────>│                               │
     │  {access_token, refresh_token, │                               │
     │   expires_in, resource_url}    │                               │
     │<────────────────────────────────│                               │
```

关键端点：
- Device Code: `https://chat.qwen.ai/api/v1/oauth2/device/code`
- Token: `https://chat.qwen.ai/api/v1/oauth2/token`
- Client ID: `f0304373b74a44d2b584a3fb70ca9e56`
- Scope: `openid profile email model.completion`

### SharedTokenManager

`SharedTokenManager` 是跨进程/跨 session 的 token 管理器（singleton 模式）：

- **文件缓存**：token 持久化到 `~/.qwen/oauth_creds.json`（权限 0o600）
- **内存缓存**：带 mtime 检查，5s 间隔检测文件变更
- **分布式锁**：通过 `oauth_creds.lock` 文件锁防止多进程并发刷新
- **锁超时**：10s 自动释放 stale lock
- **原子写入**：先写 `.tmp.{pid}.{uuid}`，再 `rename` 到目标位置

### Token 刷新策略

1. 过期前 30s（`TOKEN_REFRESH_BUFFER_MS`）主动刷新
2. 获取锁后先 double-check 文件（可能其他进程已刷新）
3. 调用 `refreshAccessToken()`，使用 `refresh_token` 换取新 `access_token`
4. 400/401 响应时清除凭据，抛出 `CredentialsClearRequiredError`
5. `resource_url` 字段用于动态路由到不同 DashScope endpoint

## 7. Provider 安装与管理

### /connect 命令流程

1. 用户选择 Provider（按 uiGroup 分组展示：alibaba / third-party / custom）
2. 根据 `shouldShowStep()` 判断需要的步骤：
   - `protocol`：仅 Custom Provider（有多个 protocolOptions 时）
   - `baseUrl`：有多区域选项或 undefined 时
   - `apiKey`：始终需要
   - `models`：无预定义模型或 `modelsEditable: true` 时
   - `advancedConfig`：`showAdvancedConfig: true` 时（Custom Provider）
3. 收集 `ProviderSetupInputs`
4. 调用 `buildInstallPlan()` 生成安装计划
5. 调用 `applyProviderInstallPlan()` 执行安装

### provider-config 持久化

`applyProviderInstallPlan()` 按步骤写入 settings：

```
1. env.{ENV_KEY} = apiKey                    // 环境变量
2. modelProviders.openai = [...]             // 模型列表（prepend-and-remove-owned）
3. security.auth.selectedType = 'openai'     // 认证类型
4. model.name = firstModelId                 // 默认模型
5. providerMetadata.{providerId}.version = hash  // 版本追踪
6. providerMetadata.{providerId}.baseUrl = url   // baseUrl 记录
```

合并策略 `prepend-and-remove-owned`：先用 `ownsModel()` 移除属于该 Provider 的旧模型条目，再将新模型列表 prepend 到最前面。

安全机制：
- 拒绝设置危险环境变量（NODE_OPTIONS, LD_PRELOAD, PATH 等）
- 失败时完整 rollback（settings restore + 环境变量还原 + 内存状态还原）

## 8. 与 Claude Code 的对比（单 Provider vs 多 Provider）

| 维度 | Claude Code | Qwen Code |
|------|-------------|-----------|
| Provider 数量 | 仅 Anthropic | 10+ 内置 + 无限 Custom |
| 协议 | Anthropic Messages API | OpenAI Chat Completions（兼容协议） |
| 认证方式 | OAuth2（Anthropic 专有） | OAuth2 Device Flow + API Key（多种） |
| 运行时适配 | 不需要 | 按 hostname/model 动态选择 Provider 类 |
| 模型管理 | 无需用户管理 | 用户可编辑模型列表 |
| 请求改写 | Anthropic 原生 | Provider-specific headers/body/parsing |
| baseUrl 配置 | 固定 | 多区域选项 / 用户自定义 |
| 缓存策略 | Anthropic 原生 cache_control | DashScope 模拟 Anthropic 格式的 cache_control |
| Token 管理 | Anthropic 托管 | SharedTokenManager 跨进程文件锁机制 |

## 9. 相关代码索引

| 文件路径 | 说明 |
|----------|------|
| `packages/core/src/providers/types.ts` | Provider 配置类型定义 |
| `packages/core/src/providers/all-providers.ts` | Provider 注册表（展示顺序） |
| `packages/core/src/providers/provider-config.ts` | buildInstallPlan、providerMatchesCredentials 等核心逻辑 |
| `packages/core/src/providers/install.ts` | applyProviderInstallPlan 安装执行器 |
| `packages/core/src/providers/presets/*.ts` | 各 Provider 预设配置 |
| `packages/core/src/core/openaiContentGenerator/index.ts` | `determineProvider()` — 运行时 Provider 选择 |
| `packages/core/src/core/openaiContentGenerator/provider/default.ts` | DefaultOpenAICompatibleProvider 基类 |
| `packages/core/src/core/openaiContentGenerator/provider/dashscope.ts` | DashScope 特定逻辑（cache_control, metadata, vision） |
| `packages/core/src/core/openaiContentGenerator/provider/deepseek.ts` | DeepSeek 适配（content flatten, reasoning_effort 转换） |
| `packages/core/src/core/openaiContentGenerator/provider/openrouter.ts` | OpenRouter headers |
| `packages/core/src/core/openaiContentGenerator/provider/minimax.ts` | MiniMax tagged thinking |
| `packages/core/src/core/openaiContentGenerator/provider/mistral.ts` | Mistral reasoning_content 剥离 |
| `packages/core/src/core/openaiContentGenerator/provider/modelscope.ts` | ModelScope stream_options 处理 |
| `packages/core/src/core/openaiContentGenerator/provider/mimo.ts` | MiMo reasoning_content + splitToolMedia |
| `packages/core/src/qwen/qwenOAuth2.ts` | OAuth2 Device Flow + PKCE 实现 |
| `packages/core/src/qwen/sharedTokenManager.ts` | 跨进程 token 管理（文件锁、缓存、刷新） |
| `packages/core/src/qwen/qwenContentGenerator.ts` | QwenContentGenerator — OAuth token 动态注入 |
| `packages/core/src/core/contentGenerator.ts` | AuthType 枚举定义 |
