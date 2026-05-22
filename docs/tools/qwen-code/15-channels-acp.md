# Qwen Code Channels 与 ACP Bridge

> 分析版本：v0.16.0 | 分析日期：2026-05-22

## 1. 概述

Qwen Code Channels 系统允许将 Qwen Code Agent 接入多种即时通讯平台（DingTalk、Telegram、WeChat 等），使用户可以通过聊天界面与 AI Agent 交互。整体架构由三层组成：

- **Channel Adapter** — 平台适配层，处理平台特定的消息收发和格式转换
- **Channel Base** — 抽象基类，统一消息路由、权限控制、Session 管理和流式输出
- **ACP Bridge** — Agent 通信协议桥接层，通过 NDJSON 流与 `qwen --acp` 子进程通信

用户发送消息 → Channel Adapter 解析为 Envelope → ChannelBase 路由和鉴权 → AcpBridge 转发给 Agent → 响应流式回传 → Channel Adapter 格式化发送。

## 2. Channel 架构

### 2.1 Base Channel 抽象

`ChannelBase`（`packages/channels/base/src/ChannelBase.ts`）是所有 Channel 的抽象基类，定义三个必须实现的方法：

```typescript
abstract connect(): Promise<void>;      // 连接到平台
abstract sendMessage(chatId: string, text: string): Promise<void>;  // 发送消息
abstract disconnect(): void;            // 断开连接
```

可选 override 的生命周期钩子：

| 方法 | 用途 |
|------|------|
| `onPromptStart(chatId, sessionId, messageId)` | Prompt 开始处理时调用（如显示 typing 状态） |
| `onPromptEnd(chatId, sessionId, messageId)` | Prompt 完成/取消时调用 |
| `onResponseChunk(chatId, chunk, sessionId)` | 流式响应分块回调（如实时更新 AI 卡片） |
| `onResponseComplete(chatId, fullText, sessionId)` | 完整响应就绪，默认调用 `sendMessage` |

### 2.2 Channel 生命周期

1. **初始化** — 构造 `GroupGate`（群组策略）、`SenderGate`（发送者鉴权）、`SessionRouter`（会话路由）
2. **连接** — 调用 `connect()` 建立与平台的长连接
3. **消息处理** — `handleInbound(envelope)` 统一入口：
   - GroupGate 检查群消息策略
   - SenderGate 检查发送者权限
   - 解析 Slash Command（`/help`、`/clear`、`/status`）
   - SessionRouter 解析/创建 Session
   - 按 DispatchMode 处理并发消息
   - 调用 `bridge.prompt()` 获取响应
4. **关闭** — 调用 `disconnect()` 清理资源

### 2.3 Dispatch Mode（并发消息处理策略）

当同一 Session 有活跃 Prompt 时收到新消息：

| 模式 | 行为 |
|------|------|
| `collect` | 缓冲新消息，待当前 Prompt 完成后合并发送 |
| `steer` | 取消当前 Prompt，以新消息重新发起请求 |
| `followup` | 按 FIFO 队列串行处理 |

## 3. 内置 Channel 实现

### 3.1 DingTalk（钉钉）

**文件**: `packages/channels/dingtalk/src/DingtalkAdapter.ts`

- 使用 `dingtalk-stream-sdk-nodejs` 的 Stream 长连接（非 Webhook 轮询）
- 通过 `clientId` + `clientSecret` 认证（企业内部应用）
- 支持消息类型：text、richText、picture、file、audio、video
- 回复使用 `sessionWebhook` 发送 Markdown 格式消息
- 支持 Emoji Reaction（消息处理中显示眼睛表情，完成后撤回）
- 消息去重机制（5 分钟 TTL 的 msgId 缓存）
- 媒体文件通过 DingTalk downloadCode API 下载

### 3.2 Telegram

**文件**: `packages/channels/telegram/src/TelegramAdapter.ts`

