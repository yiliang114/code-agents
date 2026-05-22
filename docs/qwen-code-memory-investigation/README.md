# Qwen Code Memory Investigation

这组文档是 Qwen Code 内存问题排查过程中的脱敏资料归档，便于后续复盘和继续测试。

## 阅读顺序

1. [Runtime diagnostics benchmark report](reports/2026-05-19-qwen-runtime-diagnostics-benchmark-report.md)
   - 主要覆盖 runtime 耗时、RSS 分布、token / tool call 分布、MCP 对 process-tree RSS 的影响。
2. [OOM reproduction report](reports/2026-05-19-oom-reproduction-report.md)
   - 主要覆盖长任务 OOM 复现、`structuredClone()` 峰值、默认 heap replay、版本归因。
3. [Auto-compaction threshold redesign](auto-compaction-threshold-redesign.md)
   - 主要覆盖自动压缩阈值、hard / auto / warn 分层、compression side-query 输出预算等架构方向。
4. [Multi-model OOM regression test](reports/2026-05-20-multi-model-oom-regression-test.md)
   - 主要覆盖不同模型下 OOM 回归测试结果。
5. [Multi-model PR review benchmark](reports/2026-05-20-multi-model-pr-review-benchmark.md)
   - 主要覆盖不同模型执行 PR review case 的耗时、token、内存表现。

## 复现脚本

- [memory-pressure-repro.mjs](scripts/memory-pressure-repro.mjs)
- [memory-pressure-repro.test.js](scripts/memory-pressure-repro.test.js)

示例：

```bash
node --max-old-space-size=256 docs/qwen-code-memory-investigation/scripts/memory-pressure-repro.mjs \
  --turns=12 \
  --tool-result-kib=256 \
  --subagents=2 \
  --subagent-turns=12 \
  --clone-count=2 \
  --mode=clone
```

## 脱敏说明

已检查并移除或避免写入本地用户路径、debug session id、API key、Authorization header、全局配置目录中的私有路径等信息。报告中保留的模型名、PR 编号、issue/PR 链接、RSS/token/tool-call 聚合数值用于技术复盘。
