# 1. 功能对比矩阵

本文档提供 Code Agent CLI 工具的详细横向对比。

> **2026-04-13 新增 Hermes Agent**（第 19 款）—— Nous Research 的自我改进代理，核心卖点是**闭环学习系统**（冻结快照 Memory + 自主 Skill + FTS5 跨会话搜索 + 双计数器 Nudge）。详见 [Hermes Agent 文档](../tools/hermes-agent/) 和 [闭环学习系统深度对比](./closed-learning-loop-deep-dive.md)。
>
> **2026-05-07 增量更新**：
> - **Claude Code v2.1.132**（2026-05-06）：默认模型 Opus 4.6 → **Opus 4.7**（Max/Team Premium）+ 新 `xhigh` effort level + 5 个云端新特性（Computer Use / Auto Mode / Ultraplan / Ultrareview / Routines）+ 7 个新斜杠命令 + Conditional `if` Hooks + native binaries。详见 [Claude Code §23 近期更新](../tools/claude-code/23-recent-updates.md)
> - **Qwen Code v0.15.9**（2026-05-08 release，PR#3971）：4 kinds Background tasks framework（agent/shell/monitor/dream）全落地 + **🌟 PR#3909 LiveAgentPanel**（移除 inline AgentExecutionDisplay，新增 always-on panel 锚定输入框 footer 下方 · 直接 port Claude `CoordinatorTaskPanel` 模式 · 视觉规范逐字 port） + **PR#3919 LiveAgentPanel ownership filter follow-up** + foreground subagents 也接入 pill+dialog（PR#3768）+ subagent context auto-compact（PR#3735）+ subagent Config 真正隔离（PR#3873 + PR#3887 + **PR#3892 第三 wrapper site 闭合**）+ **PR#3707 per-agent ContentGenerator view via AsyncLocalStorage**（不同 model 的 subagent 看到正确 modality table）+ transcript-first fork resume（PR#3739，比 Claude Code 更稳健）+ **🌟 PR#3539 `/branch` (`/fork` alias) session 分支**（2026-05-08 MERGED · +1538/-18 · slash 命令 + JSONL 完整复制 + 每记录 stamp `forkedFrom` + 原子 create + rollback-safe swap，对标 Claude `--fork-session` flag）+ **PR#3894 foreground → background promote 集成**（Phase D part (b)，PR-2 of 3 #3831）+ **PR#3880 searchable `/resume` picker**（free-text 搜 title/prompt/git branch + j/k preview/branch toggle）+ **PR#3956 subagent approval banner 显示 tool details**（compactMode 修复）+ **🌟 PR#3115 AI commit attribution 独家**（+7075 · 自动记录 AI 贡献到 `git notes refs/notes/ai-attribution` · per-file aiChars/humanChars 追踪 · 不污染 commit message · 满足 OSS 披露 / 企业合规审计需求 · 4 方独家）。详见 [SubAgent 展示 Deep-Dive](./subagent-display-deep-dive.md)
>
> **2026-05-27 v0.16.0 → v0.16.1 + 后续增量更新**（含 daemon 系列 / TUI 改进 / 核心 LLM 链路）：
> - **🌟 [PR#4151](https://github.com/QwenLM/qwen-code/pull/4151) Auto approval mode + LLM classifier** (LaZzyMan, +5204/-61, MERGED 2026-05-20)：新 `auto` approval mode 用 LLM classifier 判断危险操作，让 normal mode 在保留安全感的同时减 manual approval 频次
> - **🌟 [PR#4287](https://github.com/QwenLM/qwen-code/pull/4287) /auth 重构为 "Connect a Provider"** (pomelo-nwu, +3987/-5304, MERGED 2026-05-20)：6+ provider 配置 unify 到 core，`/auth` UX 简化为 connector-pattern
> - **🌟 [PR#4286](https://github.com/QwenLM/qwen-code/pull/4286) structuredClone → shallow copy 长会话 OOM 修复** (yiliang114, +4184/-487, MERGED 2026-05-21)：长会话历史 deep-clone 改 shallow copy 避免 OOM
> - **⚠️ [PR#4345](https://github.com/QwenLM/qwen-code/pull/4345) 三档梯度 auto-compaction BREAKING** (LaZzyMan, +4076/-227, MERGED 2026-05-25)：单 70% 阈值 → `warn`/`auto`/`hard` 三档 ladder + hard-tier API 拒绝前 force rescue；`chatCompression.contextPercentageThreshold` 设置移除；详 [Context Compression Deep-Dive §六](./context-compression-deep-dive.md#%EF%B8%8F-v0162-%E9%87%8D%E5%A4%A7%E6%9B%B4%E6%96%B0%E4%B8%89%E6%A1%A3%E6%A2%AF%E5%BA%A6%E9%98%88%E5%80%BCpr4345-merged-2026-05-25)
> - **🌟 [PR#3900](https://github.com/QwenLM/qwen-code/pull/3900) NotebookEdit tool for Jupyter** (zhangxy-zju, +2862/-112, MERGED 2026-05-20)：Jupyter notebook 编辑工具，对标 Claude NotebookEdit
> - **🌟 [PR#4477](https://github.com/QwenLM/qwen-code/pull/4477) InlineParallelAgentsDisplay + LiveAgentPanel 键盘导航** (wenshao, +809/-95, MERGED 2026-05-26)：`/review` 9-agent fan-out 密集面板（替代 `Agent × 9` 折叠）+ LiveAgentPanel ↓↑Enter键盘路径；详 [SubAgent 展示 Deep-Dive §六.14](./subagent-display-deep-dive.md#%E5%B7%B2%E8%90%BD%E5%9C%B0-14inline-dense-panel--liveagentpanel-keyboard-navpr4477-2026-05-26)
> - **🌟 [PR#3828](https://github.com/QwenLM/qwen-code/pull/3828) standalone hosted installer** (yiliang114, +8174/-303, MERGED 2026-05-21)：standalone 安装 / 卸载 flow
> - **🌟 daemon 系列 1 周内 MERGED 20+ PR**（详 [Qwen Code Daemon 设计](./qwen-code-daemon-design/)）：F2 cleanup B (#4460) / F4 prereq (#4360) / /recap route (#4504) / --allow-origin CORS T2.4 (#4527) / prompt deadline + writer idle T2.9 (#4530) / daemon file logger (#4559) / side-channel #4511 A1 (#4546) + A4 (#4539) / chiga0 cross-client sync (#4484/#4510) / ytahdn web-shell (#4380/#4573) / F5 release chain PR 27 (#4473) + PR 30a (#4483) / **chiga0 ACP HTTP transport (#4472) [RFD #721]** / **chiga0 non-blocking POST /prompt 返 202 (#4585)** / **daemon `!` shell (#4576) / `/tasks` snapshot (#4578) / `followup_suggestion` SSE (#4507)** / **jifeng `qwen-serve-bridge` MCP server (#4555)** —— Wave plan 名义进度 22.75/31 ≈ 73%
>
> **2026-05-29 v0.16.x 周末批次（含主线 + daemon）**：
> - **🌟 [PR#4381](https://github.com/QwenLM/qwen-code/pull/4381) worktree Phase D — `--worktree` startup flag + symlinkDirectories + PR refs** (LaZzyMan, +3719/-75, MERGED 2026-05-27 09:04)：worktree 系统进展，启动时即可创 worktree，配 symlinkDirectories 复制特定子目录到 worktree，支持 PR ref 拉取
> - **🌟 [PR#4379](https://github.com/QwenLM/qwen-code/pull/4379) Feishu (Lark) channel adapter** (yuanyuanAli, +3961/-30, MERGED 2026-05-28 12:11)：新增飞书 channel 适配器（与已有 DingTalk / WeChat / Telegram 并列）
> - **🌟 [PR#4386](https://github.com/QwenLM/qwen-code/pull/4386) `command substitution ask not deny`** (LaZzyMan, +670/-54, MERGED 2026-05-27 09:06, 关 #4093)：之前 hard-deny shell command substitution，现改 `ask` —— 用户可以批准；Jerry2003826 突击的同款 PR#4523 因此 close
> - **🌟 [PR#4547](https://github.com/QwenLM/qwen-code/pull/4547) 默认开 auto-dream/auto-skill + `/memory` toggle** (LaZzyMan, +151/-13, MERGED 2026-05-27 09:25)：行为变化：auto-dream / auto-skill 现默认 on（之前 opt-in）+ `/memory` 命令加 toggle 子命令
> - **🌟 [PR#4544](https://github.com/QwenLM/qwen-code/pull/4544) 拖放多个文件路径自动加 `@`** (MikeWang0316tw, +498/-15, MERGED 2026-05-27 06:06)：粘贴或拖放多个文件路径时自动 prepend `@` 触发 file-injection；与 PR#4487 "require whitespace before @" 配套
> - **🌟 [PR#4567](https://github.com/QwenLM/qwen-code/pull/4567) 把 new app prompt 从 system prompt 移到 skill** (DennisYu07, +62/-256)：精简 system prompt，移到按需 skill；MERGED 2026-05-27 06:57
> - [PR#4461](https://github.com/QwenLM/qwen-code/pull/4461) startup warnings 在 TUI render 前显示 stderr (kagura-agent, #4448 修复)
> - [PR#4482](https://github.com/QwenLM/qwen-code/pull/4482) telemetry LogToSpan bridge error info + TUI handling (doudouOUC)
> - [PR#4499](https://github.com/QwenLM/qwen-code/pull/4499) telemetry attach interaction span to session root context (doudouOUC)
> - [PR#4427](https://github.com/QwenLM/qwen-code/pull/4427) install-qwen-standalone.bat CRLF 存储标准化 (wenshao)
> - Jerry2003826 第 6 / 7 个 MERGED PR：[PR#4517](https://github.com/QwenLM/qwen-code/pull/4517) refresh raw model-derived defaults (his 2026-05-25 burst-period PR finally merged)
> - **核心稳定性**：[PR#4366](https://github.com/QwenLM/qwen-code/pull/4366) AbortSignal listener 泄露修复（长会话 MaxListenersExceededWarning）+ [PR#4470](https://github.com/QwenLM/qwen-code/pull/4470) text buffer race + [PR#4176](https://github.com/QwenLM/qwen-code/pull/4176) tool_use↔tool_result invariant 全失败路径
> - **遥测 telemetry #3731 line**：[PR#4321](https://github.com/QwenLM/qwen-code/pull/4321) Phase 2 (tool.blocked_on_user + hook spans) + [PR#4367](https://github.com/QwenLM/qwen-code/pull/4367) custom resource attributes + metric cardinality (BREAKING `session.id` 默认不在 metric) + [PR#4417](https://github.com/QwenLM/qwen-code/pull/4417) Phase 4a TTFT capture + [PR#4390](https://github.com/QwenLM/qwen-code/pull/4390) client-side HTTP span + W3C traceparent
> - **headless / SDK 改进**：[PR#4502](https://github.com/QwenLM/qwen-code/pull/4502) headless / non-interactive runaway-protection (BZ-D, #4103) + [PR#4491](https://github.com/QwenLM/qwen-code/pull/4491) SDK `canUseTool` timeout in CLI control requests
> - **release**：v0.16.0 (PR#4404) + v0.16.1 (PR#4467) 已发布

## 快速参考表

| 功能 | Claude Code | Aider | Copilot CLI | SWE-agent | Cline | Goose | OpenCode | Continue | Warp | Gemini CLI | OpenHands | Cursor | Qwen Code | Kimi CLI | Hermes |
|---------|------------|-------|-------------|-----------|-------|-------|----------|----------|------|------------|----------|--------|-----------|----------|--------|
| **开源** | | ✓ | | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | | ✓ | ✓ | ✓ |
| **免费层级** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **多模型** | | ✓ | | ✓ | | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Git 集成** | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ | |
| **MCP 支持** | ✓ | | | | ✓ | ✓ | ✓ | | ✓ | ✓ | | ✓ | ✓ | ✓ | ✓（双向） |
| **IDE 集成** | ✓ | | | ✓ | ✓ | | ✓ | ✓ | | | | ✓ | ✓ | ✓ | |
| **CLI 优先** | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | | ✓ | ✓ | | | ✓ | ✓ | ✓ |
| **终端原生** | ✓ | ✓ | ✓ | | | ✓ | ✓ | | | ✓ | | | ✓ | ✓ | ✓ |
| **自主学习** | 部分 | | | | | | | | | | | 部分 | | | **✓ 完整闭环** |
| **跨会话搜索** | /resume | | | | | | | | | | | | | | **✓ FTS5 全文** |
| **多消息渠道** | | | | | | | | | | | | | | | **✓ 14 个** |

## 详细对比

### 模型支持

| Agent | Claude | GPT-4 | Gemini | 本地模型 | 说明 |
|------|--------|-------|--------|----------|------|
| Claude Code | ✓ | | | | 仅 Claude（Opus 4.7 默认 / Sonnet 4.x / Haiku 4.5；`xhigh` effort level）|
| Aider | ✓ | ✓ | | ✓ | 通过 Ollama |
| Copilot CLI | ✓ | ✓ | | | Claude Sonnet 4.5 默认，可选 GPT-5 |
| Cursor | ✓ | ✓ | ✓ | | 多提供商 |
| SWE-agent | ✓ | ✓ | | ✓ | 灵活 |
| Cline | ✓ | | | | 仅 Claude |
| Goose | ✓ | ✓ | ✓ | | 多提供商 |
| OpenCode | ✓ | ✓ | ✓ | | 100+ 提供商（models.dev 动态加载） |
| Continue | ✓ | ✓ | | ✓ | 灵活 |
| Warp | ✓ | ✓ | | | 多个 |
| Gemini CLI | | | ✓ | | 仅 Gemini |
| OpenHands | ✓ | ✓ | ✓ | ✓ | 灵活 |
| Qwen Code | ✓ | ✓ | ✓ | | 6+ 提供商（Qwen OAuth/DashScope/ModelScope/Anthropic/Google/自定义） |
| Kimi CLI | ✓ | ✓ | ✓ | | 6 种 provider type（Kimi/OpenAI Legacy/OpenAI Responses/Anthropic/Gemini/Vertex AI） |
| Hermes Agent | ✓ | ✓ | ✓ | | 200+ 提供商（Nous Portal / OpenRouter / z.ai / Kimi / MiniMax / OpenAI / 自定义） + Credential Pool 多 Key 轮换 |

### 架构与设计

| Agent | 语言 | 架构/定位 | 主要设计目标 |
|------|----------|--------------|-------------------|
| Claude Code | Rust | CLI Agent（工具调用） | 代理式编程工具 |
| Aider | Python | CLI Agent（编辑优先，Git 原生） | 结对编程 |
| Copilot CLI | TypeScript (Node.js SEA) | CLI Agent（工具调用，GitHub 集成） | 终端原生代理，GitHub 集成 |
| Cursor | TypeScript | IDE Agent（VS Code fork） | AI 原生编辑器 |
| SWE-agent | Python | CLI Agent（混合 ReAct，ACI） | 基准性能 |
| Cline | TypeScript | IDE Agent（VS Code 扩展） | 自主编码 |
| Goose | Rust | CLI Agent（工具调用，MCP 原生） | 模型灵活性 |
| OpenCode | TypeScript | CLI Agent（工具调用，多代理） | 多客户端 AI 平台（TUI + Web + 桌面） |
| Continue | TypeScript | IDE + CLI + CI/CD Agent | PR Checks + 语义索引 |
| Warp | Rust | 终端 Agent（GPU 渲染终端） | 现代终端 + AI |
| Gemini CLI | TypeScript | CLI Agent（工具调用，function calling） | Google 生态 |
| OpenHands | Python | CLI Agent（事件驱动，EventStream） | 完全自主 |
| Qwen Code | TypeScript | CLI Agent（工具调用，Gemini CLI 分叉） | 中文开发者生态 |
| Kimi CLI | Python | CLI Agent（工具调用，Wire 协议） | 双模式交互 + 多客户端（TUI + Web + IDE） |
| **Hermes Agent** | **Python（369K 行）** | **CLI + 14 消息渠道 Agent（闭环学习）** | **自我改进 AI 伴侣：跨 CLI / Telegram / Discord / Slack / 等 14 平台，冻结快照 memory + 自主 skill + 后台 review 子代理** |

### 核心功能对比

#### Git 集成

| Agent | 自动提交 | 分支管理 | PR 创建 | 说明 |
|------|-------------|-------------------|-------------|-------|
| Claude Code | ✓ | ✓ | ✓ | 强大的 Git 支持 |
| Aider | ✓ | ✓ | | **同类最佳** |
| Copilot CLI | | ✓ | ✓ | GitHub 专注 |
| Cursor | | ✓ | | IDE 内置 |
| SWE-agent | | | | 问题专注 |
| Cline | ✓ | ✓ | | 良好支持 |
| Goose | | | | 基础 |
| OpenCode | | ✓ | | Git snapshot review + worktree 隔离 |
| Continue | | | ✓ | CI/CD 专注 |
| Warp | | ✓ | | 终端内置 |
| Gemini CLI | | | | 通过 bash 工具 |
| Qwen Code | | | | 通过 bash 工具 |
| Kimi CLI | | | | 通过 bash 工具 |

#### 上下文管理

| Agent | 最大上下文 | 仓库映射 | 压缩 | 说明 |
|------|-------------|----------|------|-------|
| Claude Code | 100 万 token | | ✓ | 最大上下文 |
| Aider | 20 万 token | ✓ | | 优秀的映射 |
| Copilot CLI | ~12.8 万 token | | | 标准 |
| Cursor | ~20 万 token | | | 多模型 |
| SWE-agent | 可变 | ✓ | | 研究专注 |
| Cline | ~20 万 token | | ✓ | 良好上下文 |
| OpenCode | 可变 | | ✓ | 会话 auto-compact + 可配置 compaction hook |
| Gemini CLI | ~100 万 token | | | Gemini 原生 |
| OpenHands | 可变 | | | 全项目 |
| Qwen Code | ~100 万 token | | ✓ | 聊天压缩服务 |
| Kimi CLI | ~25.6 万 token | | ✓ | 自动压缩（85% 触发比例），可配置保留空间 |
| Hermes Agent | 可变（依赖模型） | | ✓ | **冻结快照 Memory + FTS5 跨会话搜索 + Gemini Flash 摘要保护主 context** |

#### 执行与安全

| Agent | 沙箱 | 权限系统 | 试运行 | 说明 |
|------|---------|-------------|---------|-------|
| Claude Code | ✓ | ✓ | ✓ | 精细权限 |
| Aider | | ✓ | | 透明 |
| Copilot CLI | | ✓ | | 操作需确认，企业合规 |
| Cursor | | ✓ | | IDE 内权限 |
| SWE-agent | ✓ | | | Docker |
| Cline | ✓ | ✓ | | 基于权限 |
| OpenCode | | ✓ | | Tree-sitter AST 分析 + Doom Loop 保护 + 文件时间锁 + Worktree 隔离 |
| Gemini CLI | | ✓ | | 基于权限 |
| OpenHands | ✓ | | ✓ | Docker 隔离 |
| Qwen Code | ✓ | ✓ | | deny>ask>allow + Hook |
| Kimi CLI | | ✓ | | YOLO / 会话级审批 / 逐次确认 + feedback |

### 多模态能力

| Agent | 图片输入 | 截图分析 | PDF | 说明 |
|------|----------|----------|-----|------|
| Claude Code | ✓ | ✓ | ✓ | 原生多模态（通过 Read 工具） |
| Aider | ✓ | | | 通过 --image 参数 |
| Copilot CLI | | | | 暂不支持 |
| Cursor | ✓ | ✓ | | 拖拽图片到 Chat |
| SWE-agent | | | | 不支持 |
| Cline | ✓ | ✓ | | 拖拽图片 |
| Goose | ✓ | | | 取决于模型 |
| OpenCode | | | | 不支持 |
| Continue | ✓ | | | 多模态模型支持 |
| Warp | | | | 不支持 |
| Gemini CLI | ✓ | ✓ | | Gemini 原生多模态 |
| OpenHands | ✓ | ✓ | | 浏览器截图 |
| Qwen Code | ✓ | | | 通义千问多模态 |
| Kimi CLI | | | | 暂不支持 |

### 平台支持

| Agent | macOS | Linux | Windows | 说明 |
|------|-------|-------|---------|------|
| Claude Code | ✓ | ✓ | WSL | 原生 macOS/Linux |
| Aider | ✓ | ✓ | ✓ | Python 跨平台 |
| Copilot CLI | ✓ | ✓ | ✓ | 全平台原生 |
| Cursor | ✓ | ✓ | ✓ | Electron 跨平台 |
| SWE-agent | ✓ | ✓ | Docker | 需要 Docker |
| Cline | ✓ | ✓ | ✓ | VS Code 扩展 |
| Goose | ✓ | ✓ | WSL | Rust 原生 |
| OpenCode | ✓ | ✓ | ✓ | 多客户端跨平台 |
| Continue | ✓ | ✓ | ✓ | VS Code/JetBrains |
| Warp | ✓ | ✓ | 预览版 | 终端应用 |
| Gemini CLI | ✓ | ✓ | ✓ | Node.js 跨平台 |
| OpenHands | ✓ | ✓ | Docker | Docker 部署 |
| Qwen Code | ✓ | ✓ | ✓ | Node.js 跨平台 |
| Kimi CLI | ✓ | ✓ | WSL | Python 原生 |

### 断点恢复能力

| Agent | 会话恢复 | 检查点 | 撤销/回退 | 说明 |
|------|----------|--------|-----------|------|
| Claude Code | ✓ | ✓ | ✓ | 会话恢复 + worktree |
| Aider | | | ✓ | Git undo (/undo) |
| Copilot CLI | | | | 基础会话 |
| Cursor | | | ✓ | IDE 撤销 |
| SWE-agent | | ✓ | | Docker 快照 |
| Cline | ✓ | ✓ | ✓ | Git Checkpoint |
| Goose | ✓ | | | 会话保存 |
| OpenCode | ✓ | ✓ | ✓ | Git snapshot + worktree |
| Continue | | | | VS Code 撤销 |
| Warp | | | | 无 |
| Gemini CLI | ✓ | ✓ | ✓ | 会话恢复 + rewind |
| OpenHands | ✓ | ✓ | | Docker 检查点 |
| Qwen Code | ✓ | ✓ | ✓ | 会话恢复 + **PR#3739 transcript-first fork resume**（比 Claude Code 更稳健：转抄优先 / `system/agent_bootstrap` + `system/agent_launch_prompt` 重放 / paused 生命周期）+ **PR#3539 `/branch` (`/fork` alias)**（2026-05-08 MERGED · slash 命令 fork session 创建分支副本 · JSONL 完整复制 + `forkedFrom` stamp · 原子 `fs.openSync 'wx'` 创建 · rollback-safe swap）|
| Kimi CLI | ✓ | | | 会话保存 |

### 输入队列与预测

> 详见 [输入队列与中断机制 Deep-Dive](./input-queue-deep-dive.md)

| 能力 | Claude Code | Gemini CLI | Qwen Code | Copilot CLI | Aider | Codex CLI | Kimi CLI | OpenCode | Goose |
|------|------------|-----------|-----------|-------------|-------|-----------|----------|----------|-------|
| **执行中可输入** | ✓ | ✓ | ✓ | | | | | | |
| **输入队列** | 优先级队列（3 级） | FIFO | FIFO | — | — | — | — | — | — |
| **Mid-Turn Queue Drain** | ✓ | | | | | | | | |
| **Prompt Suggestion** | ✓ | | ✓ | | | | | | |
| **Speculation 预执行** | ✓（ant-only） | | ✓（opt-in） | | | | | | |
| **队列可视化** | ✓ | | | | | | | | |
| **工具级中断** | ✓ | | | | | | | | |
| **Early Input** | ✓ | | | | | | | | |

**关键发现：**
- **Claude Code** 是唯一实现 Mid-Turn Queue Drain 的 Agent——用户输入在当前 turn 的下一个 step 即可被模型看到，无需等整个 turn 结束
- **Qwen Code** v0.15.0 新增 Prompt Suggestion + Speculation（与 Claude Code 架构高度相似），但 Speculation 默认关闭
- **Gemini CLI / Qwen Code** 支持执行中排队输入，但仅在整个 round 完成后处理（Between-Round Drain）
- 其他 Agent（Copilot CLI、Aider、Codex CLI 等）在 Agent 执行期间输入框不可用，需等待 turn 完成

### 成本参考（单次典型任务）

> 以下为估算值，实际成本取决于任务复杂度和 token 用量

| Agent | 定价模式 | 简单任务 | 复杂任务 | 说明 |
|------|----------|----------|----------|------|
| Claude Code | API 按量 / 订阅 | ~$0.05-0.20 | ~$1-5 | Max 订阅 $100/月 或 API |
| Aider | API 按量 | ~$0.02-0.10 | ~$0.50-3 | 取决于所选模型 |
| Copilot CLI | 订阅制 | 1 premium request | 1 premium request | Copilot 订阅含配额 |
| Cursor | 订阅制 | 1 fast request | 多个 request | Pro $20/月 500 次 |
| Goose | API 按量 | ~$0.02-0.10 | ~$0.50-3 | 多提供商 |
| Gemini CLI | API 按量/免费 | 免费 | ~$0.10-1 | 1500 次/天免费层 |
| OpenHands | API 按量 | ~$0.05-0.20 | ~$2-10 | 多代理消耗更高 |
| Qwen Code | 免费/API | 免费 | 免费 | 每日 1000 次 |
| Kimi CLI | API 按量 | ~$0.01-0.05 | ~$0.20-1 | 国内模型成本低 |

### 内置命令能力对比

> 对比各工具的交互式斜杠命令/内置命令体系。Cline（VS Code 扩展）和 Warp（终端应用）使用 GUI 交互而非斜杠命令。

| 能力 | Claude Code | Aider | Gemini CLI | Kimi CLI | Qwen Code | Copilot CLI | Codex CLI | Goose | OpenCode |
|------|-------------|-------|-----------|----------|-----------|-------------|-----------|-------|---------|
| **命令总数** | ~86（含 Skill · v2.1.132 加 `/ultrareview` `/ultraplan` `/autofix-pr` `/usage` `/team-onboarding` `/theme`）| ~42 | ~39 | ~28 | **52（v0.15.9，含 `/branch` `/fork` PR#3539 ✓ 2026-05-08）** | 34 | 28 | 16（斜杠）+ 15（CLI） | 23（TUI） |
| **代码审查** | `/review` 插件 | — | `/code-review`（扩展） | — | `/review`（Skill，4 代理并行） | `/review` | `@codex review` | — | — |
| **模式切换** | — | `/code` `/architect` `/ask` | `/plan` | `/plan` `/yolo` | `/plan` | — | `--ask-for-approval` | — | `--agent` |
| **模型切换** | `/model` | `/model` `/editor-model` `/weak-model` | `/model` | `/model` | `/model` | `/model` | `--model` | `--model` | — |
| **上下文压缩** | `/compact` | `/clear` `/reset` | `/compress` | `/compact` | `/compact` | `/compact` | `/compact` | `/compact` | — |
| **文件管理** | 自动 | `/add` `/drop` `/read-only` `/ls` | 自动 | `/add-dir` | 自动 | 自动 | 自动 | 自动 | 自动 |
| **Git 操作** | 内置工具 | `/commit` `/undo` `/diff` `/git` | 内置工具 | — | 内置工具 | 内置 GitHub MCP | — | — | 内置工具 |
| **仓库地图** | — | `/map` `/map-refresh` | — | — | — | — | — | — | — |
| **MCP 状态** | `/mcp` | — | `/mcp` | `/mcp` | `/mcp` | — | — | — | `mcp list` |
| **权限管理** | `/permissions` | — | `/permissions` `/policies` | — | `/permissions` | — | — | — | — |
| **记忆系统** | `/memory` | — | `/memory` | — | `/memory` | — | — | — | — |
| **会话恢复** | `--resume` | — | `/restore` `/resume` `/rewind` | `/sessions` `/resume` | `/restore` `/resume` `/rewind` | — | — | — | `session list` |
| **语音输入** | 内置 Voice | `/voice` | — | — | — | — | — | — | — |
| **远程控制** | `/remote-control` | — | — | — | — | — | — | — | — |
| **Web 抓取** | WebFetch 工具 | `/web` | — | `/web` | — | — | — | — | — |
| **LSP 集成** | — | — | — | — | — | `/lsp` | — | — | — |
| **费用查看** | `/cost` | `/tokens` | `/stats` | — | `/stats` | — | — | — | `stats` |
| **反馈报告** | `/bug` | `/report` | `/bug` | `/feedback` | `/bug` | `/feedback` | — | — | — |
| **Vim 模式** | `/vim` | — | `/vim` | — | `/vim` | — | — | — | — |

**关键发现：**
- **Claude Code** 命令数 ~86（v2.1.132），独有 `/review`（代码审查）`/remote-control`（远程控制）`/ultrareview`（云端 fleet 评审）`/ultraplan`（云端 plan 协作）`/autofix-pr`（PR auto-fix）
- **Qwen Code** 52 命令（v0.15.9）+ **`/branch` `/fork`**（PR#3539 ✓ 2026-05-08 · session fork 分支）+ `/resume` 搜索增强（PR#3880 ✓ 2026-05-08 · free-text + j/k preview + Ctrl+B branch toggle），原有 `/tasks`（PR#3642 background tasks 调度入口）+ Arena / 语言 / 洞察 / 扩展独有命令
- **Aider** ~42 命令，文件/上下文管理和模式切换最细粒度
- **Gemini CLI / Qwen Code / Kimi CLI** 命令体系接近（Gemini CLI 分叉谱系）
- **Copilot CLI** 34 命令 + 67 工具 + 3 内置代理，GitHub 生态深度集成
- **Codex CLI** 28 交互命令（官方文档验证）+ 15 CLI 子命令 + Rust 原生沙箱
- **OpenCode** 使用 Ctrl+K 命令面板 + 23 个 TUI 斜杠命令
- **Goose** 16 个交互式斜杠命令 + 15 个 CLI 命令（clap derive），MCP 原生架构
- **Qoder CLI** 19+ 交互命令 + 7 CLI 子命令 + Go 原生 43MB + Quest 模式 + Claude Code 兼容（`--with-claude-config`）

### 后台任务与多 Agent 协调

> 详见 [SubAgent 展示 Deep-Dive](./subagent-display-deep-dive.md)。本节反映 2026-05-07 状态。

| 能力 | Claude Code | Qwen Code | OpenCode | 其他 |
|------|-------------|-----------|----------|------|
| **后台任务 always-on panel** | **输入框 footer 下方**常驻 `CoordinatorAgentStatus`（源码注释 "Renders below the prompt input footer"，1 行/agent，elapsed 计时）| 🌟 **`LiveAgentPanel`**（PR#3909，2026-05-07，**直接 port Claude 模式**——同样输入框 footer 下方 · 1 行/agent · 视觉规范 `○ ✔ ▶ name: desc (activity)` 逐字 port · 右列 pin elapsed + tokens）| 无 | 大多无 |
| **on-demand detail UI** | 无（单层）| **`BackgroundTasksDialog`**（PR#3488 起 · Down 键打开 · detail / cancel / resume）—— **比 Claude 多一层** | 无 | — |
| **任务 kind 框架** | `LocalAgentTask`（agent only）| **4 kinds：agent / shell / monitor / dream** 通用 framework | 无 | 大多无 |
| **统一调度面** | agent / shell 分离 UI | **统一 BackgroundTasksDialog**（PR#3720）—— 超越 Claude | 无 | — |
| **状态分类** | 4 状态（running/completed/failed/canceled · **UI 仅显式 running 与 completed，success/failure 隐式**）| **4 类显式**（Running/Completed/Failed/Cancelled · 4 类直接显示 · `x` 键路由）—— **比 Claude 显式** | — | — |
| **TTL 自动驱逐** | ✓ 30s 已完成自动消失 | ✗ 保持可见，用户主动 `x` 取消（PR#3488 设计差异）| — | — |
| **foreground subagent UI** | inline 渲染（v2.1.81 起未变）| **inline → 抑制（PR#3768）→ LiveAgentPanel 取代（PR#3909）** | — | — |
| **subagent context overflow 防御** | 主 agent compaction | **subagent 也共享主 agent compaction trigger**（PR#3735，long-running Explore 不再 400）| — | — |
| **Subagent Config 隔离** | tool registry 共享 parent | **`Object.create` 重建 tool registry**（PR#3873 + PR#3887 foreground-fork path 收尾，subagent 工具走自己 FileReadCache + approval mode）| — | — |
| **云端 fleet 多 Agent** | ✨ **Ultrareview**（v2.1.132 Week 17，云端 fleet 并行 review agents → CLI/Desktop）| 无（本地 only · 设计参考 [Qwen daemon §06 §七](./qwen-code-daemon-design/06-roadmap.md)）| 无 | — |
| **跨设备协作 plan** | ✨ **Ultraplan**（v2.1.132 Week 15，本地 plan + 云端 web 评审 + 远程或本地执行）| 无 | 无 | — |
| **Permission classifier** | ✨ **Auto Mode**（v2.1.132 Week 13，介于 manual / `--dangerously-skip-permissions` 之间）| 4 mode permission flow（PR#3723）| — | — |
| **Computer Use（GUI 自动化）**| ✨ Week 14，CLI 内打开 app + 点击 + 视觉验证 | 无 | 无 | — |
| **AI commit attribution（git notes 元数据）**| 无 | 🌟 **PR#3115 ✓ 2026-05-08 独家**：EditTool/WriteFileTool 记 `recordEdit(oldContent, newContent)` → ShellTool 检测 git commit → `git notes --ref=refs/notes/ai-attribution add -m '<json>' HEAD` 写入 `{aiChars, humanChars, per-file}`，**不污染 commit message** + per-file 字符级跟踪。用例：OSS 披露要求 / 企业合规审计 | 无 | 无（4 方独家）|

> **设计收敛事件**：PR#3909（2026-05-07）是文档系列追踪期间**首次出现 Qwen 主动对齐 Claude 设计**——之前 PR#3488/3720/3739 都是差异化或反超 Claude，这次反向 port `CoordinatorTaskPanel` 模式。理由：PR#3768（4 月）抑制 inline AgentExecutionDisplay 闪烁后，live phase 完全不可见——直接 port Claude pattern 比保留差异化更优。Qwen 现在是 **LiveAgentPanel（always-on glance）+ BackgroundTasksDialog（按需 detail）双层 UI**，比 Claude 单层 Coordinator panel 更精细。详见 [§六.10](./subagent-display-deep-dive.md#已落地-10liveagentpanel-port-claude-coordinatortaskpanel-模式pr3909)。

## 使用场景推荐

### 最适合复杂重构
1. **Claude Code** - 卓越的推理、大上下文
2. **SWE-agent** - 基准验证
3. **Aider** - Git 纪律

### 最适合快速编辑
1. **Copilot CLI** - 终端原生代理
2. **Gemini CLI** - 轻量级
3. **Aider** - 专注编辑

### 最适合 Git 工作流
1. **Aider** - Git 原生设计
2. **Claude Code** - 强大的 Git 集成
3. **Copilot CLI** - GitHub 生态

### 最适合学习
1. **mini-swe-agent** - 100 行参考
2. **SWE-agent** - 学术方法
3. **Aider** - 透明操作

### 最适合隐私
1. **TabbyML** - 自托管
2. **OpenHands** - Docker 隔离
3. **Aider** - 本地模型支持

### 最适合团队
1. **Claude Code** - 企业功能
2. **Copilot CLI** - GitHub 集成
3. **Continue** - CI/CD 集成

### 最适合中文开发者
1. **Qwen Code** - 每日 1000 次免费，阿里云生态
2. **Kimi CLI** - 双模式交互，Ctrl-X 快捷键，多提供商
3. **Claude Code** - 中文理解能力强

## 性能总结

| Agent | SWE-bench | 速度 | 复杂性 | 说明 |
|------|-----------|-------|------------|-------|
| Claude Code | ~60% | 中等 | 高 | 最佳推理 |
| Cursor | N/A | 快 | 中等 | IDE 集成 |
| Aider | ~45% | 快 | 低 | 良好平衡 |
| Copilot CLI | N/A | 快 | 中等 | 终端代理 |
| SWE-agent | 74% | 慢 | 高 | 基准之王 |
| Cline | ~40% | 中等 | 中等 | IDE 原生 |
| OpenHands | ~55% | 慢 | 很高 | 完全自主 |
| Qwen Code | N/A | 快 | 低 | 免费额度高 |
| Kimi CLI | N/A | 中等 | 中等 | 双模式 + 子代理 + 插件 |