- 使用 `grammy` Bot SDK，支持 long-polling
- 支持消息类型：text、photo、document、voice
- 回复使用 `telegramFormat` 转 HTML，超长消息自动分片
- 群组中支持 `@bot` mention 检测和 reply-to-bot 检测
- `onPromptStart` 时发送 typing action（每 4 秒续传，因 Telegram 5 秒过期）
- 图片/文档/语音文件下载后存入临时目录作为 attachment
- 支持 HTTP Proxy 传递给 `grammy` 的 fetch 配置

### 3.3 WeChat（微信）

**文件**: `packages/channels/weixin/src/WeixinAdapter.ts`

- 使用 iLink Bot API（HTTP 轮询模式）
- 支持文本和图片消息收发
- 提供 `[IMAGE: /path/to/file.png]` 语法让 Agent 回传图片
- CDN 媒体文件下载+解密（`downloadAndDecrypt`）
- 登录态管理通过 `accounts.ts` 持久化 token
- 内置 channel instructions 引导 Agent 输出简洁文本

### 3.4 Plugin Example

**文件**: `packages/channels/plugin-example/src/MockPluginChannel.ts`

- WebSocket 通信的示例 Channel，演示自定义 Channel 开发模式
- 定义三种消息类型：`InboundMessage`、`ChunkMessage`、`OutboundMessage`
- 支持流式 chunk 推送和最终响应分离
- 可作为第三方 Channel Plugin 开发的参考模板

## 4. ACP Bridge（Agent Communication Protocol）

系统中有两层 ACP Bridge 实现，分别服务于不同场景：

### 4.1 Channel-Level AcpBridge

**文件**: `packages/channels/base/src/AcpBridge.ts`

轻量级 Bridge，直接 spawn `qwen --acp` 子进程：

- 通过 `@agentclientprotocol/sdk` 的 `ClientSideConnection` + NDJSON Stream 通信
- 提供 `newSession()`、`loadSession()`、`prompt()`、`cancelSession()` 方法
- 监听 `sessionUpdate` 通知，解析 `agent_message_chunk`（文本流）和 `tool_call` 事件
- 自动批准权限请求（`requestPermission` → 选择 `proceed_once`）
- 支持 crash recovery：`disconnected` 事件触发重启流程

### 4.2 Daemon-Level HttpAcpBridge

**文件**: `packages/acp-bridge/src/bridgeTypes.ts`

完整 HTTP Daemon Bridge，供 `qwen serve` 使用：

- Session 生命周期管理：`spawnOrAttach`、`loadSession`、`resumeSession`、`closeSession`、`killSession`
- SSE 事件流订阅：`subscribeEvents()` 返回 `AsyncIterable<BridgeEvent>`
- 权限投票系统：`respondToPermission`、`respondToSessionPermission`
- Workspace 管理：MCP Server 状态、Skills、Providers、Preflight 诊断
- 多 Client 附着：支持同一 Session 被多个 HTTP Client 订阅

### 4.3 事件总线（EventBus）

**文件**: `packages/acp-bridge/src/eventBus.ts`

高性能 Pub/Sub 事件分发系统：

- **Monotonic ID** — 每个 Session 内事件 ID 单调递增，支持 SSE `Last-Event-ID` 断线续传
- **Replay Ring** — 环形缓冲区（默认 8000 帧），支持重连后历史事件回放
- **背压控制** — 慢订阅者超过队列上限（默认 256）时被驱逐（`client_evicted`）
- **容量告警** — 队列达到 75% 时推送 `slow_client_warning`，低于 37.5% 时重置
- **订阅者上限** — 每个 Bus 最多 64 个并发订阅者，防止 DoS 放大攻击
- **Schema Version** — `EVENT_SCHEMA_VERSION = 1`，Breaking Change 时递增

### 4.4 权限模型

**文件**: `packages/acp-bridge/src/permission.ts`

定义四种 `PermissionPolicy`（当前仅实现 `first-responder`）：

