# Code Agents

Code Agent 相关的技术分析和研究文档。

## 架构设计

- [记忆系统（Memory）架构设计](docs/memory-system/README.md) — 跨会话记忆的存储模型、四种类型、Extract/Recall/Dream/Forget 数据流、Worktree 感知与设计经验
- [配置系统设计](docs/settings-and-config/README.md) — 配置层次与优先级、内存/压缩/Telemetry/Auth 相关配置、Hooks 系统、与 OOM 的关系
- [压缩机制对比分析](docs/compaction/README.md) — Claude Code vs Qwen Code 的上下文压缩策略、缓存影响与优化方向

## 运维与排查

- [Telemetry 使用指南](docs/telemetry/README.md) — Code Agent 场景下 OpenTelemetry 的配置、敏感字段管控与生产架构建议
- [Qwen Code 内存排查资料](docs/qwen-code-memory-investigation/README.md) — Runtime diagnostics、MCP 影响、长任务 OOM、自动压缩架构与复现脚本
- [Qwen Code Provider 行为差异](docs/qwen-code-provider-behavior/README.md) — OpenAI-compatible provider 的识别顺序、请求改写、缓存与 DataWorks/DashScope 域名处理
