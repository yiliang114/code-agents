# Qwen Code 架构文档（面向贡献者和开发者）

> Qwen Code 是阿里云 Qwen 团队的开源 AI 编程代理（Apache-2.0），基于 Gemini CLI fork 并大幅增强。本系列文档面向**项目贡献者和开发者**——了解当前架构、已知差距和改进方向。
>
> **源码**：[github.com/QwenLM/qwen-code](https://github.com/QwenLM/qwen-code)

## 文档索引

| 文档 | 内容 |
|------|------|
| [01-概述](./01-overview.md) | 核心能力、13 个包、与上游差异、已知差距 |
| [02-命令](./02-commands.md) | 41 命令 + CLI 参数 |
| [03-架构](./03-architecture.md) | Agent Loop、Arena、CoreToolScheduler、多 Provider、Goals、Channels |
| [04-工具](./04-tools.md) | 30+ 核心工具 + MCP 动态工具 |
| [05-设置](./05-settings.md) | 7 层配置 + Hook 系统 |
| [06-扩展](./06-extensions.md) | 三格式扩展兼容 |
| [07-Hooks](./07-hooks.md) | 16 事件类型、4 种 Runner、安全机制 |
| [08-记忆](./08-memory.md) | Extract/Recall/Dream/Forget 全生命周期 |
| [09-多 Agent](./09-multi-agent.md) | Agent Runtime、3 后端、Arena、SubagentManager |
| [10-Session](./10-session.md) | Session 生命周期、Worktree Session、Background Resume |
| [11-MCP](./11-mcp.md) | 4 种传输、3 个 Auth Provider、动态工具加载 |
| [12-Goals](./12-goals.md) | Stop Hook + LLM Judge 目标驱动执行 |
| [13-Provider](./13-providers.md) | 10 个 Preset、识别链路、OAuth2 PKCE |
| [14-遥测](./14-telemetry.md) | OpenTelemetry 双通道、6 层 Span、40+ 指标 |
| [15-Channels/ACP](./15-channels-acp.md) | DingTalk/Telegram/WeChat、ACP Bridge |
| [16-压缩](./16-compression.md) | 三层压缩架构、OOM 分析、structuredClone |
| [17-权限](./17-permissions.md) | 双阶段 LLM 分类器、Shell Semantics、DenialTracking |
| [18-LSP](./18-lsp.md) | 原生 LSP 客户端、12 操作、JSON-RPC 2.0 |
| [19-SDK](./19-sdk.md) | TypeScript/Python/Java 三套 SDK |
| [20-推测执行](./20-followup-speculation.md) | Speculation Engine、OverlayFs COW、SuggestionGenerator |

## 当前状态速查（v0.16.0）

| 维度 | Qwen Code 现状 | vs Claude Code | vs 上游 Gemini CLI |
|------|----------------|---------------|-------------------|
| 工具数 | 30+ | 42（差距缩小） | 23（已超越） |
| 命令数 | ~41 | ~79（差 38） | ~41（接近） |
| Hook 事件 | 16 | 27（差 11） | 11（已超越） |
| 上下文压缩 | 三层（micro+auto+heap） | 5 层递增 | 单阈值 50% |
| 记忆系统 | Extract/Recall/Dream/Forget | CLAUDE.md + Auto Dream | GEMINI.md |
| 安全 | 双阶段 LLM 分类器 + Shell AST | 沙箱 + 23 项检查 | sandbox + 环境变量净化 |
| 多 Agent | Arena + SubagentManager + 3 后端 | Coordinator/Swarm + Kairos | A2A + Subagent |
| 多渠道 | DingTalk/Telegram/WeChat + ACP | 无 | 无 |
| Goals | Stop Hook + LLM Judge | 无等价物 | 无 |
| SDK | TypeScript + Python + Java | TypeScript + Python | 无 |
| 推测执行 | Speculation + OverlayFs | 类似（无 OverlayFs） | 无 |
| 渲染 | 标准 Ink（闪烁） | 自建 Ink fork（无闪烁） | SlicingMaxSizedBox |

## 改进报告

- [**Claude Code 对比改进报告**](../../comparison/qwen-code-improvement-report.md)——240 项改进建议，22 个社区 PR 追踪
- [**Gemini CLI 上游 backport 报告**](../../comparison/qwen-code-gemini-upstream-report.md)——42 项可 backport 改进
- [**/review 功能改进建议**](../../comparison/qwen-code-review-improvements.md)——9 项改进（P0 确定性分析 ~ P3 报告持久化）
- [**工具输出限高防闪烁**](../../comparison/tool-output-height-limiting-deep-dive.md)——Gemini CLI vs Qwen Code 渲染对比

## 活跃 PR 进展（22 个追踪中）

已合并：#2525 ✓（Speculation）、#2854 ✓（Mid-Turn Queue Drain）、#2889 ✓（危险操作指导）

关键 open PR：#2936（Fork Subagent）、#2932（/review 增强）、#2886（Agent Team）、#2921（/plan）