| 策略 | 行为 |
|------|------|
| `first-responder` | 第一个有效投票立即生效（当前默认） |
| `designated` | 仅发起 Prompt 的 Client 可投票 |
| `consensus` | N-of-M 法定人数投票 |
| `local-only` | 仅本地环回连接可投票 |

### 4.5 Session 管理

**SessionRouter**（`packages/channels/base/src/SessionRouter.ts`）负责 Channel 侧的 Session 路由：

- 三种 `SessionScope`：
  - `user` — 按 `channelName:senderId:chatId` 隔离（默认）
  - `thread` — 按 `channelName:threadId` 隔离
  - `single` — 所有消息共享一个 Session
- 路由映射持久化到 JSON 文件，支持 crash recovery 后恢复
- `restoreSessions()` 在 Bridge 重启后尝试 `loadSession` 恢复现有 Session

## 5. Channel 配置与注册

### 5.1 配置结构

Channel 配置位于 `settings.json` 的 `channels` 字段：

```json
{
  "channels": {
    "my-bot": {
      "type": "telegram",
      "token": "$TELEGRAM_BOT_TOKEN",
      "senderPolicy": "allowlist",
      "allowedUsers": ["123456789"],
      "sessionScope": "user",
      "cwd": "/path/to/workspace",
      "groupPolicy": "open",
      "groups": { "*": { "requireMention": true } },
      "dispatchMode": "steer",
      "blockStreaming": "on"
    }
  }
}
```

关键配置项（`ChannelConfig` 接口）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | Channel 类型标识（telegram/dingtalk/weixin） |
| `token` | string | 平台凭证，支持 `$ENV_VAR` 引用 |
| `senderPolicy` | `allowlist/pairing/open` | 发送者准入策略 |
| `sessionScope` | `user/thread/single` | Session 隔离粒度 |
| `groupPolicy` | `disabled/allowlist/open` | 群组消息策略 |
| `dispatchMode` | `collect/steer/followup` | 并发消息处理策略 |
| `blockStreaming` | `on/off` | 分块流式发送（长响应分段推送） |
| `instructions` | string | 注入 Session 首条消息的系统提示 |

### 5.2 Plugin 注册机制

**文件**: `packages/cli/src/commands/channel/channel-registry.ts`

```typescript
interface ChannelPlugin {
  channelType: string;           // 唯一类型标识
  displayName: string;           // CLI 显示名
  requiredConfigFields?: string[];  // 额外必填配置字段
  createChannel(name, config, bridge, options): ChannelBase;  // 工厂方法
}
```

注册来源：
1. **内置 Plugin** — telegram、weixin、dingtalk 通过 lazy import 自动注册
2. **Extension Plugin** — 通过 `qwen-extension.json` manifest 声明并动态加载

### 5.3 CLI 命令

```bash
qwen channel start [name]    # 启动单个/所有 Channel
qwen channel stop            # 停止服务
qwen channel status          # 查看运行状态
qwen channel pairing approve <channel> <code>  # 审批配对请求
qwen channel configure-weixin   # 配置微信账号
```

## 6. 消息格式与协议

### 6.1 Envelope（统一消息信封）

所有平台消息在进入 `handleInbound` 前统一转换为 `Envelope`：

```typescript
interface Envelope {
  channelName: string;      // Channel 实例名
  senderId: string;         // 平台用户 ID
  senderName: string;       // 用户显示名
  chatId: string;           // 会话/群组 ID
  text: string;             // 消息文本
  threadId?: string;        // 线程 ID（用于 thread scope）
  messageId?: string;       // 平台消息 ID
  isGroup: boolean;         // 是否群消息
  isMentioned: boolean;     // 是否 @bot
  isReplyToBot: boolean;    // 是否回复 bot 消息
  referencedText?: string;  // 被引用消息文本
  imageBase64?: string;     // 图片 Base64 数据
  attachments?: Attachment[];  // 附件列表
}
```

### 6.2 BlockStreamer（分块流式输出）

**文件**: `packages/channels/base/src/BlockStreamer.ts`

将 Agent 的长响应拆分为多条消息逐步推送：

- `minChars`（默认 400）— 最小发送字符数
- `maxChars`（默认 1000）— 强制分割字符数
- `idleMs`（默认 1500ms）— 空闲超时后发送缓冲内容
- 优先在段落边界（`\n\n`）分割，次选换行、空格

### 6.3 ACP 协议交互

Channel Bridge 与 Agent 子进程通过 ACP（Agent Client Protocol）NDJSON 流通信：

- `initialize` — 建立连接，协商协议版本
- `session/new` — 创建新 Session
- `session/load` — 恢复已有 Session
- `prompt` — 发送 Prompt（支持 text + image content）
- `cancel` — 取消当前 Prompt
- `sessionUpdate` 通知 — Agent → Client 的事件流（text chunk、tool call、commands update）
- `requestPermission` — Agent 请求工具执行许可

## 7. 与 Claude Code 的对比

| 维度 | Claude Code | Qwen Code Channels |
|------|-------------|-------------------|
| 多渠道接入 | 无原生支持，仅 CLI/IDE | 内置 Telegram/DingTalk/WeChat，支持插件扩展 |
| 通信协议 | 内部 stdio | ACP（Agent Client Protocol）标准协议 |
| Session 路由 | 单进程单 Session | 多 Session 路由，支持 user/thread/single scope |
| 权限控制 | 本地 TTY 确认 | SenderGate + GroupGate + Pairing Code 机制 |
| 并发处理 | 无（单用户） | 三种 Dispatch Mode（collect/steer/followup） |
| 流式输出 | 终端逐字符 | BlockStreamer 分段消息 + chunk 实时回调 |
| Crash Recovery | 无 | Bridge 断线重连 + Session 持久化恢复 |
| 事件总线 | 无 | EventBus（replay ring + backpressure + SSE） |
| 部署模式 | 本地 CLI | `qwen channel start` 守护进程 / `qwen serve` Daemon |

## 8. 相关代码索引

| 模块 | 路径 |
|------|------|
| Channel Base 抽象 | `packages/channels/base/src/ChannelBase.ts` |
| 类型定义 | `packages/channels/base/src/types.ts` |
| Session 路由 | `packages/channels/base/src/SessionRouter.ts` |
| 群组策略门控 | `packages/channels/base/src/GroupGate.ts` |
| 发送者策略门控 | `packages/channels/base/src/SenderGate.ts` |
| 分块流式输出 | `packages/channels/base/src/BlockStreamer.ts` |
| Channel AcpBridge | `packages/channels/base/src/AcpBridge.ts` |
| Daemon Bridge | `packages/channels/base/src/DaemonChannelBridge.ts` |
| DingTalk Adapter | `packages/channels/dingtalk/src/DingtalkAdapter.ts` |
| Telegram Adapter | `packages/channels/telegram/src/TelegramAdapter.ts` |
| WeChat Adapter | `packages/channels/weixin/src/WeixinAdapter.ts` |
| Plugin Example | `packages/channels/plugin-example/src/MockPluginChannel.ts` |
| Channel Registry | `packages/cli/src/commands/channel/channel-registry.ts` |
| CLI Start 命令 | `packages/cli/src/commands/channel/start.ts` |
| 配置解析 | `packages/cli/src/commands/channel/config-utils.ts` |
| ACP Bridge 包入口 | `packages/acp-bridge/src/index.ts` |
| EventBus | `packages/acp-bridge/src/eventBus.ts` |
| Permission 模型 | `packages/acp-bridge/src/permission.ts` |
| Bridge 类型定义 | `packages/acp-bridge/src/bridgeTypes.ts` |
| Bridge 配置选项 | `packages/acp-bridge/src/bridgeOptions.ts` |
| Channel 工厂接口 | `packages/acp-bridge/src/channel.ts` |
